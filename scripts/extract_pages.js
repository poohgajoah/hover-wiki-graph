// Stream a MediaWiki pages-articles XML dump from stdin and write the
// namespace-0 page table: page_id \t title \t redirect_target ('' if not a redirect).
// Usage: curl ... | bzip2 -dc | node extract_pages.js out.tsv
const fs = require('fs');
const readline = require('readline');

const out = fs.createWriteStream(process.argv[2]);
const unescape = s => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

let title = null, ns = null, id = null, redirect = '', pages = 0, redirects = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const t = line.trimStart();
  if (t.startsWith('<page>')) { title = ns = id = null; redirect = ''; }
  else if (t.startsWith('<title>')) title = unescape(t.slice(7, t.indexOf('</title>')));
  else if (t.startsWith('<ns>')) ns = t.slice(4, t.indexOf('</ns>'));
  else if (id === null && t.startsWith('<id>')) id = t.slice(4, t.indexOf('</id>'));
  else if (t.startsWith('<redirect title="')) redirect = unescape(t.slice(17, t.indexOf('"', 17)));
  else if (t.startsWith('</page>') && ns === '0') {
    out.write(`${id}\t${title}\t${redirect}\n`);
    pages++; if (redirect) redirects++;
    if (pages % 1000000 === 0) console.error(`${pages} ns0 pages (${redirects} redirects)`);
  }
});
rl.on('close', () => out.end(() => console.error(`done: ${pages} ns0 pages, ${redirects} redirects`)));
