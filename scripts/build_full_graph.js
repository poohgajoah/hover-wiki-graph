// Build the full-article link graph of English Wikipedia as of 2017-10-01
// from the pagelinks SQL dump, resolving links through 2017-10-01 redirects.
// argv  : pages_ns0_20171001.tsv, enwiki-20171001-pagelinks.sql.gz, output directory
// Output: nodes.tsv     (page_id, title)  -- non-redirect namespace-0 articles
//         edges.tsv.gz  (src_page_id, tgt_page_id) sorted, deduplicated
//         unresolved_targets.tsv (title, count) top 100k, stats.json
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { normTitle, loadRedirects, readLines } = require('./title_utils');

const [pagesTsv, sqlGz, outDir] = process.argv.slice(2);
const NPART = 16;
const SHIFT = 2 ** 26;
fs.mkdirSync(outDir, { recursive: true });

// Parse one `INSERT INTO pagelinks VALUES (...),(...);` line.
function* tuples(line) {
  let p = line.indexOf('(');
  while (p >= 0 && p < line.length) {
    const c1 = line.indexOf(',', p);
    const from = +line.slice(p + 1, c1);
    const c2 = line.indexOf(',', c1 + 1);
    const ns = +line.slice(c1 + 1, c2);
    let i = c2 + 2, title = '';
    for (;;) {
      const ch = line[i];
      if (ch === '\\') {
        const e = line[i + 1];
        title += e === 'n' ? '\n' : e === 't' ? '\t' : e === '0' ? '\0' : e;
        i += 2;
      } else if (ch === "'") { i++; break; }
      else { title += ch; i++; }
    }
    const close = line.indexOf(')', i);
    const fromNs = +line.slice(i + 1, close);
    yield [from, ns, title, fromNs];
    p = line[close + 1] === ',' ? close + 2 : -1;
  }
}

(async () => {
  // Page table: articles get ids; redirects map title -> target title.
  const idOf = new Map();
  const nodes = fs.createWriteStream(path.join(outDir, 'nodes.tsv'));
  const redirects = await loadRedirects(pagesTsv, (id, title, target) => {
    if (!target) { idOf.set(title, +id); nodes.write(`${id}\t${title}\n`); }
  });
  await new Promise(r => nodes.end(r));
  console.error(`articles ${idOf.size}, redirects ${redirects.size}`);

  const resolveId = raw => {
    let t = normTitle(raw);
    if (!t) return -1;
    for (let hop = 0; hop < 6; hop++) {
      const id = idOf.get(t);
      if (id !== undefined) return id;
      const r = redirects.get(t);
      if (r === undefined) return -1;
      t = normTitle(r);
    }
    return -1;
  };
  // Sources that are redirects (or non-article pages) are skipped.
  const articleIds = new Set(idOf.values());

  // Pass 1: stream SQL, write binary (src,tgt) int32 pairs into NPART partitions by src.
  const parts = [...Array(NPART)].map((_, k) => fs.openSync(path.join(outDir, `part${k}.bin`), 'w'));
  const bufs = [...Array(NPART)].map(() => ({ b: Buffer.alloc(8 * 65536), n: 0 }));
  const flush = k => { fs.writeSync(parts[k], bufs[k].b, 0, bufs[k].n * 8); bufs[k].n = 0; };
  const st = { rows: 0, ns0_to_ns0: 0, src_not_article: 0, kept: 0, unresolved: 0, self: 0 };
  const unresolved = new Map();
  let cacheTitle = null, cacheId = -1;   // rows are grouped by target title
  for await (const line of readLines(fs.createReadStream(sqlGz).pipe(zlib.createGunzip()))) {
    if (!line.startsWith('INSERT INTO')) continue;
    for (const [from, ns, title, fromNs] of tuples(line)) {
      st.rows++;
      if (ns !== 0 || fromNs !== 0) continue;
      st.ns0_to_ns0++;
      if (!articleIds.has(from)) { st.src_not_article++; continue; }
      if (title !== cacheTitle) { cacheTitle = title; cacheId = resolveId(title); }
      if (cacheId < 0) {
        st.unresolved++;
        if (unresolved.size < 2000000 || unresolved.has(title)) unresolved.set(title, (unresolved.get(title) || 0) + 1);
        continue;
      }
      if (cacheId === from) { st.self++; continue; }
      if (from >= SHIFT || cacheId >= SHIFT) throw new Error(`page id overflow: ${from} -> ${cacheId}`);
      const k = from % NPART, B = bufs[k];
      B.b.writeInt32LE(from, B.n * 8); B.b.writeInt32LE(cacheId, B.n * 8 + 4);
      if (++B.n === 65536) flush(k);
      st.kept++;
    }
    if (st.rows % 50000000 < 20000) console.error(`rows ${st.rows}, kept ${st.kept}`);
  }
  for (let k = 0; k < NPART; k++) { flush(k); fs.closeSync(parts[k]); }
  console.error('pass1 done ' + JSON.stringify(st));

  // Pass 2: per partition sort + dedupe, append to gzip TSV.
  const gz = zlib.createGzip({ level: 6 });
  const outStream = gz.pipe(fs.createWriteStream(path.join(outDir, 'edges.tsv.gz')));
  let unique = 0;
  for (let k = 0; k < NPART; k++) {
    const file = path.join(outDir, `part${k}.bin`);
    const buf = fs.readFileSync(file);
    const n = buf.length / 8;
    // page ids < 2^26, so src * 2^26 + tgt is exact in a float64
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = buf.readInt32LE(i * 8) * SHIFT + buf.readInt32LE(i * 8 + 4);
    keys.sort();
    let chunk = '', prev = -1;
    for (let i = 0; i < n; i++) {
      const key = keys[i];
      if (key === prev) continue;
      prev = key; unique++;
      const src = Math.floor(key / SHIFT);
      chunk += `${src}\t${key - src * SHIFT}\n`;
      if (chunk.length > 1 << 20) { if (!gz.write(chunk)) await new Promise(r => gz.once('drain', r)); chunk = ''; }
    }
    if (chunk) gz.write(chunk);
    fs.unlinkSync(file);
    console.error(`partition ${k}: ${n} -> cumulative unique ${unique}`);
  }
  await new Promise(r => { outStream.on('finish', r); gz.end(); });
  st.unique_edges = unique;
  st.articles = idOf.size;
  st.redirects = redirects.size;
  const top = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100000);
  fs.writeFileSync(path.join(outDir, 'unresolved_targets.tsv'), top.map(([t, c]) => `${t}\t${c}`).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(st, null, 2));
  console.error(JSON.stringify(st));
})();
