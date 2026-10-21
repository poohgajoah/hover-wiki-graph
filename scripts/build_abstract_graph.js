// Build the title link graph over the HotpotQA 2017-10-01 intro-paragraph corpus
// (the corpus HoVer retrieves from).
// stdin : concatenated JSON lines of the withlinks-abstracts dump
// argv  : pages_ns0_20171001.tsv (redirect table), output directory
// Output: nodes.tsv  (node_id, title, wiki_id, n_sents)
//         edges.tsv  (src_title, sent_idx, tgt_title, anchor)  -- one row per link occurrence
//         unresolved_targets.tsv (target, count), stats.json
const fs = require('fs');
const path = require('path');
const { loadRedirects, resolve, canonMap, readLines, htmlUnescape, BREAKS, BREAKS_NO_TAB } = require('./title_utils');

// --pass2-only: reuse nodes.tsv and edges.raw.tmp from an earlier pass 1.
const [pagesTsv, outDir, mode] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const rawPath = path.join(outDir, 'edges.raw.tmp');

async function pass1() {
  const nodes = fs.createWriteStream(path.join(outDir, 'nodes.tsv'));
  const raw = fs.createWriteStream(rawPath);
  const titles = new Set();
  let n = 0, links = 0, bad = 0;
  for await (const line of readLines(process.stdin)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    titles.add(o.title);
    const title = o.title.replace(BREAKS, ' ');
    if (!nodes.write(`${n}\t${title}\t${o.id}\t${o.text.length}\n`)) await new Promise(r => nodes.once('drain', r));
    n++;
    let buf = '';
    o.text_with_links.forEach((s, i) => {
      for (const m of s.matchAll(/<a href="([^"]*)">([\s\S]*?)<\/a>/g)) {
        let t;
        try { t = decodeURIComponent(m[1]); } catch { t = m[1]; }
        const anchor = htmlUnescape(m[2].replace(/<[^>]+>/g, '')).replace(BREAKS, ' ');
        buf += `${title}\t${i}\t${t.replace(BREAKS, ' ')}\t${anchor}\n`;
        links++;
      }
    });
    if (buf && !raw.write(buf)) await new Promise(r => raw.once('drain', r));
    if (n % 500000 === 0) console.error(`pass1: ${n} docs, ${links} links`);
  }
  await Promise.all([new Promise(r => nodes.end(r)), new Promise(r => raw.end(r))]);
  return { titles, n, links, bad };
}

async function pass2(titles, redirects) {
  const canon = canonMap(titles);
  titles.clear();
  const out = fs.createWriteStream(path.join(outDir, 'edges.tsv'));
  const unresolved = new Map();
  const st = { direct: 0, case_fixed: 0, via_redirect: 0, self_or_section: 0, empty: 0, unresolved: 0 };
  for await (const raw of readLines(rawPath)) {
    // older pass-1 output may still carry U+2028 etc. inside fields
    const [src, sent, rawTgt, anchor] = raw.replace(BREAKS_NO_TAB, ' ').split('\t');
    const r = resolve(rawTgt, canon, redirects);
    if (r.kind === 'empty') { st.empty++; continue; }
    if (r.kind === 'unresolved') { st.unresolved++; unresolved.set(r.title, (unresolved.get(r.title) || 0) + 1); continue; }
    if (r.title === src) { st.self_or_section++; continue; }
    st[r.kind]++;
    if (!out.write(`${src}\t${sent}\t${r.title}\t${anchor}\n`)) await new Promise(res => out.once('drain', res));
  }
  await new Promise(r => out.end(r));
  const top = [...unresolved.entries()].sort((a, b) => b[1] - a[1]);
  fs.writeFileSync(path.join(outDir, 'unresolved_targets.tsv'), top.map(([t, c]) => `${t}\t${c}`).join('\n') + '\n');
  fs.unlinkSync(rawPath);
  return st;
}

(async () => {
  const redirects = await loadRedirects(pagesTsv);
  console.error(`redirects loaded: ${redirects.size}`);
  let p1;
  if (mode === '--pass2-only') {
    p1 = { titles: new Set(), n: 0, links: 0, bad: 0 };
    for await (const l of readLines(path.join(outDir, 'nodes.tsv'))) { p1.titles.add(l.split('\t')[1]); p1.n++; }
    for await (const l of readLines(rawPath)) if (l) p1.links++;
  } else {
    p1 = await pass1();
  }
  console.error(`pass1 done: ${p1.n} docs, ${p1.links} links, ${p1.bad} bad lines`);
  const st = await pass2(p1.titles, redirects);
  const kept = st.direct + st.case_fixed + st.via_redirect;
  const stats = { docs: p1.n, bad_lines: p1.bad, raw_links: p1.links, kept_edges: kept, ...st };
  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(stats, null, 2));
  console.error(JSON.stringify(stats));
})();
