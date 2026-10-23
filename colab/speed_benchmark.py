# %% [markdown]
# # 속도 비교: 이 파이프라인 vs. HoVer 공식 베이스라인 (Colab GPU)
#
# 같은 GPU에서 dev claim `N_BENCH`개를 **하나씩**(배치 1) 처리하며 단계별 지연 시간을 잽니다.
#
# - **이 파이프라인**: 검색 노트북(`colab/hover_retrieval.py`) 코드를 저장소에서 불러와 그대로 실행하고,
#   학습한 cross-encoder·검증 모델은 Drive `hover_bundle/models/<RETRIEVAL_TAG>/`에서 불러옵니다.
# - **HoVer 공식 베이스라인 재현** (속도 측정용): TF-IDF(단어+두 단어 묶음, log TF × IDF, DrQA 방식) 상위 100개
#   → BERT-base로 상위 20개 재순위 → 상위 5개 문서의 문장(문서당 최대 7개)을 BERT-base로 점수 → BERT-base 검증.
#   재순위·문장 선택 BERT는 학습된 가중치가 없지만 계산량은 같아서 시간 측정에는 영향이 없습니다.
#   공식 코드가 실행 중 하는 Stanford CoreNLP 문장 분리는 재현하지 않아, 공식 쪽 시간은 실제보다 짧게 나옵니다.
#
# 한 번만 드는 준비 비용(이 파이프라인: 제목·첫 문단 임베딩, 공식: TF-IDF 인덱스)도 따로 잽니다.
# 필요: Drive `hover_bundle/`의 번들 파일과 `sents.jsonl.gz`, 근거·검증 노트북이 학습한 모델. 런타임 → GPU(L4).

# %%
# ---- 설정 ----
BUNDLE = "/content/drive/MyDrive/hover_bundle"
RETRIEVAL_TAG = "B20_M5_d3_both_in3d0_floor0.7"   # 학습된 모델을 불러올 검색 설정
N_BENCH = 300        # 시간을 잴 dev claim 수
WARMUP = 10          # 앞쪽 몇 개는 GPU 예열용으로 측정에서 제외
REPO = "https://github.com/poohgajoah/hover-wiki-graph.git"
TRF_WHEEL = "https://github.com/explosion/spacy-models/releases/download/en_core_web_trf-3.8.0/en_core_web_trf-3.8.0-py3-none-any.whl"

# %%
from google.colab import drive
drive.mount("/content/drive")
!pip -q install {TRF_WHEEL}
!rm -rf /content/hover-wiki-graph && git clone -q --depth 1 {REPO} /content/hover-wiki-graph

# %%
# ---- 검색 노트북 코드 실행 (데이터·그래프·임베딩·NER·탐색 함수 준비) ----
import re
import time

REPO_DIR = "/content/hover-wiki-graph"
src = open(f"{REPO_DIR}/colab/hover_retrieval.py", encoding="utf-8").read()
cells = [c for c in re.split(r"^# %%.*$", src, flags=re.M) if c.strip()]
SKIP = ("from google.colab import drive", "# ---- evaluation", "# ---- save per-claim")
prep_seconds = {}
for cell in cells:
    body = cell.strip()
    if body.startswith("#") and all(l.startswith("#") or not l.strip() for l in body.splitlines()):
        continue                                   # markdown cell
    if any(s in body for s in SKIP):
        continue
    t0 = time.perf_counter()
    res = get_ipython().run_cell(body)
    if res.error_before_exec or res.error_in_exec:
        raise RuntimeError(f"retrieval cell failed: {body.splitlines()[0]}")
    if body.startswith("# ---- configuration"):
        SPLIT, LIMIT, CACHE = "dev", N_BENCH, None  # 벤치마크용 덮어쓰기
    if body.startswith("# ---- embeddings"):
        prep_seconds["ours: title + intro embeddings"] = time.perf_counter() - t0
print("retrieval code ready:", len(claims), "claims")

# %%
# ---- 공통 준비: 문장 리스트, 학습된 모델 ----
import gzip
import json
import sys

import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

sys.path.insert(0, f"{REPO_DIR}/retrieval")
from common import sentence_input            # noqa: E402
from verifier import encode as ver_encode    # noqa: E402

