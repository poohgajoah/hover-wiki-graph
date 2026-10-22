"""Build data/store/wiki.db from the HotpotQA abstracts dump and the intro-link graph.

docs(id, title, sents): id = node_id of data/graph/abstract/nodes.tsv, sents = JSON list of
intro sentences (same segmentation as HoVer supporting_facts sentence ids).
links(src, tgt): deduplicated intro-paragraph links between doc ids.
"""
import bz2
import json
import re
import sqlite3
import sys
from pathlib import Path

from tqdm import tqdm

from common import DATA, DB_PATH, STORE

ABSTRACTS = DATA / "raw" / "abstracts"
# same sanitising as the graph build (tab, newline, CR, U+2028, U+2029, NEL, VT, FF)
BREAKS = re.compile("[\t\n\r" + "".join(map(chr, (0x2028, 0x2029, 0x85, 0x0B, 0x0C))) + "]")
GRAPH = DATA / "graph" / "abstract"


def main():
    STORE.mkdir(parents=True, exist_ok=True)
    tmp = DB_PATH.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript("""
        PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
        CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT NOT NULL, sents TEXT NOT NULL);
        CREATE TABLE links (src INTEGER NOT NULL, tgt INTEGER NOT NULL, PRIMARY KEY (src, tgt)) WITHOUT ROWID;
    """)

    # node ids from the graph build (titles there have line separators replaced by spaces)
    id_of = {}
    with open(GRAPH / "nodes.tsv", encoding="utf-8", newline="\n") as f:
        for line in f:
            nid, title, _wid, _n = line.rstrip("\n").split("\t")
            id_of[title] = int(nid)
    print(f"nodes: {len(id_of)}", file=sys.stderr)

    shards = sorted(ABSTRACTS.rglob("wiki_*.bz2"))
    rows, missing = [], 0
    for shard in tqdm(shards, desc="docs"):
        with bz2.open(shard, "rt", encoding="utf-8") as f:
            for line in f:
                o = json.loads(line)
                nid = id_of.get(o["title"], id_of.get(BREAKS.sub(" ", o["title"])))
                if nid is None:
                    missing += 1
                    continue
                rows.append((nid, o["title"], json.dumps(o["text"], ensure_ascii=False)))
        if len(rows) > 200_000:
            con.executemany("INSERT INTO docs VALUES (?,?,?)", rows)
            rows.clear()
    con.executemany("INSERT INTO docs VALUES (?,?,?)", rows)
    print(f"docs missing node id: {missing}", file=sys.stderr)

    batch, n = [], 0
    with open(GRAPH / "edges.tsv", encoding="utf-8", newline="\n") as f:
        for line in tqdm(f, desc="links", total=23_014_264):
            src, _sent, tgt, _anchor = line.rstrip("\n").split("\t", 3)
            batch.append((id_of[src], id_of[tgt]))
            if len(batch) >= 500_000:
                con.executemany("INSERT OR IGNORE INTO links VALUES (?,?)", batch)
                n += len(batch)
                batch.clear()
    con.executemany("INSERT OR IGNORE INTO links VALUES (?,?)", batch)
    print("indexing", file=sys.stderr)
    con.executescript("""
        CREATE INDEX links_tgt ON links (tgt, src);
        CREATE INDEX docs_title ON docs (title);
    """)
    con.commit()
    stats = con.execute("SELECT (SELECT COUNT(*) FROM docs), (SELECT COUNT(*) FROM links)").fetchone()
    print(f"docs {stats[0]}, unique links {stats[1]}", file=sys.stderr)
    con.close()
    tmp.replace(DB_PATH)


if __name__ == "__main__":
    main()
