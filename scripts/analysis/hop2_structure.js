const fs=require('fs');const [,,dir,split,showEx]=process.argv;
const d=JSON.parse(fs.readFileSync(`${dir}/hover_${split}_release_v1.1.json`,'utf8')).filter(e=>e.num_hops===2);
const pct=(a,b)=>b?(100*a/b).toFixed(0)+'%':'-';
const norm=s=>' '+s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()+' ';
const core=t=>t.replace(/\s*\(.*?\)\s*/g,' ').trim();
// title mention: full core title, or (for person-like) last token >=4 chars
function mentioned(title,claim){const c=norm(claim),t=norm(core(title));if(c.includes(t))return true;
  const toks=t.trim().split(' ');if(toks.length>=2){const last=toks[toks.length-1];if(last.length>=4&&c.includes(' '+last+' '))return true;}return false;}
const RE={
  compare:/\b(than|same|different|both older|earlier|later|older|younger|longer|shorter|taller|larger|smaller|bigger|higher|lower|more|fewer|less|before|after|first|predate[sd]?)\b/i,
  both:/\bboth\b|\bneither\b|\beither\b/i,
  negation:/\b(not|never|no|neither|nor)\b|n't\b/i,
  rel:/\b(that|who|whom|which|whose|where)\b|\b(in|at|on|from|by|for|of|with) (which|whom)\b/i,
  part:/\b(directed|produced|written|founded|created|owned|released|recorded|starring|featuring|named|known|located|portrayed|composed|designed|built|developed|published|hosted|managed|formed|based|born|played|sung|performed|acquired|operated|coached|founded)( \w+)? (by|in|as|for|after|on|at|from)\b|\bstarring\b|\bfeaturing\b/i,
  poss:/\bthe (\w+ ){0,3}of (the|a|an|this)\b|'s (\w+ ){0,2}(film|album|song|book|novel|band|wife|husband|son|daughter|father|mother|director|author)\b/i,
  appos:/^[^,]+, (a|an|the) [^,]+,/i,
  and:/\band\b/i,
};
function cls(e){const c=e.claim;const titles=[...new Set(e.supporting_facts.map(f=>f[0]))];const m=titles.map(t=>mentioned(t,c));const n=m.filter(Boolean).length;
  let top,sub;
  const CMP=/\b(than|the same|different|older|younger|earlier|predate[sd]?|outlive[sd]?|before)\b/i;
  if(CMP.test(c)){top='C. 비교 R(a,b)';}
  else if(RE.both.test(c)||(n===2&&/^[^,.]{2,80}? and [^,.]{2,80}? (are|were|have|had|both|each)\b/.test(c))){top='B. 병렬 P(a)∧P(b)';}
  else if(n===2){top='D. 명시 연결 R(a,b) / P(a)∧Q(b)';}
  else {top='A. 브리지 합성 P(f(a))';}
  if(top.startsWith('A')){sub=RE.rel.test(c)?'관계절(that/who/which)':RE.part.test(c)?'분사구(directed by …)':RE.poss.test(c)?'소유·of 연쇄(the X of Y)':RE.appos.test(c)?'동격':'기타(서술형 묘사)';}
  if(top.startsWith('D')){sub=RE.rel.test(c)||RE.appos.test(c)?'b에 관계절·동격 부가':RE.and.test(c)?'and 연결':'단일 관계 R(a,b)';}
  return {top,sub,n,neg:RE.negation.test(c)};}
const rs=d.map(e=>({e,...cls(e)}));
console.log(`\n##### ${split} 2-hop (${d.length}) #####`);
console.log('제목 언급 수: 0개',pct(rs.filter(r=>r.n===0).length,d.length),' 1개',pct(rs.filter(r=>r.n===1).length,d.length),' 2개',pct(rs.filter(r=>r.n===2).length,d.length));
const tops=[...new Set(rs.map(r=>r.top))].sort();
console.log('\n유형 | n | 비율 | SUP% | 부정어% | 평균단어');
for(const t of tops){const g=rs.filter(r=>r.top===t);const w=g.map(r=>r.e.claim.split(/\s+/).length);
  console.log(`${t} | ${g.length} | ${pct(g.length,d.length)} | ${pct(g.filter(r=>r.e.label==='SUPPORTED').length,g.length)} | ${pct(g.filter(r=>r.neg).length,g.length)} | ${(w.reduce((a,b)=>a+b)/w.length).toFixed(1)}`);
  const subs=[...new Set(g.map(r=>r.sub).filter(Boolean))];
  for(const s of subs){const h=g.filter(r=>r.sub===s);console.log(`   └ ${s} | ${h.length} | ${pct(h.length,g.length)} | SUP ${pct(h.filter(r=>r.e.label==='SUPPORTED').length,h.length)}`);}}
// bridge: which doc hidden -> sentence idx of hidden doc
const A=rs.filter(r=>r.top.startsWith('A')&&r.n===1);
const hidIdx=A.flatMap(r=>r.e.supporting_facts.filter(f=>!mentioned(f[0],r.e.claim)).map(f=>f[1])),visIdx=A.flatMap(r=>r.e.supporting_facts.filter(f=>mentioned(f[0],r.e.claim)).map(f=>f[1]));
console.log(`\n브리지형: 숨은 문서 근거문장 idx0 ${pct(hidIdx.filter(x=>x===0).length,hidIdx.length)} / 명시 문서 idx0 ${pct(visIdx.filter(x=>x===0).length,visIdx.length)}`);
const hidT=A.flatMap(r=>r.e.supporting_facts.filter(f=>!mentioned(f[0],r.e.claim)).map(f=>(f[0].match(/\((.*)\)/)||[,'(없음)'])[1]));
const cnt={};for(const x of hidT)cnt[x]=(cnt[x]||0)+1;console.log('숨은 문서 제목 괄호 유형 top:',JSON.stringify(Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,8)));
if(showEx){let s=5;const r=()=>(s=(s*16807)%2147483647)/2147483647;
  const keys=[...new Set(rs.map(r=>r.top+' :: '+(r.sub||'')))].sort();
  for(const k of keys){const g=rs.filter(x=>x.top+' :: '+(x.sub||'')===k);console.log('\n# '+k);for(let i=0;i<3;i++){const x=g[Math.floor(r()*g.length)];console.log(`  [${x.e.label[0]}] ${x.e.claim}\n      docs: ${[...new Set(x.e.supporting_facts.map(f=>f[0]))].map(t=>(mentioned(t,x.e.claim)?'':'*')+t).join(' | ')}`);}}}
