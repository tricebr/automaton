import {createHash} from 'node:crypto';
import {publicJson,SOURCE_LIMITS} from '../src/online/sources.ts';
import {fixedPublicFetch} from '../src/online/fixed-public-fetch.ts';

const digest=s=>createHash('sha256').update(s).digest('hex');
const repoPattern=/^([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)(?=[:\s]|$)/;
const clean=s=>String(s??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function paymentExcerpt(text){
 if(text.length<=4000)return text;
 const sections=[];let end=0,length=0;
 for(const m of text.matchAll(/\b(?:bount\w*|paid|payment\w*|funding|sponsor\w*|reward\w*|compensation|escrow|bezahlt\w*|vergütung\w*)\b/gi)){
  const from=Math.max(end,m.index-250),to=Math.min(text.length,m.index+500);if(to<=from)continue;
  const part=text.slice(from,to);sections.push(part);end=to;length+=part.length;if(length>=3900)break;
 }
 return sections.length?('[Selected payment/funding excerpts; not a complete source]\n'+sections.join('\n[…]\n')).slice(0,4000):text.slice(0,4000);
}
export const specificResearch=ctx=>!!(ctx.task?.dependencies?.length||ctx.task?.id?.startsWith('selected-')||ctx.task?.input?.repairTargetUrl||ctx.task?.input?.researchGoal);
function evidencedRepo(ctx){
 const repo=String(ctx.task?.input?.title??'').match(repoPattern)?.[1];if(!repo||repo.includes('..'))return null;
 const found=(ctx.dependencies??[]).some(r=>r.privacy!=='private'&&(r.sources??[]).some(s=>{
  if(s.privacy==='private')return false;
  try{const u=new URL(s.url);return u.origin==='https://github.com'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&(u.pathname.toLowerCase()==='/'+repo.toLowerCase()||u.pathname.toLowerCase().startsWith('/'+repo.toLowerCase()+'/'));}catch{return false;}
 }));return found?repo:null;
}

// Shares the existing public-request ledger. No credentials, AI, publication,
// trade adapters or general autonomous topic selection are reachable here.
export function createTargetedResearch({db,request=fixedPublicFetch,now=()=>Date.now()}){
 db.exec(`CREATE TABLE IF NOT EXISTS founder_target_reads(id INTEGER PRIMARY KEY,repo TEXT NOT NULL,task_id TEXT NOT NULL,status TEXT NOT NULL,at_ms INTEGER NOT NULL,retry_ms INTEGER,result TEXT);
 CREATE INDEX IF NOT EXISTS founder_target_repo ON founder_target_reads(repo,id);`);
 function waitState(ctx){
  const repo=evidencedRepo(ctx),at=now();
  if(!repo)return {code:'research_target_review',reason:'Konkretes Recherche-Ziel ist nicht durch öffentliche Vorarbeiten belegt; keine allgemeine Ersatzrecherche.',until:null,checkAt:at+60000};
  if(ctx.task.input.notBefore>at)return {code:'scheduled',reason:'Konkreter Rechercheauftrag ist für später geplant.',until:ctx.task.input.notBefore};
  const last=db.prepare('SELECT * FROM founder_target_reads WHERE lower(repo)=lower(?) ORDER BY id DESC LIMIT 1').get(repo);
  if(last?.status==='review'||last?.status==='running')return {code:'target_review',reason:'Vorheriger gezielter Abruf muss geprüft werden; kein automatischer Ersatzlauf.',until:null,checkAt:at+60000};
  if(last&&at<last.at_ms)return {code:'target_review',reason:'Uhrzeitprüfung für gezielte Recherche erforderlich.',until:null,checkAt:at+60000};
  const until=last?.status==='done'?last.at_ms+86400000:last?.retry_ms;
  if(until>at)return {code:last.status==='done'?'target_cooldown':'target_retry',reason:last.status==='done'?'Dieses Projekt wurde bereits geprüft; 24 Stunden Pause vor erneuter Quellenprüfung.':'Technischer Abruffehler; Fehlerpause und Anbieter-Vorgaben abwarten.',until};
  const q=db.prepare("SELECT SUM(CASE WHEN created_at>=datetime('now','-1 hour') THEN 1 ELSE 0 END) hourly,SUM(CASE WHEN date(created_at)=date('now') THEN 1 ELSE 0 END) daily FROM online_requests").get();
  if((q.hourly??0)+10>SOURCE_LIMITS.hourlyRequests||(q.daily??0)+10>SOURCE_LIMITS.dailyRequests)return {code:'source_quota',reason:'Gemeinsames Abruflimit für öffentliche Quellen erreicht.',until:null,checkAt:at+60000};
  const n=db.prepare("SELECT (SELECT COUNT(*) FROM research_evidence)+(SELECT COALESCE(SUM(json_array_length(result,'$.sources')),0) FROM founder_target_reads WHERE result IS NOT NULL) evidence,(SELECT COUNT(*) FROM founder_target_reads) history").get();
  if(n.evidence+10>1000||n.history>=200)return {code:'research_capacity_review',reason:'Gespeicherte Rechercheergebnisse müssen vor weiteren Abrufen geprüft werden.',until:null,checkAt:at+60000};
  return null;
 }
 async function execute(ctx){
  ctx.assertActive();ctx.signal.throwIfAborted();
  const repo=evidencedRepo(ctx);
  const id=db.transaction(()=>{if(waitState(ctx))throw Error('Target research wait/cooldown or source review required');return Number(db.prepare("INSERT INTO founder_target_reads(repo,task_id,status,at_ms) VALUES(?,?,'running',?)").run(repo,ctx.task.id,now()).lastInsertRowid);}).immediate();
  const owner=repo.split('/')[0],base='https://api.github.com/repos/'+repo,web='https://github.com/'+repo,coverage=[],sources=[],observedAt=new Date(now()).toISOString();let calls=0;
  const read=async(url,{optional=false,text=false}={})=>{ctx.assertActive();ctx.signal.throwIfAborted();if(++calls>10)throw Error('Target source limit');const value=await publicJson(db,url,ctx.signal,request,undefined,text?s=>s:JSON.parse,{allowNotFound:optional});ctx.assertActive();ctx.signal.throwIfAborted();return value;};
  const add=(area,url,text,status='observed',partial=false)=>{
   coverage.push({area,url,status,partial});if(text===null)return;
   const full=clean(text),claim=paymentExcerpt(full)||'Public source returned no text; no payment conclusion.';
   sources.push({id:'target-'+digest(url+claim).slice(0,24),url,claim,digest:digest(claim),observedAt,verification:'reported',privacy:'public',truncated:full.length>4000});
  };
  const file=async(area,paths,r=repo)=>{
   for(const p of paths){const url='https://api.github.com/repos/'+r+(p==='readme'?'/readme':'/contents/'+p),v=await read(url,{optional:true});if(v===null)continue;
    if(v.type!=='file'||v.encoding!=='base64'||typeof v.content!=='string'||!Number.isSafeInteger(v.size)||v.size>200000||v.size<0||typeof v.path!=='string'||v.path.includes('..')||(p!=='readme'&&v.path!==p))throw Error('Invalid target file');
    let u;try{u=new URL(v.html_url);}catch{throw Error('Invalid target file identity');}
    if(u.origin!=='https://github.com'||u.username||u.password||u.search||u.hash||!u.pathname.startsWith('/'+r+'/blob/'))throw Error('Invalid target file identity');
    const text=Buffer.from(v.content,'base64').toString('utf8');if(Buffer.byteLength(text)>200000)throw Error('Target file too large');add(area,u.href,text);return;
   }add(area,'https://github.com/'+r,null,'not_found',true);
  };
  try{
   const meta=await read(base);if(meta.full_name!==repo||meta.private!==false)throw Error('Public target repository identity missing');
   add('repository',web,JSON.stringify({repository:meta.full_name,description:meta.description??null,archived:meta.archived===true,hasDiscussions:meta.has_discussions===true}));
   await file('readme',['readme']);await file('contributing',['CONTRIBUTING.md','.github/CONTRIBUTING.md','docs/CONTRIBUTING.md']);await file('funding',['.github/FUNDING.yml']);
   const issues=await read(base+'/issues?state=all&sort=updated&direction=desc&per_page=30');if(!Array.isArray(issues)||issues.length>30)throw Error('Invalid target issues');
   const rows=issues.map(i=>{if(!Number.isSafeInteger(i.number)||i.number<1||i.html_url!==web+(i.pull_request?'/pull/':'/issues/')+i.number)throw Error('Target issue identity mismatch');return {number:i.number,url:i.html_url,title:String(i.title??'').slice(0,500),body:String(i.body??'').slice(0,3000),state:i.state};});
   add('issues',web+'/issues',JSON.stringify(rows),'observed',true); // bounded first page, no exhaustive negative conclusion
   if(meta.has_discussions){const html=await read(web+'/discussions',{text:true});add('discussions',web+'/discussions',html,'observed',true);}else add('discussions',web+'/discussions',null,'disabled',false);
   const profile=await read('https://api.github.com/users/'+owner);if(profile.login!==owner||profile.html_url!=='https://github.com/'+owner)throw Error('Target owner identity mismatch');
   add('organisation','https://github.com/'+owner,JSON.stringify({name:profile.name??null,bio:profile.bio??null,blog:profile.blog??null,sponsorship:profile.hireable??null}));
   await file('organisation-readme',['profile/README.md'],owner+'/.github');
   ctx.assertActive();ctx.signal.throwIfAborted();
   const result={kind:'research',target:repo,researchGoal:ctx.task.input.title,requestedChecks:(ctx.task.input.consolidatedResearch??[]).map(x=>String(x.input?.title??'').slice(0,1000)),observedAt,processed:1,sources,coverage,checks:{publicSourcesOnly:true,claimsIndependentlyVerified:false,coverageComplete:false,paymentConfirmed:false,escrowConfirmed:false},limitations:'Bounded public source inspection; missing files, first-page limits, truncated text and discussion interface content cannot prove absence of payment or an escrow-backed assignment.'};
   db.prepare("UPDATE founder_target_reads SET status='done',result=? WHERE id=?").run(JSON.stringify(result),id);return result;
  }catch(error){const status=error?.diagnostic?.httpStatus,retryAfter=error?.diagnostic?.retryAfterMs??0,review=status===401||status===404||status===403&&!retryAfter||!!ctx.signal.aborted;db.prepare('UPDATE founder_target_reads SET status=?,retry_ms=? WHERE id=?').run(review?'review':'failed',review?null:now()+Math.max(900000,retryAfter),id);throw error;}
 }
 return {waitState,execute};
}
