const fs=require('fs');const dir=process.argv[2];
const load=s=>JSON.parse(fs.readFileSync(`${dir}/hover_${s}_release_v1.1.json`,'utf8'));
const tr=load('train'),dv=load('dev'),te=load('test');
const pct=(a,b)=>(100*a/b).toFixed(1)+'%';
// split leakage
const trH=new Set(tr.map(e=>e.hpqa_id));console.log('dev hpqa_id in train:',pct(dv.filter(e=>trH.has(e.hpqa_id)).length,dv.length));
const trT=new Set(tr.flatMap(e=>e.supporting_facts.map(f=>f[0])));const dvT=[...new Set(dv.flatMap(e=>e.supporting_facts.map(f=>f[0])))];
console.log('dev titles seen in train:',pct(dvT.filter(t=>trT.has(t)).length,dvT.length));
const trC=new Set(tr.map(e=>e.claim));console.log('exact dup claims dev∩train:',dv.filter(e=>trC.has(e.claim)).length,' test∩train:',te.filter(e=>trC.has(e.claim)).length);
// edit distance between SUP and NOT claims of same hpqa & same hop
const tok=s=>s.toLowerCase().match(/[a-z0-9']+/g)||[];
function diff(a,b){const A=tok(a),B=tok(b);const sa=new Set(A),sb=new Set(B);return {rm:A.filter(x=>!sb.has(x)),add:B.filter(x=>!sa.has(x))};}
const g={};for(const e of dv){(g[e.hpqa_id+'_'+e.num_hops]??=[]).push(e);}
const sizes=[];const addW={};let shown=0;
for(const k in g){const S=g[k].filter(e=>e.label==='SUPPORTED'),N=g[k].filter(e=>e.label==='NOT_SUPPORTED');
  for(const n of N){if(!S.length)continue;let best=null;for(const s of S){const d=diff(s.claim,n.claim);const sz=d.rm.length+d.add.length;if(!best||sz<best.sz)best={sz,d,s};}
    sizes.push(best.sz);for(const w of best.d.add)addW[w]=(addW[w]||0)+1;
    if(best.sz<=4&&shown<8){shown++;console.log(`\n[${n.num_hops}hop] SUP: ${best.s.claim}\n        NOT: ${n.claim}\n        -${best.d.rm.join(',')} +${best.d.add.join(',')}`);}}}
sizes.sort((a,b)=>a-b);console.log('\nNOT claims paired with a SUP sibling:',sizes.length,'median token diff',sizes[sizes.length>>1],' <=2 tokens:',pct(sizes.filter(x=>x<=2).length,sizes.length),' <=4:',pct(sizes.filter(x=>x<=4).length,sizes.length));
console.log('most common inserted words in NOT edits:',JSON.stringify(Object.entries(addW).sort((a,b)=>b[1]-a[1]).slice(0,25)));
// hop progression: same hpqa group, does 3hop claim extend 2hop claim?
let ext=0,tot=0;for(const e of dv.filter(e=>e.num_hops>2)){const lower=dv.filter(x=>x.hpqa_id===e.hpqa_id&&x.num_hops===e.num_hops-1);if(!lower.length)continue;tot++;
  const tl=new Set(e.supporting_facts.map(f=>f[0]));if(lower.some(l=>l.supporting_facts.every(f=>tl.has(f[0]))))ext++;}
console.log('\nk-hop claims whose (k-1)-hop sibling doc set is a subset:',ext,'/',tot);
// examples of 2,3,4 hop for one group
const ex=Object.values(dv.reduce((m,e)=>((m[e.hpqa_id]??=[]).push(e),m),{})).find(v=>new Set(v.map(e=>e.num_hops)).size===3);
for(const e of ex.sort((a,b)=>a.num_hops-b.num_hops))console.log(`  ${e.num_hops}hop ${e.label}: ${e.claim}\n      docs: ${[...new Set(e.supporting_facts.map(f=>f[0]))].join(' | ')}`);
