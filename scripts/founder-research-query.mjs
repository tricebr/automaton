// Search terms must already occur in public evidence. Never send private metadata or
// arbitrary planner text (which may quote the protected mission) to search services.
export function publicResearchQuery(ctx,fallback){
 const words=x=>String(x??'').toLowerCase().match(/\b[a-z]{4,24}\b/g)??[];
 const allowed=new Set((ctx.dependencies??[]).filter(r=>r.privacy!=='private').flatMap(r=>(r.sources??[]).filter(s=>s.privacy!=='private').flatMap(s=>words(s.claim))));
 const terms=[...new Set(words(ctx.task?.input?.title))].filter(w=>allowed.has(w)).slice(0,10);
 return terms.length>=2?terms.join(' '):fallback;
}
