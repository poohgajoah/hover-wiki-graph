// Check how well the 2017-10-01 link graphs cover HoVer supporting documents.
// argv: data dir (hover_*.json), abstract graph dir, full graph dir (optional)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readLines, htmlUnescape } = require('./title_utils');

const [dataDir, absDir, fullDir] = process.argv.slice(2);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');

const claims = [];
for (const s of ['train', 'dev'])
  for (const e of JSON.parse(fs.readFileSync(path.join(dataDir, `hover_${s}_release_v1.1.json`), 'utf8')))
    claims.push({ split: s, ...e, docs: [...new Set(e.supporting_facts.map(f => f[0]))] });
const hoverTitles = new Set(claims.flatMap(c => c.docs));

async function lines(file, fn) {
  let input = fs.createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  for await (const l of readLines(input)) if (l) fn(l);
}

// edges among HoVer docs: key "a\tb" -> Set(sentence idx) (abstract) or true (full)
async function loadAbstract() {
  const nodes = new Set();
  await lines(path.join(absDir, 'nodes.tsv'), l => { const t = l.split('\t')[1]; if (hoverTitles.has(t)) nodes.add(t); });
  const edges = new Map();
  await lines(path.join(absDir, 'edges.tsv'), l => {
    const [s, i, t] = l.split('\t');
    if (!hoverTitles.has(s) || !hoverTitles.has(t)) return;
    const k = s + '\t' + t;
    if (!edges.has(k)) edges.set(k, new Set());
    edges.get(k).add(+i);
  });
  return { nodes, edges };
}

async function loadFull() {
  // full-graph titles are unescaped Wikipedia titles; HoVer keeps HTML escapes
  const hoverByCanon = new Map([...hoverTitles].map(t => [htmlUnescape(t), t]));
  const idOf = new Map(), titleOf = new Map();
  await lines(path.join(fullDir, 'nodes.tsv'), l => {
    const [id, wt] = l.split('\t');
    const t = hoverByCanon.get(wt);
    if (t !== undefined) { idOf.set(t, +id); titleOf.set(+id, t); }
  });
  const edges = new Map();
  await lines(path.join(fullDir, 'edges.tsv.gz'), l => {
    const tab = l.indexOf('\t');
    const s = titleOf.get(+l.slice(0, tab));
    if (s === undefined) return;
    const t = titleOf.get(+l.slice(tab + 1));
    if (t !== undefined) edges.set(s + '\t' + t, true);
  });
  return { nodes: new Set(idOf.keys()), edges };
}

function report(name, g, withSent) {
  console.log(`\n=== ${name} graph ===`);
  console.log(`HoVer titles present: ${g.nodes.size}/${hoverTitles.size} (${pct(g.nodes.size, hoverTitles.size)})`);
  const linked = (a, b) => g.edges.has(a + '\t' + b) || g.edges.has(b + '\t' + a);
  for (const split of ['train', 'dev']) {
    for (const h of [2, 3, 4]) {
      const cs = claims.filter(c => c.split === split && c.num_hops === h);
      let allIn = 0, connected = 0, pairLinked = 0, sentMatch = 0;
      for (const c of cs) {
        if (c.docs.every(d => g.nodes.has(d))) allIn++;
        // connectivity of the doc set (undirected)
        const seen = new Set([c.docs[0]]), stack = [c.docs[0]];
        while (stack.length) { const a = stack.pop(); for (const b of c.docs) if (!seen.has(b) && linked(a, b)) { seen.add(b); stack.push(b); } }
        if (seen.size === c.docs.length) connected++;
        if (h === 2 && linked(c.docs[0], c.docs[1])) {
          pairLinked++;
          if (withSent) {
            // does a link leave from one of the supporting sentences?
            const sf = new Set(c.supporting_facts.map(f => f[0] + '\t' + f[1]));
            const hit = [[c.docs[0], c.docs[1]], [c.docs[1], c.docs[0]]].some(([a, b]) =>
              [...(g.edges.get(a + '\t' + b) || [])].some(i => sf.has(a + '\t' + i)));
            if (hit) sentMatch++;
          }
        }
      }
      let line = `${split} ${h}-hop n=${cs.length}: all docs in graph ${pct(allIn, cs.length)}, doc set connected ${pct(connected, cs.length)}`;
      if (h === 2) line += `, pair directly linked ${pct(pairLinked, cs.length)}` + (withSent ? `, link from a supporting sentence ${pct(sentMatch, cs.length)}` : '');
      console.log(line);
    }
  }
}

(async () => {
  report('abstract (intro paragraphs)', await loadAbstract(), true);
  if (fullDir) report('full-article (pagelinks)', await loadFull(), false);
})();
