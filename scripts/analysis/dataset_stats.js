const fs=require('fs');const dir=process.argv[2];
const load=s=>JSON.parse(fs.readFileSync(`${dir}/hover_${s}_release_v1.1.json`,'utf8'));
const cnt=(arr)=>{const m={};for(const x of arr)m[x]=(m[x]||0)+1;return Object.entries(m).sort((a,b)=>b[1]-a[1]);};
const pct=(a,b)=>(100*a/b).toFixed(1)+'%';
const norm=s=>s.toLowerCase().replace(/\s*\(.*?\)\s*/g,' ').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
for(const s of ['train','dev','test']){
  const d=load(s);console.log(`\n===== ${s} (${d.length}) =====`);
  console.log('keys:',Object.keys(d[0]).join(','));
  if(!d[0].label){console.log('no labels');continue;}
  // label x hops
  const t={};for(const e of d){t[e.num_hops]??={};t[e.num_hops][e.label]=(t[e.num_hops][e.label]||0)+1;}
  console.log('hops x label:',JSON.stringify(t));
  // docs per claim vs hops
  const mism=[];const sfPer=[];
  for(const e of d){const titles=new Set(e.supporting_facts.map(f=>f[0]));if(titles.size!==e.num_hops)mism.push(e);sfPer.push(e.supporting_facts.length-titles.size);}
  console.log('distinct docs != num_hops:',mism.length,pct(mism.length,d.length));
  console.log('extra sentences beyond 1/doc:',JSON.stringify(cnt(sfPer).slice(0,6)));
  // sentence index
  const idx=d.flatMap(e=>e.supporting_facts.map(f=>f[1]));
  console.log('sent idx dist:',JSON.stringify(cnt(idx).slice(0,8)),' idx0 share',pct(idx.filter(i=>i===0).length,idx.length));
  // title mentioned in claim (bridge entity explicit vs hidden)
  const byHop={};
  for(const e of d){const c=norm(e.claim);const titles=[...new Set(e.supporting_facts.map(f=>f[0]))];
    const hit=titles.filter(ti=>c.includes(norm(ti))).length;
    byHop[e.num_hops]??=[];byHop[e.num_hops].push(hit/titles.length);}
  for(const h in byHop){const a=byHop[h];console.log(`hop${h}: mean frac titles in claim ${(a.reduce((x,y)=>x+y,0)/a.length).toFixed(2)}, all titles present ${pct(a.filter(x=>x===1).length,a.length)}, none ${pct(a.filter(x=>x===0).length,a.length)}`);}
  // disambiguated titles
  const allT=d.flatMap(e=>e.supporting_facts.map(f=>f[0]));
  console.log('titles w/ parenthetical:',pct(allT.filter(t=>/\(.*\)/.test(t)).length,allT.length));
  console.log('top parentheticals:',JSON.stringify(cnt(allT.map(t=>(t.match(/\((.*)\)/)||[])[1]).filter(Boolean)).slice(0,10)));
  console.log('top titles:',JSON.stringify(cnt(allT).slice(0,10)));
  // claim length
  for(const L of ['SUPPORTED','NOT_SUPPORTED']){const w=d.filter(e=>e.label===L).map(e=>e.claim.split(/\s+/).length);console.log(L,'avg words',(w.reduce((a,b)=>a+b,0)/w.length).toFixed(1));}
  for(const h of [2,3,4]){const w=d.filter(e=>e.num_hops===h).map(e=>e.claim.split(/\s+/).length);console.log('hop',h,'avg words',(w.reduce((a,b)=>a+b,0)/w.length).toFixed(1));}
  // lexical cues by label
  const cues={negation:/\b(not|never|no|n't|neither|nor)\b/i,both:/\bboth\b/i,comparative:/\b(older|younger|earlier|later|more|less|larger|smaller|bigger|longer|shorter|first|before|after)\b/i,relclause:/\b(that|who|which|whose)\b/i,also:/\b(also)\b/i,number:/\d/};
  for(const [k,re] of Object.entries(cues)){const r=['SUPPORTED','NOT_SUPPORTED'].map(L=>{const g=d.filter(e=>e.label===L);return pct(g.filter(e=>re.test(e.claim)).length,g.length)});console.log(`cue ${k}: SUP ${r[0]} / NOT ${r[1]}`);}
  // hpqa_id reuse
  const hq=cnt(d.map(e=>e.hpqa_id));console.log('unique hpqa_id',hq.length,'claims per hpqa_id dist',JSON.stringify(cnt(hq.map(x=>x[1]))));
  // label consistency within same hpqa group & same doc set
  const g={};for(const e of d){(g[e.hpqa_id]??=[]).push(e);}
  let mixed=0,multi=0;for(const k in g){if(g[k].length>1){multi++;if(new Set(g[k].map(e=>e.label)).size>1)mixed++;}}
  console.log('hpqa groups >1 claim:',multi,'with mixed labels:',mixed);
  const ds={};for(const e of d){const k=[...new Set(e.supporting_facts.map(f=>f[0]))].sort().join('|');(ds[k]??=[]).push(e.label);}
  const dsm=Object.values(ds).filter(v=>v.length>1);console.log('identical doc-sets shared by >1 claim:',dsm.length,'mixed label:',dsm.filter(v=>new Set(v).size>1).length);
  // first word / template
  console.log('top claim openings:',JSON.stringify(cnt(d.map(e=>e.claim.split(' ').slice(0,2).join(' '))).slice(0,12)));
}
