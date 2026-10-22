# Wikipedia title graphs (2017-10-01, the HoVer/HotpotQA snapshot)

## abstract/ — intro-paragraph link graph (HoVer retrieval corpus)
Source: HotpotQA `enwiki-20171001-pages-meta-current-withlinks-abstracts` (5,233,329 docs).
- `nodes.tsv`: `node_id  title  wiki_page_id  n_sentences`. Titles are in HotpotQA/HoVer form,
  i.e. HTML-escaped (`Sugar &amp; Spice`), so they match `supporting_facts` titles exactly.
- `edges.tsv`: `src_title  sent_idx  tgt_title  anchor_text`, one row per link occurrence
  (23,014,264 rows). `sent_idx` uses the same sentence segmentation as HoVer `supporting_facts`.
- Link targets are resolved by: exact match → first-letter case fix → 2017-10-01 redirects.
  Unresolvable targets (1.6%; mostly pages absent from the HotpotQA corpus such as `Croatia`)
  are listed in `unresolved_targets.tsv`.

## full/ — full-article link graph
Source: `enwiki-20171001-pagelinks.sql.gz` (archive.org, md5 df7d24fe92c5838a2b39a70097157b2c).
- `nodes.tsv`: `page_id  title` for 5,486,204 namespace-0 non-redirect articles.
  Titles are plain Wikipedia titles (`Sugar & Spice`); use `html_unescape` from
  `scripts/title_utils.py` to map HoVer titles onto them.
- `edges.tsv.gz`: `src_page_id  tgt_page_id`, sorted, deduplicated after redirect resolution
  (413,594,217 edges). Includes template/navbox links.

## pages_ns0_20171001.tsv
`page_id  title  redirect_target` for all 13,477,652 namespace-0 pages
(7,991,447 redirects), extracted from `enwiki-20171001-pages-articles.xml.bz2`.

## Rebuild
```
scripts/fetch_ranges.sh <xml url> <tmp> 256 4 | bzip2 -dc | uv run python scripts/extract_pages.py data/graph/pages_ns0_20171001.tsv
find data/raw/abstracts -name 'wiki_*.bz2' | sort | while read f; do bzip2 -dc "$f"; done \
  | uv run python scripts/build_abstract_graph.py data/graph/pages_ns0_20171001.tsv data/graph/abstract
# pagelinks dump was deleted after the build; re-fetch first:
# scripts/fetch_ranges.sh https://archive.org/download/enwiki-20171001/enwiki-20171001-pagelinks.sql.gz <tmp> > data/raw/enwiki-20171001-pagelinks.sql.gz
uv run python scripts/build_full_graph.py data/graph/pages_ns0_20171001.tsv data/raw/enwiki-20171001-pagelinks.sql.gz data/graph/full
uv run python scripts/validate_graph.py data data/graph/abstract data/graph/full
```
Results of the last validation run are in `validation.txt`.