SENT_LISTS = [None] * N
with gzip.open(SENTS, "rt", encoding="utf-8", newline="\n") as f:
    for line in f:
        i, _t, s = json.loads(line)
        SENT_LISTS[i] = s

MODEL_DIR = f"{BUNDLE}/models/{RETRIEVAL_TAG}"
ce_tok = AutoTokenizer.from_pretrained(f"{MODEL_DIR}/sentence_selector")
ce = AutoModelForSequenceClassification.from_pretrained(f"{MODEL_DIR}/sentence_selector").to(DEV).eval()
ver_tok = AutoTokenizer.from_pretrained(f"{MODEL_DIR}/verifier")
ver = AutoModelForSequenceClassification.from_pretrained(f"{MODEL_DIR}/verifier").to(DEV).eval()
bench_claims = [c["claim"] for c in claims[:N_BENCH]]


def sync():
    if DEV == "cuda":
        torch.cuda.synchronize()


@torch.no_grad()
def verify(claim, evidence_texts):
    enc = ver_encode(ver_tok, [claim], [" ".join(t.strip() for t in evidence_texts)], 200, 60)
    return ver(**{k: v.to(DEV) for k, v in enc.items()}).logits.softmax(-1)[0, 1].item()

# %%
# ---- 이 파이프라인: claim 하나씩 ----
@torch.no_grad()
def ours(claim):
    global claims, claim_vecs, seeds               # best_first()가 읽는 전역을 이 claim 하나로 바꿈
    t, t0 = {}, time.perf_counter()
    doc = nlp(claim)
    ents = [e for e in doc.ents if e.label_ not in DROP]
    covered = {j for e in ents for j in range(e.start, e.end)}
    mentions = [e.text for e in ents] + ngram_mentions(doc, covered)
    sync(); t["1 entities / n-grams"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    cvec = encode([claim])[0]
    seed_map, fb = {}, []
    for m in mentions:
        d, how = resolve_dictionary(m, cvec)
        if d is not None:
            seed_map.setdefault(d, (m, how))
        else:
            fb.append(m)
    if fb:
        val, idx = (TE @ encode(fb).T).max(dim=0)
        for m, v, i in zip(fb, val.tolist(), idx.tolist()):
            if v >= SIM_FLOOR:
                seed_map.setdefault(i, (m, "emb"))
    sync(); t["2 start docs"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    claims, claim_vecs, seeds = [{"claim": claim}], cvec[None], [seed_map]
    opened = best_first(0)
    sync(); t["3 candidate docs"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    cands = [(d, i, s) for d in opened for i, s in enumerate(SENT_LISTS[d]) if s.strip()]
    evidence = []
    if cands:
        enc = ce_tok([claim] * len(cands), [sentence_input(titles[d], s) for d, _, s in cands],
                     truncation=True, max_length=128, padding=True, return_tensors="pt").to(DEV)
        sc = ce(**enc).logits.squeeze(-1).float().tolist()
        per_doc = {}
        for (d, i, s), v in zip(cands, sc):
            per_doc.setdefault(d, []).append((v, s))
        kept = sorted((x for v in per_doc.values() for x in sorted(v, reverse=True)[:2]), reverse=True)[:5]
        evidence = [s for _, s in kept]
    sync(); t["4 evidence sentences"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    verify(claim, evidence)
    sync(); t["5 verification"] = time.perf_counter() - t0
    return t


def bench(fn):
    rows = []
    for k, c in enumerate(bench_claims):
        r = fn(c)
        if k >= WARMUP:
            rows.append(r)
    return rows


ours_rows = bench(ours)
print("ours done:", len(ours_rows), "claims timed")

# %%
# ---- HoVer 공식 베이스라인 재현: TF-IDF 인덱스 (한 번만) ----
import scipy.sparse as sp
from joblib import Parallel, delayed
from sklearn.feature_extraction.text import HashingVectorizer

HASH = 2 ** 24
hv = HashingVectorizer(ngram_range=(1, 2), n_features=HASH, alternate_sign=False, norm=None,
                       stop_words="english", dtype=np.float32)
t0 = time.perf_counter()
parts = Parallel(n_jobs=-1, batch_size=1)(delayed(hv.transform)(texts[s:s + 100_000]) for s in range(0, N, 100_000))
X = sp.vstack(parts).tocsr()
del parts
X.data = np.log1p(X.data)                                   # log TF
df = np.bincount(X.indices, minlength=HASH)
idf = np.log((N - df + 0.5) / (df + 0.5)).astype(np.float32)
idf[idf < 0] = 0
X = (X @ sp.diags(idf)).tocsc()                             # column = n-gram -> docs (inverted index)
prep_seconds["official: TF-IDF index"] = time.perf_counter() - t0
print(f"TF-IDF index: {X.shape}, nnz {X.nnz:,}, {prep_seconds['official: TF-IDF index']:.0f}s")

rr_tok = AutoTokenizer.from_pretrained("bert-base-uncased")
rr = AutoModelForSequenceClassification.from_pretrained("bert-base-uncased", num_labels=2).to(DEV).eval()  # 문서 재순위
ss = AutoModelForSequenceClassification.from_pretrained("bert-base-uncased", num_labels=2).to(DEV).eval()  # 문장 선택


def tfidf_topk(claim, k=100):
    q = hv.transform([claim])
    if not q.nnz:
        return np.arange(k)
    q.data = np.log1p(q.data) * idf[q.indices]
    scores = X[:, q.indices] @ q.data
    top = np.argpartition(-scores, k)[:k]
    return top[np.argsort(-scores[top])]


@torch.no_grad()
def official(claim):
    t, t0 = {}, time.perf_counter()
    top100 = tfidf_topk(claim)
    t["1 TF-IDF top-100"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    top20 = top100[:20].tolist()
    enc = rr_tok([claim] * 20, [texts[d] for d in top20], truncation="only_second", max_length=200,
                 padding=True, return_tensors="pt").to(DEV)
    order = rr(**enc).logits[:, 1].argsort(descending=True).tolist()
    top5 = [top20[i] for i in order[:5]]
    sync(); t["2 BERT rerank top-20"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    sents = [s for d in top5 for s in SENT_LISTS[d][:7] if s.strip()]
    evidence = []
    if sents:
        enc = rr_tok([claim] * len(sents), sents, truncation="only_second", max_length=200,
                     padding=True, return_tensors="pt").to(DEV)
        p = ss(**enc).logits.softmax(-1)[:, 1]
        evidence = [sents[i] for i in p.argsort(descending=True)[:5].tolist()]
    sync(); t["3 BERT sentence selection"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    verify(claim, evidence)
    sync(); t["4 verification"] = time.perf_counter() - t0
    return t


official_rows = bench(official)
print("official done:", len(official_rows), "claims timed")

# %%
# ---- 결과 ----
def summarize(rows):
    stages = list(rows[0])
    total = [sum(r.values()) for r in rows]
    out = {s: {"mean_ms": 1000 * float(np.mean([r[s] for r in rows])),
               "p50_ms": 1000 * float(np.median([r[s] for r in rows]))} for s in stages}
    out["total"] = {"mean_ms": 1000 * float(np.mean(total)), "p50_ms": 1000 * float(np.median(total)),
                    "p90_ms": 1000 * float(np.percentile(total, 90))}
    return out


summary = {"gpu": torch.cuda.get_device_name(0) if DEV == "cuda" else "cpu", "claims_timed": len(ours_rows),
           "ours": summarize(ours_rows), "official": summarize(official_rows),
           "prep_seconds": {k: round(v, 1) for k, v in prep_seconds.items()}}
for name in ("ours", "official"):
    print(f"\n## {name} (ms per claim, {summary['claims_timed']} claims, {summary['gpu']})")
    print("| stage | mean | p50 |")
    print("|---|---|---|")
    for s, v in summary[name].items():
        print(f"| {s} | {v['mean_ms']:.1f} | {v['p50_ms']:.1f} |")
print("\none-time preparation (s):", summary["prep_seconds"])
os.makedirs(f"{BUNDLE}/results", exist_ok=True)
with open(f"{BUNDLE}/results/speed_benchmark_{RETRIEVAL_TAG}.json", "w") as f:
    json.dump(summary, f, indent=2)
print("saved", f"{BUNDLE}/results/speed_benchmark_{RETRIEVAL_TAG}.json")
