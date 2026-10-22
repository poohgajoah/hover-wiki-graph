// Pack what Colab cannot download itself into data/colab_bundle/:
//   nodes.tsv.gz  node_id \t title (HotpotQA/HoVer form)
//   links.i32     little-endian int32 (src, tgt) pairs, unique, sorted
//   hover_{train,dev}_release_v1.1.json
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readLines } = require('./title_utils');

const root = path.join(__dirname, '..', 'data');
const out = path.join(root, 'colab_bundle');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const idOf = new Map();
  const gz = zlib.createGzip();
  const nodesOut = gz.pipe(fs.createWriteStream(path.join(out, 'nodes.tsv.gz')));
  for await (const l of readLines(path.join(root, 'graph', 'abstract', 'nodes.tsv'))) {
    const [id, title] = l.split('\t');
    idOf.set(title, +id);
    if (!gz.write(`${id}\t${title}\n`)) await new Promise(r => gz.once('drain', r));
  }
  await new Promise(r => { nodesOut.on('finish', r); gz.end(); });
  console.error(`nodes ${idOf.size}`);

  const SHIFT = 2 ** 23;  // node ids < 5.3M < 2^23
  // Set is capped at 2^24 entries, so collect all occurrences, sort, then dedupe
  let keys = new Float64Array(24_000_000), n = 0;
  for await (const l of readLines(path.join(root, 'graph', 'abstract', 'edges.tsv'))) {
    const a = l.indexOf('\t'), b = l.indexOf('\t', a + 1), c = l.indexOf('\t', b + 1);
    if (n === keys.length) { const k2 = new Float64Array(n * 2); k2.set(keys); keys = k2; }
    keys[n++] = idOf.get(l.slice(0, a)) * SHIFT + idOf.get(l.slice(b + 1, c));
  }
  const sorted = keys.subarray(0, n).sort();
  const buf = Buffer.alloc(n * 8);
  let u = 0;
  for (let i = 0; i < n; i++) {
    if (i && sorted[i] === sorted[i - 1]) continue;
    const s = Math.floor(sorted[i] / SHIFT);
    buf.writeInt32LE(s, u * 8); buf.writeInt32LE(sorted[i] - s * SHIFT, u * 8 + 4); u++;
  }
  fs.writeFileSync(path.join(out, 'links.i32'), buf.subarray(0, u * 8));
  console.error(`link occurrences ${n}, unique links ${u}`);

  for (const s of ['train', 'dev'])
    fs.copyFileSync(path.join(root, `hover_${s}_release_v1.1.json`), path.join(out, `hover_${s}_release_v1.1.json`));
})();
