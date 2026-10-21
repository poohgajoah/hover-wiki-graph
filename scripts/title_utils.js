// Shared Wikipedia title normalisation and 2017-10-01 redirect resolution.
const fs = require('fs');

// MediaWiki canonical form: underscores -> spaces, collapse whitespace,
// drop #section, upper-case first character.
function normTitle(t) {
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const h = t.indexOf('#');
  if (h >= 0) t = t.slice(0, h).trim();
  if (!t) return '';
  return t[0].toUpperCase() + t.slice(1);
}

// pages_ns0 tsv: page_id \t title \t redirect_target
// Async line iterator that splits on '\n' only. readline also splits on
// U+2028/U+2029/\r, which occur inside some Wikipedia titles and anchors.
async function* readLines(input) {
  if (typeof input === 'string') input = fs.createReadStream(input);
  input.setEncoding('utf8');
  let rest = '';
  for await (const chunk of input) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();
    yield* parts;
  }
  if (rest) yield rest;
}

// Characters that must not appear inside a TSV field.
// (built from char codes: line/paragraph separators, NEL, VT, FF)
const SEPARATORS = String.fromCharCode(0x2028, 0x2029, 0x85, 0x0b, 0x0c);
const BREAKS = new RegExp('[\\t\\n\\r' + SEPARATORS + ']', 'g');
const BREAKS_NO_TAB = new RegExp('[\\r' + SEPARATORS + ']', 'g');

// onPage(id, title, redirect) is called for every row if given.
async function loadRedirects(pagesTsv, onPage) {
  const redirects = new Map();
  for await (const line of readLines(pagesTsv)) {
    const a = line.indexOf('\t'), b = line.indexOf('\t', a + 1);
    if (b < 0) continue;
    const title = line.slice(a + 1, b), target = line.slice(b + 1);
    if (target) redirects.set(title, target);
    if (onPage) onPage(line.slice(0, a), title, target);
  }
  return redirects;
}

// Decode HTML entities left in hrefs/anchors (&amp; &nbsp; &#160; &#x27; ...).
// Must run before '#' is treated as a section separator.
const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—' };
function htmlUnescape(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp === 160 ? ' ' : String.fromCodePoint(cp);
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// HotpotQA/HoVer titles keep HTML escapes ("Sugar &amp; Spice"), while hrefs and
// the Wikipedia redirect table do not. Map unescaped form -> stored node title.
function canonMap(titles) {
  const m = new Map();
  for (const t of titles) m.set(htmlUnescape(t), t);
  return m;
}

// Resolve a raw link target to a stored node title via canonMap().
// kind: direct | case_fixed | via_redirect | unresolved | empty
function resolve(raw, canon, redirects) {
  const exact = htmlUnescape(raw).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().split('#')[0].trim();
  if (!exact) return { kind: 'empty' };
  if (canon.has(exact)) return { kind: 'direct', title: canon.get(exact) };
  let t = normTitle(exact);
  if (canon.has(t)) return { kind: 'case_fixed', title: canon.get(t) };
  for (let hop = 0; hop < 5 && redirects.has(t); hop++) {
    t = normTitle(redirects.get(t));
    if (canon.has(t)) return { kind: 'via_redirect', title: canon.get(t) };
  }
  return { kind: 'unresolved', title: normTitle(exact) };
}

module.exports = { normTitle, loadRedirects, resolve, canonMap, readLines, htmlUnescape, BREAKS, BREAKS_NO_TAB };
