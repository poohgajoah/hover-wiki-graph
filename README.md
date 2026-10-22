# hover-wiki-graph

Wikipedia title link graphs at the 2017-10-01 snapshot used by
[HoVer](https://hover-nlp.github.io/) (and HotpotQA), plus analysis scripts for
HoVer claims.

Requires Python 3.11–3.12 managed by [uv](https://docs.astral.sh/uv/) (`uv sync`), plus `curl`, `bzip2`, `tar`.
Run every script with `uv run python ...`.

## Graphs

| Graph | Nodes | Edges | Source |
|---|---|---|---|
| Intro-paragraph links (HoVer retrieval corpus) | 5,233,329 | 23,014,264 link occurrences | HotpotQA `withlinks-abstracts` dump |
| Full-article links | 5,486,204 | 413,594,217 unique | `enwiki-20171001-pagelinks.sql.gz` |

Links are resolved through the 2017-10-01 redirect table (7,991,447 redirects).
File formats and rebuild commands: [docs/graph.md](docs/graph.md).
Data is not committed; rebuilding takes about an hour and ~25 GB of free disk at peak.

### Coverage of HoVer supporting documents (dev)

All 18,299 HoVer supporting-document titles are nodes in both graphs.

| | Intro graph | Full graph |
|---|---|---|
| 2-hop: the two docs are directly linked | 87.4% | 88.6% |
| 2-hop: link leaves from a supporting sentence | 80.3% | – |
| 3-hop: doc set connected | 65.4% | 68.7% |
| 4-hop: doc set connected | 37.2% | 47.2% |

## Scripts

`scripts/`
- `fetch_ranges.sh` — resumable parallel ranged download streamed to stdout
- `download_abstracts.sh` — HotpotQA abstracts dump download
- `extract_pages.py` — namespace-0 page/redirect table from a pages-articles XML dump
- `build_abstract_graph.py`, `build_full_graph.py` — graph builders
- `validate_graph.py` — HoVer supporting-document coverage report
- `title_utils.py` — title normalisation, HTML-entity handling, redirect resolution
- `make_colab_bundle.py` — packs nodes, links and HoVer json into `data/colab_bundle/` for Colab
- `jscompat.py` — JavaScript-compatible number/ordering/JSON formatting (the scripts were ported
  from Node.js and reproduce its output byte for byte)

`scripts/analysis/` (input: directory with `hover_{train,dev,test}_release_v1.1.json`)
- `dataset_stats.py <data_dir>` — label/hop distribution, supporting-fact and title statistics
- `claim_mutations.py <data_dir>` — how NOT_SUPPORTED claims differ from SUPPORTED siblings
- `claim_logic.py <data_dir> <split> [ex]` — rule-based logical-structure classes of claims
- `hop2_structure.py <data_dir> <split> [ex]` — finer structure classes for 2-hop claims

The analysis classifiers are regex heuristics; treat their percentages as approximate.

## Data

HoVer data: <https://hover-nlp.github.io/> (CC BY-SA 4.0). Wikipedia content is CC BY-SA.
