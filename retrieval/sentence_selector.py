"""Evidence sentence selection with a cross-encoder fine-tuned on HoVer.

train : fine-tune a cross-encoder on (claim, sentence) pairs from HoVer train.
        positives = supporting_facts sentences; negatives = other sentences of the gold docs
        plus sentences of retrieved non-gold docs (from the Colab results file) or, if that
        file is missing, of docs linked from the gold docs.
select: score every sentence of the retrieved docs, keep the top PER_DOC per doc, then the
        global top N by score -> evidence file for the verifier.

Usage:
  python sentence_selector.py train  [--retrieval data/results/train_....jsonl]
  python sentence_selector.py select --retrieval data/results/dev_....jsonl [--per-doc 2 --n 5]
"""
import argparse
import random
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader
from tqdm import tqdm
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

from common import MODELS, DocStore, load_hover, read_jsonl, sentence_input, set_seed, setup_torch, write_jsonl

BASE = "cross-encoder/ms-marco-MiniLM-L-6-v2"
OUT = MODELS / "sentence_selector"


def build_pairs(store, claims, retrieved, neg_gold, neg_other, rng):
    """(claim, sentence text, label) training pairs."""
    pairs = []
    for c in tqdm(claims, desc="pairs"):
        gold = {(t, i) for t, i in c["supporting_facts"]}
        gold_docs = {t for t, _ in gold}
        negs = []
        for t in gold_docs:
            for i, s in enumerate(store.sents(t)):
                if (t, i) in gold:
                    pairs.append((c["claim"], sentence_input(t, s), 1.0))
                else:
                    negs.append((t, s))
        pairs += [(c["claim"], sentence_input(t, s), 0.0) for t, s in rng.sample(negs, min(neg_gold, len(negs)))]
        if retrieved is not None:
            others = [t for t in retrieved.get(c["uid"], []) if t not in gold_docs]
        else:
            others = [t for g in gold_docs for t in store.neighbours(g) if t not in gold_docs]
        cand = [(t, s) for t in others for s in store.sents(t)]
        pairs += [(c["claim"], sentence_input(t, s), 0.0) for t, s in rng.sample(cand, min(neg_other, len(cand)))]
    return pairs


def train(args):
    set_seed(args.seed)
    device = setup_torch()
    store = DocStore()
    claims = load_hover("train")
    if args.limit:
        claims = claims[:args.limit]
    retrieved = None
    if args.retrieval:
        retrieved = {r["uid"]: r["opened"] for r in read_jsonl(args.retrieval)}
        print(f"hard negatives from {args.retrieval}")
    else:
        print("no retrieval file: hard negatives from docs linked to the gold docs")
    pairs = build_pairs(store, claims, retrieved, args.neg_gold, args.neg_other, random.Random(args.seed))
    print(f"{len(pairs)} pairs, {sum(p[2] for p in pairs):.0f} positive")

    tok = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForSequenceClassification.from_pretrained(args.base, num_labels=1).to(device)

    def collate(batch):
        enc = tok([b[0] for b in batch], [b[1] for b in batch], truncation=True,
                  max_length=args.max_len, padding=True, return_tensors="pt")
        enc["labels"] = torch.tensor([b[2] for b in batch])
        return enc

    loader = DataLoader(pairs, batch_size=args.batch_size, shuffle=True, collate_fn=collate)
    steps = len(loader) * args.epochs
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    sched = get_linear_schedule_with_warmup(opt, int(0.1 * steps), steps)
    loss_fn = torch.nn.BCEWithLogitsLoss()
    model.train()
    t0 = time.time()
    for epoch in range(args.epochs):
        bar = tqdm(loader, desc=f"epoch {epoch + 1}")
        for step, batch in enumerate(bar):
            labels = batch.pop("labels").to(device)
            logits = model(**{k: v.to(device) for k, v in batch.items()}).logits.squeeze(-1)
            loss = loss_fn(logits, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad()
            if step % 50 == 0:
                bar.set_postfix(loss=f"{loss.item():.4f}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out)
    tok.save_pretrained(out)
    print(f"saved {out} ({(time.time() - t0) / 60:.0f} min)")


@torch.no_grad()
def select(args):
    device = setup_torch()
    store = DocStore()
    tok = AutoTokenizer.from_pretrained(args.out)
    model = AutoModelForSequenceClassification.from_pretrained(args.out).to(device).eval()
    rows = read_jsonl(args.retrieval)
    if args.limit:
        rows = rows[:args.limit]
    out_rows = []
    for r in tqdm(rows, desc="select"):
        cands = [(t, i, s) for t in r["opened"] for i, s in enumerate(store.sents(t)) if s.strip()]
        scores = []
        for b in range(0, len(cands), args.batch_size):
            chunk = cands[b:b + args.batch_size]
            enc = tok([r["claim"]] * len(chunk), [sentence_input(t, s) for t, _, s in chunk],
                      truncation=True, max_length=args.max_len, padding=True, return_tensors="pt").to(device)
            scores += model(**enc).logits.squeeze(-1).float().tolist()
        per_doc = {}
        for (t, i, s), sc in zip(cands, scores):
            per_doc.setdefault(t, []).append((sc, t, i, s))
        kept = [x for v in per_doc.values() for x in sorted(v, reverse=True)[:args.per_doc]]
        kept = sorted(kept, reverse=True)[:args.n]
        out_rows.append({
            "uid": r["uid"], "claim": r["claim"], "label": r.get("label"), "num_hops": r.get("num_hops"),
            "evidence": [{"title": t, "sent_id": i, "text": s, "score": round(sc, 4)} for sc, t, i, s in kept],
        })
    dst = Path(args.output or Path(args.retrieval).with_name(
        Path(args.retrieval).stem + f".evidence_k{args.per_doc}_n{args.n}.jsonl"))
    write_jsonl(dst, out_rows)
    print(f"saved {dst}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["train", "select"])
    p.add_argument("--retrieval", help="Colab retrieval jsonl (train: hard negatives, select: input)")
    p.add_argument("--base", default=BASE)
    p.add_argument("--out", default=str(OUT), help="model directory")
    p.add_argument("--output", help="select: evidence jsonl path")
    p.add_argument("--per-doc", type=int, default=2)
    p.add_argument("--n", type=int, default=5)
    p.add_argument("--neg-gold", type=int, default=4, help="negatives per claim from gold docs")
    p.add_argument("--neg-other", type=int, default=4, help="negatives per claim from other docs")
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--lr", type=float, default=2e-5)
    p.add_argument("--max-len", type=int, default=128)
    p.add_argument("--limit", type=int)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()
    if args.mode == "select" and not args.retrieval:
        p.error("select needs --retrieval")
    (train if args.mode == "train" else select)(args)


if __name__ == "__main__":
    main()
