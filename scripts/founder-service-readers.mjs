import fs from 'node:fs';import path from 'node:path';import Database from 'better-sqlite3';import {createHash} from 'node:crypto';
const kinds=['github-orders','gmail-orders','calendar-deadlines','amplitude-metrics'];
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function createServiceReaders({directory,access=()=>({available:false}),request=fetch,now=()=>Date.now(),registry=[]}){
 fs.mkdirSync(directory,{recursive:true});const db=new Database(path.join(directory,'readers.db'));db.pragma('journal_mode=WAL');db.pragma('busy_timeout=5000');
 db.exec('CREATE TABLE IF NOT EXISTS service_reads(kind TEXT PRIMARY KEY,at INTEGER NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,cursor INTEGER NOT NULL DEFAULT 0)');
 if(!db.prepare('PRAGMA table_info(service_reads)').all().some(c=>c.name==='success_at'))db.exec('ALTER TABLE service_reads ADD COLUMN success_at INTEGER');
 db.exec("CREATE TABLE IF NOT EXISTS reader_progress(kind TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS related_links(provider TEXT,external_id TEXT,own_id TEXT,proof TEXT,PRIMARY KEY(provider,external_id))");
 const correlate=(provider,externalId,text)=>{
  const urls=[...String(text).matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/[1-9]\d*(?=[#?\s<>\)\]]|$)/g)].map(m=>m[0]);
  const matches=registry.filter(r=>r.provider==='github'&&urls.includes('https://github.com/'+r.externalId));
  const old=db.prepare('SELECT * FROM related_links WHERE provider=? AND external_id=?').get(provider,externalId);
  if(matches.length>1||(old&&matches.length===1&&old.own_id!==matches[0].id))return null;
  if(matches.length===1){const proof='https://github.com/'+matches[0].externalId;db.prepare('INSERT OR IGNORE INTO related_links VALUES(?,?,?,?)').run(provider,externalId,matches[0].id,proof);return {ownOrderId:matches[0].id,proof};}
  return old&&registry.some(r=>r.id===old.own_id)?{ownOrderId:old.own_id,proof:old.proof}:null;
 };
 const related=(provider,externalId,link,payload,observedAt)=>link?{provider,externalId,ownOrderId:link.ownOrderId,revision:digest(payload),kind:'observation',observedAt,payload:{...payload,linkProof:link.proof,assignmentConfirmed:false,acceptanceConfirmed:false,paymentConfirmed:false,privacy:'private'}}:null;
 const configured=kind=>{const a=access(kind);if(kind==='github-orders')return registry.length>0;if(!a?.available||typeof a.credential!=='string'||!a.credential)return false;
 if(kind==='gmail-orders')return a.scope?.account==='numaronia@gmail.com'&&/^Label_[\w-]+$/.test(a.scope?.labelId??'');
 if(kind==='calendar-deadlines')return a.scope?.account==='numaronia@gmail.com'&&typeof a.scope?.calendarId==='string'&&a.scope.calendarId!=='primary'&&a.scope.calendarId.length<300;
 return /^\d+$/.test(String(a.scope?.projectId??''))&&['us','eu'].includes(a.scope?.region);};
 const get=async(url,headers,ctx)=>{ctx.assertActive();const res=await request(url,{method:'GET',redirect:'error',headers,signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(15000)])});
 if(!res.ok){const error=Error('Service unavailable');error.status=res.status;throw error;}
 if(!res.body)throw Error('Empty service response');const reader=res.body.getReader(),parts=[];let bytes=0;try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>200000)throw Error('Service response limit');parts.push(r.value);}}finally{await reader.cancel();}return JSON.parse(Buffer.concat(parts).toString('utf8'));};
 const adapters=Object.fromEntries(kinds.map(kind=>[kind,{get available(){return configured(kind);},get nextReadyAt(){return db.prepare('SELECT next_at FROM service_reads WHERE kind=?').get(kind)?.next_at??0;},get reason(){return configured(kind)?null:access(kind)?.reason??'Eigener Dienstzugang oder freigegebener Arbeitsbereich fehlt.';},maxCostRappen:0,retrySafe:true,autoRetrySafe:true,
 async execute(ctx){ctx.assertActive();if(!configured(kind))throw Error('Service access missing');const a=access(kind),at=now();
 const cursor=db.transaction(()=>{const previous=db.prepare('SELECT * FROM service_reads WHERE kind=?').get(kind);if(previous?.next_at>at)throw Error('Service cooldown');db.prepare("INSERT INTO service_reads(kind,at,status,next_at) VALUES(?,?,'attempting',?) ON CONFLICT(kind) DO UPDATE SET at=excluded.at,status=excluded.status,next_at=excluded.next_at").run(kind,at,at+3600000);return previous?.cursor??0;}).immediate();
 try{let data,evidence=[];const observedAt=new Date(at).toISOString();
 if(kind==='github-orders'){
  const own=registry.filter(r=>r.provider==='github'&&/^[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(r.externalId));if(!own.length)throw Error('Own registry missing');
  for(let i=0;i<Math.min(2,own.length);i++){const r=own[(cursor+i)%own.length],parts=r.externalId.split('/'),base=`https://api.github.com/repos/${parts[0]}/${parts[1]}`,headers={'Accept':'application/vnd.github+json','User-Agent':'Numaron-Founder','X-GitHub-Api-Version':'2022-11-28'};const p=await get(`${base}/pulls/${parts[3]}`,headers,ctx);
   if(p.number!==Number(parts[3])||!['open','closed'].includes(p.state))throw Error('GitHub identity mismatch');
   const failures=[];const optional=async(name,url)=>{try{return await get(url,headers,ctx);}catch{failures.push(name);return null;}};
   const comments=await optional('comments',`${base}/issues/${parts[3]}/comments?per_page=30`),reviews=await optional('reviews',`${base}/pulls/${parts[3]}/reviews?per_page=30`),ci=/^[a-f0-9]{40}$/.test(p.head?.sha??'')?await optional('ci',`${base}/commits/${p.head.sha}/check-runs?per_page=30`):null;
   const payload={state:p.state,merged:p.merged===true,author:p.user?.login??null,acceptanceConfirmed:false,compensationConfirmed:false,paymentConfirmed:false,comments:Array.isArray(comments)?comments.slice(0,30).map(c=>({id:c.id,author:c.user?.login,association:c.author_association,body:String(c.body??'').slice(0,1000),updatedAt:c.updated_at})):null,reviews:Array.isArray(reviews)?reviews.slice(0,30).map(c=>({id:c.id,author:c.user?.login,state:c.state,body:String(c.body??'').slice(0,1000)})):null,ci:Array.isArray(ci?.check_runs)?ci.check_runs.slice(0,30).map(c=>({id:c.id,name:c.name,status:c.status,conclusion:c.conclusion})):null,partial:failures.length>0||!Array.isArray(comments)||!Array.isArray(reviews)||!Array.isArray(ci?.check_runs)||comments?.length===30||reviews?.length===30||ci?.total_count>30,failures};evidence.push({provider:'github',externalId:r.externalId,revision:digest(payload),ownOrderId:r.id,kind:'observation',observedAt,payload});
  }data={checked:evidence.length,partial:evidence.some(e=>e.payload.partial)};db.prepare('UPDATE service_reads SET cursor=? WHERE kind=?').run((cursor+Math.min(2,own.length))%own.length,kind);
 }else if(kind==='gmail-orders'){
  const url=`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(a.scope.account)}/messages?labelIds=${encodeURIComponent(a.scope.labelId)}&maxResults=20&includeSpamTrash=false`;
  const progress=JSON.parse(db.prepare('SELECT payload FROM reader_progress WHERE kind=?').get(kind)?.payload??'{}');
  let pending=progress.pending??[],nextPageToken=progress.nextPageToken??null;
  if(!pending.length){const r=await get(url+(nextPageToken?'&pageToken='+encodeURIComponent(nextPageToken):''),{Authorization:`Bearer ${a.credential}`},ctx);if(r.messages!==undefined&&!Array.isArray(r.messages))throw Error('Gmail schema');pending=r.messages??[];nextPageToken=r.nextPageToken??null;}
  const batch=pending.slice(0,5),messages=[],deadlineProposals=[];
  for(const item of batch){
   if(!/^[a-f0-9]{1,40}$/i.test(item.id??''))continue;
   const msg=await get(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(a.scope.account)}/messages/${item.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID&metadataHeaders=Archived-At&metadataHeaders=List-Archive`,{Authorization:`Bearer ${a.credential}`},ctx);
   if(msg.id!==item.id||!msg.labelIds?.includes(a.scope.labelId))continue;
   const subject=String(msg.payload?.headers?.find(h=>h.name.toLowerCase()==='subject')?.value??'').slice(0,500);
   const link=correlate('gmail',msg.threadId,(msg.payload?.headers??[]).filter(h=>['archived-at','list-archive'].includes(h.name.toLowerCase())).map(h=>h.value).join(' '));
   const ownOrderId=link?.ownOrderId??null,payload={id:msg.id,threadId:msg.threadId,ownOrderId,subject,assignmentConfirmed:false};messages.push(payload);
   const e=related('gmail',msg.id,link,payload,observedAt);if(e)evidence.push(e);
   for(const date of subject.match(/\b20\d{2}-\d{2}-\d{2}\b/g)??[])if(Number.isFinite(Date.parse(date)))deadlineProposals.push({date,sourceMessageId:msg.id,ownOrderId,confirmed:false,reason:'Date in subject; deadline meaning requires verification'});
  }
  pending=pending.slice(5);db.prepare('INSERT INTO reader_progress VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload').run(kind,JSON.stringify({pending,nextPageToken}));
  data={messageIds:batch.map(x=>x.id),messages,deadlineProposals,partial:!!nextPageToken||pending.length>0,contentRead:false,metadataOnly:true};
 }else if(kind==='calendar-deadlines'){
  const url=`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(a.scope.calendarId)}/events?maxResults=20&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(observedAt)}`;
  const r=await get(url,{Authorization:`Bearer ${a.credential}`},ctx);if(!Array.isArray(r.items))throw Error('Calendar schema');
  const events=r.items.slice(0,20).map(e=>{const link=correlate('calendar',e.id,e.description??''),payload={id:e.id,start:e.start,end:e.end,status:e.status,ownOrderId:link?.ownOrderId??null,deadlineConfirmed:false};const observation=related('calendar',e.id,link,payload,observedAt);if(observation)evidence.push(observation);return payload;});
  const conflicts=[];for(let i=0;i<events.length;i++)for(let j=i+1;j<events.length;j++){const a=events[i],b=events[j],time=x=>Date.parse(x?.dateTime??x?.date);if(a.status!=='cancelled'&&b.status!=='cancelled'&&time(a.start)<time(b.end)&&time(b.start)<time(a.end))conflicts.push({eventIds:[a.id,b.id],confirmedSchedulingOverlap:true,orderDeadlineConfirmed:false});}
  data={events,conflicts,partial:!!r.nextPageToken};
 }else{
  const host=a.scope.region==='eu'?'analytics.eu.amplitude.com':'amplitude.com';const r=await get(`https://${host}/api/2/events/list`,{Authorization:`Basic ${a.credential}`},ctx);if(!Array.isArray(r.data))throw Error('Amplitude schema');data={projectId:a.scope.projectId,events:r.data.slice(0,100).map(e=>({name:e.display??e.value,total:e.totals})),partial:r.data.length>100,status:r.data.length?'observed':'no-data'};
 }
 db.prepare("UPDATE service_reads SET status='succeeded',success_at=? WHERE kind=?").run(at,kind);return {kind,observedAt,privacy:kind==='github-orders'?'public':'private',data,evidence,sources:kind==='github-orders'?evidence.map(e=>({id:'order-'+e.revision.slice(0,24),url:'https://github.com/'+e.externalId,claim:JSON.stringify(e.payload).slice(0,4000),observedAt,verification:'reported',digest:e.revision})):[]};
 }catch(error){const status=error.status===401?'unauthorized':error.status===429?'rate-limited':'failed';db.prepare('UPDATE service_reads SET status=?,next_at=? WHERE kind=?').run(status,at+(error.status===401?86400000:3600000),kind);throw Object.assign(Error('Service read failed'),{diagnostic:{code:error.status===401?'service_unauthorized':error.status===429?'service_rate_limited':'service_read_failed',...(Number.isInteger(error.status)?{httpStatus:error.status}:{})}});}
 },verify:r=>r?.kind===kind&&Number.isFinite(Date.parse(r.observedAt))&&r.data&&Array.isArray(r.evidence)}]));
 return {adapters,status:()=>kinds.map(kind=>({kind,available:configured(kind),last:db.prepare('SELECT at,status,next_at FROM service_reads WHERE kind=?').get(kind)??null,lastSuccessfulAt:db.prepare('SELECT success_at FROM service_reads WHERE kind=?').get(kind)?.success_at??null})),close(){db.close();}};
}
