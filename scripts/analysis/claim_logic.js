const fs=require('fs');const [,,dir,split]=process.argv;
const d=JSON.parse(fs.readFileSync(`${dir}/hover_${split}_release_v1.1.json`,'utf8'));
const pct=(a,b)=>b?(100*a/b).toFixed(0)+'%':'-';
// sentence split (avoid abbreviations / initials)
const sents=c=>c.replace(/\b(Jr|Sr|Dr|Mr|Mrs|Ms|St|U\.S|Inc|Co|Ltd|vs|No)\./g,'$1<D>').replace(/\b([A-Z])\./g,'$1<D>').split(/(?<=[.!?]["”]?)\s+(?=[A-Z"“])/).filter(s=>s.trim());
const F={
  multi:c=>sents(c).length>1,
  anaphora:c=>sents(c).slice(1).some(s=>/^(This|That|These|Those|It|He|She|They|His|Her|Its|Their|The (same )?(latter|former)|Both|So |Another|The (\w+ ){0,2}(also|too)\b)/.test(s.trim())||/^The \w+(\s\w+)? (also|too)\b/.test(s.trim())),
  relclause:c=>/\b(that|who|whom|which|whose)\b|\b(in|at|on|from|by|for|of|with) (which|whom)\b|\bwhere\b(?!.*\bdoesn'?t\b)/i.test(c),
  participle:c=>/\b(directed|produced|written|founded|created|owned|released|recorded|starring|featuring|named|based|known|located|born|played|portrayed|composed|designed|built|developed|published|hosted|managed|formed|performed|sung)( \w+)? (by|in|as|for|after|on|at)\b/i.test(c),
  possessiveChain:c=>/\bthe (\w+ ){0,2}(of|for) the\b/i.test(c),
  both:c=>/\bboth\b|\bneither\b|\beither\b/i.test(c),
  parallel:c=>/\b(so (is|was|were|did|does|has|had)|as (was|is|did|does)|as well|too)\b[.,]?/i.test(c)||/\balso\b/i.test(c),
  coordSubj:c=>/^[^,]{3,80}? and [^,]{3,60}? (are|were|have|had|both)\b/.test(c),
  comparison:c=>/\b(than|older|younger|earlier|later|longer|shorter|taller|larger|smaller|bigger|higher|lower|more|less|fewer|first|before|after|same|different|predate[sd]?|outlive[sd]?)\b/i.test(c),
  negation:c=>/\b(not|never|no|none|neither|nor|without)\b|n't\b|n’t\b/i.test(c),
  contrast:c=>/\b(but|while|whereas|however|unlike|although|though)\b|,? where [^.]*\b(n't|not)\b/i.test(c),
  existential:c=>sents(c).some(s=>/^(An?|One|Some|Another|There (is|was|are|were)) /.test(s.trim())),
  disjunction:c=>/\b(either|or)\b/i.test(c)&&!/\bor so\b/.test(c),
  numeric:c=>/\b\d{1,4}\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million)\b/i.test(c),
};
// nesting depth: # bridge markers
const depth=c=>(c.match(/\b(that|who|whom|which|whose|where)\b/gi)||[]).length+(c.match(/\b(directed|produced|written|founded|created|owned|released|recorded|starring|featuring|named|known|located|portrayed|composed|designed|built|developed|published|hosted|managed|formed) (by|for|as|in)\b/gi)||[]).length+(c.match(/\bthe \w+( \w+)? of (the|a|an)\b/gi)||[]).length;
// primary logical form (priority)
function form(c){const f=k=>F[k](c);
  if(f('comparison')&&/\b(than|same|different|before|after|earlier|later|older|younger|predate|outlive)/i.test(c))return 'COMPARE  R(f(a),g(b))';
  if((f('negation')||f('contrast'))&&(f('parallel')||f('contrast')||f('multi')))return 'CONTRAST P(a)∧¬P(b)';
  if(f('both')||f('coordSubj')||/\b(so (is|was|did)|as well|too)\b/i.test(c))return 'PARALLEL P(a)∧P(b)';
  if(f('multi'))return 'CONJ-SEQ P(x)∧Q(x) (multi-sentence)';
  if(/,? and (also |later |was |is |has |had |were |\w+ed\b)/i.test(c))return 'CONJ P(x)∧Q(x) (and)';
  if(depth(c)>0)return 'COMPOSE P(f(g(a)))';
  return 'ATOMIC/APPOSITIVE';
}
const L=['SUPPORTED','NOT_SUPPORTED'],H=[2,3,4];
console.log(`\n##### ${split} (${d.length}) #####`);
console.log('\n-- primary logical form: share by hop | SUP rate --');
const forms=[...new Set(d.map(e=>form(e.claim)))];const rows=[];
for(const fm of forms){const g=d.filter(e=>form(e.claim)===fm);rows.push([fm,g.length,...H.map(h=>pct(g.filter(e=>e.num_hops===h).length,d.filter(e=>e.num_hops===h).length)),pct(g.filter(e=>e.label==='SUPPORTED').length,g.length)]);}
rows.sort((a,b)=>b[1]-a[1]);console.log('form | n | 2hop | 3hop | 4hop | SUP%');for(const r of rows)console.log(r.join(' | '));
console.log('\n-- feature prevalence: 2hop/3hop/4hop || SUP/NOT --');
for(const k in F){console.log(k.padEnd(16),H.map(h=>{const g=d.filter(e=>e.num_hops===h);return pct(g.filter(e=>F[k](e.claim)).length,g.length)}).join('/').padEnd(14),'||',L.map(l=>{const g=d.filter(e=>e.label===l);return pct(g.filter(e=>F[k](e.claim)).length,g.length)}).join('/'));}
console.log('\n-- nesting depth & sentence count by hop --');
for(const h of H){const g=d.filter(e=>e.num_hops===h);const dp=g.map(e=>depth(e.claim)),sc=g.map(e=>sents(e.claim).length);console.log(`hop${h}: mean depth ${(dp.reduce((a,b)=>a+b)/g.length).toFixed(2)}, depth0 ${pct(dp.filter(x=>x===0).length,g.length)}, mean sents ${(sc.reduce((a,b)=>a+b)/g.length).toFixed(2)}, sents dist ${JSON.stringify([1,2,3,4].map(n=>pct(sc.filter(x=>n===4?x>=4:x===n).length,g.length)))}`);}
if(process.argv[4]){console.log('\n-- examples --');let s=11;const r=()=>(s=(s*16807)%2147483647)/2147483647;
for(const fm of rows.map(r=>r[0])){console.log('\n# '+fm);const g=d.filter(e=>form(e.claim)===fm);for(let i=0;i<3;i++){const e=g[Math.floor(r()*g.length)];console.log(`  [${e.num_hops}h ${e.label[0]}] ${e.claim}`);}}}
