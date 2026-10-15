import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(x);
const hash=x=>createHash('sha256').update(x).digest('hex');
const publicDiagnostic=raw=>{if(!raw)return null;const {accessRevision,...data}=JSON.parse(raw);return data;};
export function openFounderController({file,budget,adapters,maxWorkers=4}){
 if(!Number.isSafeInteger(maxWorkers)||maxWorkers<1||maxWorkers>4)throw Error('Worker limit invalid');
 const db=new Database(file);db.pragma('journal_mode=WAL');db.pragma('busy_timeout=5000');
 db.exec(`CREATE TABLE IF NOT EXISTS founder_control(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO founder_control(id,status,revision) VALUES(1,'stopped',0);
 CREATE TABLE IF NOT EXISTS founder_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,run_id TEXT,lease_ms INTEGER,owner_pid INTEGER,result TEXT,digest TEXT,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS founder_events(seq INTEGER PRIMARY KEY,at TEXT NOT NULL,task_id TEXT,action TEXT NOT NULL);`);
 const columns=new Set(db.prepare('PRAGMA table_info(founder_jobs)').all().map(c=>c.name));
 if(!db.prepare('PRAGMA table_info(founder_control)').all().some(c=>c.name==='generation'))db.exec('ALTER TABLE founder_control ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
 if(!columns.has('attempts'))db.exec('ALTER TABLE founder_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
 if(!columns.has('retryable'))db.exec('ALTER TABLE founder_jobs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0');
 if(!columns.has('next_retry_ms'))db.exec('ALTER TABLE founder_jobs ADD COLUMN next_retry_ms INTEGER');
 db.exec('CREATE TABLE IF NOT EXISTS founder_attempts(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,stage TEXT NOT NULL,diagnostic TEXT NOT NULL,receipt TEXT,result TEXT,at_ms INTEGER NOT NULL)');
 const active=new Map(),ticks=new Set();let closing=false,closePromise;
 const state=()=>db.prepare('SELECT status,revision,generation FROM founder_control WHERE id=1').get();
 const audit=(id,action)=>db.prepare('INSERT INTO founder_events(at,task_id,action) VALUES(?,?,?)').run(new Date().toISOString(),id,action);
 const update=(id,status,reason=null)=>{db.prepare('UPDATE founder_jobs SET status=?,reason=?,updated_ms=? WHERE id=?').run(status,reason,Date.now(),id);audit(id,status);};
 // Recover only expired or demonstrably dead processes, never another live owner.
 for(const row of db.prepare("SELECT * FROM founder_jobs WHERE status IN ('running','verifying')").all()){
  let alive=false;try{process.kill(row.owner_pid,0);alive=true;}catch{}
  if(!alive||row.lease_ms<Date.now()){
   const attempt=db.prepare('SELECT * FROM founder_attempts WHERE run_id=?').get(row.run_id);
   if(attempt?.receipt)budget.settle({id:row.run_id,...JSON.parse(attempt.receipt)});
   else if(attempt?.stage==='prepared')budget.settle({id:row.run_id,actualCostRappen:0,evidenceRef:`preflight:${row.run_id}`});
   update(row.id,'blocked',attempt?.result&&attempt.receipt?'Gespeichertes Ergebnis wird automatisch erneut geprüft.':'Unterbrochener Lauf: Ergebnis und Kosten müssen abgeglichen werden.');
  }
 }
 // Recover only explicit evidence. A missing paid receipt never means zero cost.
 for(const entry of budget.snapshot().entries??[]){
  if(entry.actualCostRappen!==null)continue;
  const attempt=db.prepare('SELECT receipt FROM founder_attempts WHERE run_id=?').get(entry.id);
  if(attempt?.receipt){budget.settle({id:entry.id,...JSON.parse(attempt.receipt)});continue;}
  if(entry.maxCostRappen===0){budget.settle({id:entry.id,actualCostRappen:0,evidenceRef:`local:${entry.id}`});}
 }
 function retryAllowed(row){
  const kind=JSON.parse(row.payload).kind,a=Object.hasOwn(adapters,kind)?adapters[kind]:null;
  if(!['blocked','failed'].includes(row.status)||!a||a.available===false||row.attempts>=3||/^(Budget|Kostenprüfung|Voraussetzung|Kein zugelassener)/.test(row.reason??''))return false;
  if(a.retrySafe===true&&a.maxCostRappen===0)return true;
  if(a.manualRetrySafe!==true||!row.run_id)return false;
  const b=budget.snapshot(),entries=b.entries??[],receipt=entries.find(e=>e.id===row.run_id),root=JSON.parse(row.payload).rootTaskId;
  return b.active&&receipt?.actualCostRappen!==null&&receipt?.actualCostRappen!==undefined&&b.entriesComplete!==false&&b.remainingRappen>=a.maxCostRappen&&b.dayRemainingRappen>=a.maxCostRappen&&entries.filter(e=>e.taskId===root).reduce((n,e)=>n+(e.actualCostRappen??e.maxCostRappen),0)+a.maxCostRappen<=b.taskRappen;
 }
 function snapshot(){return {...state(),taskCounts:Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM founder_jobs GROUP BY status').all().map(r=>[r.status,r.n])),observedAt:new Date().toISOString(),maxWorkers,activeWorkers:active.size,budget:budget.snapshot(),capabilities:Object.entries(adapters).map(([kind,a])=>({kind,status:a.available===false?'blocked':'available',reason:a.reason??null,maxCostRappen:a.maxCostRappen,lastSuccessAt:db.prepare("SELECT MAX(updated_ms) at FROM founder_jobs WHERE json_extract(payload,'$.kind')=? AND status='done'").get(kind).at,lastOutcome:db.prepare("SELECT status,updated_ms AS at FROM founder_jobs WHERE json_extract(payload,'$.kind')=? AND status IN ('done','failed','blocked') ORDER BY updated_ms DESC LIMIT 1").get(kind)??null})),tasks:db.prepare('SELECT id,payload,status,reason,run_id,digest,created_ms,updated_ms,attempts,next_retry_ms FROM founder_jobs ORDER BY created_ms DESC,id LIMIT 100').all().map(r=>({...r,...JSON.parse(r.payload),nextRetryAt:r.next_retry_ms,nextEligibleAt:Math.max(JSON.parse(r.payload).input?.notBefore??0,adapters[JSON.parse(r.payload).kind]?.nextReadyAt??0,r.next_retry_ms??0)||null,diagnostic:publicDiagnostic(db.prepare('SELECT diagnostic FROM founder_attempts WHERE run_id=?').get(r.run_id)?.diagnostic),retryAllowed:retryAllowed(r),retryMaxCostRappen:adapters[JSON.parse(r.payload).kind]?.maxCostRappen??null,payload:undefined})),audit:db.prepare('SELECT * FROM founder_events ORDER BY seq DESC LIMIT 60').all()};}
 const claim=db.transaction(()=>{
  if(closing||state().status!=='running')return [];
  for(const row of db.prepare("SELECT j.*,a.diagnostic AS attempt_diagnostic FROM founder_jobs j LEFT JOIN founder_attempts a ON a.run_id=j.run_id WHERE j.status IN ('failed','blocked') AND j.next_retry_ms IS NULL AND j.attempts<3").all()){
   const a=adapters[JSON.parse(row.payload).kind],d=JSON.parse(row.attempt_diagnostic??'null');
   const changedRequest=d?.httpStatus===400&&a?.requestRevision&&d.requestRevision!==a.requestRevision;
   const changedAccess=d?.code==='invalid_api_key'&&d.accessRevision&&a?.accessRevision&&d.accessRevision!==a.accessRevision;
   const freeRead=a?.retrySafe&&a.maxCostRappen===0;
   if((changedAccess||changedRequest||freeRead)&&retryAllowed(row))db.prepare('UPDATE founder_jobs SET next_retry_ms=? WHERE id=?').run(changedAccess||changedRequest?Date.now():row.updated_ms+60000,row.id);
  }
  for(const row of db.prepare("SELECT * FROM founder_jobs WHERE status IN ('failed','blocked') AND next_retry_ms IS NOT NULL AND next_retry_ms<=? AND attempts<3").all(Date.now())){
   if(adapters[JSON.parse(row.payload).kind]?.autoRetrySafe&&retryAllowed(row)){update(row.id,'queued');db.prepare('UPDATE founder_jobs SET next_retry_ms=NULL WHERE id=?').run(row.id);audit(row.id,'automatic-retry');}
  }
  for(const row of db.prepare("SELECT * FROM founder_jobs WHERE status='blocked' AND reason='Voraussetzung nicht erfolgreich abgeschlossen.'").all()){
   const deps=JSON.parse(row.payload).dependencies;
   if(deps.every(id=>db.prepare('SELECT status FROM founder_jobs WHERE id=?').get(id)?.status==='done'))update(row.id,'queued');
  }
  for(const row of db.prepare("SELECT id,payload FROM founder_jobs WHERE status='blocked' AND retryable=1 AND attempts<3").all()){
   const task=JSON.parse(row.payload),a=Object.hasOwn(adapters,task.kind)?adapters[task.kind]:null;
   if(a?.retrySafe&&a.maxCostRappen===0)update(row.id,'queued');
  }
  const capacityBudget=budget.snapshot();
  if(capacityBudget.active)for(const row of db.prepare("SELECT id,payload FROM founder_jobs WHERE status='blocked' AND reason='Budget daily limit' AND attempts<3").all()){
   const a=adapters[JSON.parse(row.payload).kind];if(a&&a.available!==false&&a.maxCostRappen<=Math.min(capacityBudget.remainingRappen,capacityBudget.dayRemainingRappen))update(row.id,'queued');
  }
  const running=db.prepare("SELECT payload FROM founder_jobs WHERE status IN ('running','verifying')").all();let capacity=maxWorkers-running.length;
  const locked=new Set(running.flatMap(r=>JSON.parse(r.payload).resources));const claimed=[];
  for(const row of db.prepare("SELECT * FROM founder_jobs WHERE status='queued' ORDER BY created_ms,id").all()){
   if(capacity<=0)break;const task=JSON.parse(row.payload),adapter=Object.hasOwn(adapters,task.kind)?adapters[task.kind]:undefined;
   if(Math.max(task.input?.notBefore??0,adapter?.nextReadyAt??0)>Date.now())continue;
   if(!adapter||adapter.available===false){update(row.id,'blocked',adapter?.reason??'Kein zugelassener Bearbeiter für diese Aufgabe.');continue;}
   const deps=task.dependencies.map(id=>db.prepare('SELECT status FROM founder_jobs WHERE id=?').get(id)?.status);
   if(deps.some(s=>['blocked','failed','cancelled'].includes(s))){update(row.id,'blocked','Voraussetzung nicht erfolgreich abgeschlossen.');continue;}
   if(deps.some(s=>s!=='done')||task.resources.some(r=>locked.has(r)))continue;
   const runId=randomUUID();
   try{const reservation=budget.reserve({id:runId,rootTaskId:task.rootTaskId,maxCostRappen:adapter.maxCostRappen});if(reservation.duplicate)throw Error('Duplicate run');}catch(e){update(row.id,'blocked',String(e.message).startsWith('Budget')?e.message:'Kostenprüfung nicht bestanden.');continue;}
   db.prepare("UPDATE founder_jobs SET status='running',attempts=attempts+1,retryable=0,run_id=?,owner_pid=?,lease_ms=?,updated_ms=? WHERE id=? AND status='queued'").run(runId,process.pid,Date.now()+180000,Date.now(),row.id);
   task.resources.forEach(r=>locked.add(r));capacity--;audit(row.id,'running');claimed.push({task,runId,adapter,generation:state().generation});
  }return claimed;
 });
 async function execute({task,runId,adapter,generation}){
  const abort=new AbortController();const record={abort,promise:null};active.set(task.id,record);
  const assertActive=()=>{const s=state();if(closing||abort.signal.aborted||!['running','paused'].includes(s.status)||s.generation!==generation)throw Error('Execution stopped');};
  const watcher=setInterval(()=>{try{assertActive();}catch{abort.abort();}},100);
  const timeout=setTimeout(()=>abort.abort(),120000);
  let dispatched=false,diagnostic={code:'preflight',requestRevision:adapter.requestRevision??null,accessRevision:adapter.accessRevision??null},settled=false,returned=false;
  if(adapter.providerTracked)db.prepare("INSERT INTO founder_attempts VALUES(?,?,'prepared',?,NULL,NULL,?)").run(runId,task.id,JSON.stringify(diagnostic),Date.now());
  const recordProviderEvent=e=>{
   if(!adapter.providerTracked)return;
   if(!['dispatch','response','receipt','rejected'].includes(e.stage))throw Error('Invalid provider stage');
   if(e.stage==='dispatch')dispatched=true;
   diagnostic={code:e.code??e.stage,requestRevision:e.requestRevision??adapter.requestRevision??null,parameter:e.parameter??null,accessRevision:diagnostic.accessRevision??null,httpStatus:e.httpStatus??diagnostic.httpStatus,requestId:e.requestId??diagnostic.requestId,clientRequestId:runId,retryable:e.retryable===true,retryAfterMs:e.retryAfterMs??0};
   // Persist receipt before touching the separate budget database; recovery is idempotent.
   db.prepare('UPDATE founder_attempts SET stage=?,diagnostic=?,receipt=COALESCE(?,receipt),at_ms=? WHERE run_id=?').run(e.stage,JSON.stringify(diagnostic),e.costReceipt?JSON.stringify(e.costReceipt):null,Date.now(),runId);
   if(e.costReceipt){budget.settle({id:runId,...e.costReceipt});settled=true;}
  };
  try{
   assertActive();const result=await adapter.execute({task,signal:abort.signal,assertActive,recordProviderEvent,grant:{reservationId:runId,maxCostRappen:adapter.maxCostRappen},dependencies:task.dependencies.map(id=>api.result(id))});returned=true;
   if(adapter.providerTracked){const payload=JSON.stringify(result);if(Buffer.byteLength(payload)<=262144)db.prepare('UPDATE founder_attempts SET result=?,receipt=COALESCE(?,receipt),at_ms=? WHERE run_id=?').run(payload,result?.costReceipt?JSON.stringify(result.costReceipt):null,Date.now(),runId);}
   // Account for actual provider response even if the operator stopped during the call.
   if(adapter.maxCostRappen===0)budget.settle({id:runId,actualCostRappen:0,evidenceRef:`local:${runId}`});
   else if(result?.costReceipt){budget.settle({id:runId,...result.costReceipt});settled=true;}
   else throw Error('Cost receipt missing');
   assertActive();update(task.id,'verifying');if(!await adapter.verify(result))throw Error('Verification failed');assertActive();
   const payload=JSON.stringify(result);if(Buffer.byteLength(payload)>262144)throw Error('Result too large');
   db.transaction(()=>{assertActive();db.prepare("UPDATE founder_jobs SET status='done',reason=NULL,result=?,digest=?,updated_ms=? WHERE id=? AND run_id=? AND status='verifying'").run(payload,hash(payload),Date.now(),task.id,runId);audit(task.id,'done');}).immediate();
  }catch(error){
   if(adapter.maxCostRappen===0){budget.settle({id:runId,actualCostRappen:0,evidenceRef:`local:${runId}`});settled=true;const code=['service_unauthorized','service_rate_limited','service_read_failed'].includes(error?.diagnostic?.code)?error.diagnostic.code:'local_read_failed';diagnostic={code,...(Number.isInteger(error?.diagnostic?.httpStatus)?{httpStatus:error.diagnostic.httpStatus}:{})};db.prepare("INSERT OR REPLACE INTO founder_attempts VALUES(?,?,'failed',?,?,NULL,?)").run(runId,task.id,JSON.stringify(diagnostic),JSON.stringify({actualCostRappen:0,evidenceRef:`local:${runId}`}),Date.now());}
   if(adapter.providerTracked){
    if(!dispatched&&!settled){budget.settle({id:runId,actualCostRappen:0,evidenceRef:`preflight:${runId}`});settled=true;}
    diagnostic={...diagnostic,code:diagnostic.code==='invalid_request_error'||diagnostic.code==='rejected'||diagnostic.code==='rate_limit_exceeded'||diagnostic.code==='insufficient_quota'||diagnostic.code==='invalid_api_key'||diagnostic.code==='provider_http_error'||diagnostic.code==='model_not_found'?diagnostic.code:returned?'verification_failed':!dispatched?'preflight_failed':settled?'response_processing_failed':'provider_outcome_unknown'};
    db.prepare('UPDATE founder_attempts SET diagnostic=?,at_ms=? WHERE run_id=?').run(JSON.stringify(diagnostic),Date.now(),runId);
   }
   const retryable=(abort.signal.aborted||adapter.reconcileSafe===true)&&adapter.retrySafe===true&&adapter.maxCostRappen===0;
   const auto=adapter.autoRetrySafe===true&&settled&&(returned||diagnostic.retryable===true||adapter.maxCostRappen===0)&&!closing&&!abort.signal.aborted;
   update(task.id,(abort.signal.aborted||retryable)?'blocked':'failed',auto?(adapter.maxCostRappen===0?'Dienstabruf fehlgeschlagen; keine Kostenreservierung. Wiederholung nach Abrufpause.':'Vorübergehender Modellfehler; automatische Wiederholung mit Kostenprüfung.'):retryable?'Lesender Lauf unterbrochen; Fortsetzen erlaubt höchstens drei Versuche.':abort.signal.aborted?'Bearbeitung unterbrochen; keine automatische Wiederholung.':adapter.maxCostRappen===0?'Dienstabruf fehlgeschlagen; keine Kostenreservierung.':settled?'Bearbeitung oder Ergebnisprüfung fehlgeschlagen; Kosten abgeglichen.':'Bearbeitung fehlgeschlagen; Anbieterausgang und Kosten noch ungeklärt.');
   if(returned&&settled&&adapter.providerTracked&&(closing||abort.signal.aborted))update(task.id,'blocked','Gespeichertes Ergebnis wird automatisch erneut geprüft.');
   const attempts=db.prepare('SELECT attempts FROM founder_jobs WHERE id=?').get(task.id).attempts;
   db.prepare('UPDATE founder_jobs SET retryable=?,next_retry_ms=? WHERE id=?').run(Number(retryable),auto&&attempts<3?Date.now()+Math.max(diagnostic.retryAfterMs??0,60000*2**(attempts-1)):null,task.id);
  }
  finally{clearInterval(watcher);clearTimeout(timeout);active.delete(task.id);}
 }
 async function recoverResults(){
  if(closing||state().status!=='running')return;
  for(const row of db.prepare("SELECT j.*,a.result AS saved_result FROM founder_jobs j JOIN founder_attempts a ON a.run_id=j.run_id WHERE j.status='blocked' AND j.reason='Gespeichertes Ergebnis wird automatisch erneut geprüft.' AND a.result IS NOT NULL AND a.receipt IS NOT NULL").all()){
   const adapter=adapters[JSON.parse(row.payload).kind],generation=state().generation;
   if(!adapter?.providerTracked||adapter.available===false)continue;
   if(closing||state().status!=='running')break;
   update(row.id,'verifying');db.prepare('UPDATE founder_jobs SET owner_pid=?,lease_ms=? WHERE id=?').run(process.pid,Date.now()+180000,row.id);
   try{
    if(Buffer.byteLength(row.saved_result)>262144||!await adapter.verify(JSON.parse(row.saved_result)))throw Error('Invalid saved result');
    if(closing||state().generation!==generation||!['running','paused'].includes(state().status)){update(row.id,'blocked','Gespeichertes Ergebnis wird automatisch erneut geprüft.');continue;}
    db.prepare("UPDATE founder_jobs SET status='done',reason=NULL,result=?,digest=?,next_retry_ms=NULL,updated_ms=? WHERE id=?").run(row.saved_result,hash(row.saved_result),Date.now(),row.id);audit(row.id,'recovered-verified-result');
   }catch{
    update(row.id,'failed','Gespeichertes Ergebnis hat die erneute Prüfung nicht bestanden.');
    if(adapter.autoRetrySafe&&row.attempts<3)db.prepare('UPDATE founder_jobs SET next_retry_ms=? WHERE id=?').run(Date.now()+60000,row.id);
   }
  }
 }
 const api={
  databaseFile:file,
  controlState:()=>({...state(),activeWorkers:active.size}),
  enqueue:db.transaction(input=>{
   if(!input||Object.keys(input).sort().join(',')!=='dependencies,id,input,kind,resources,rootTaskId'||!validId(input.id)||!validId(input.rootTaskId)||!validId(input.kind)||!Array.isArray(input.dependencies)||input.dependencies.length>20||!input.dependencies.every(validId)||input.dependencies.includes(input.id)||!Array.isArray(input.resources)||input.resources.length>10||!input.resources.every(validId))throw Error('Invalid task');
   const payload=JSON.stringify(input);if(Buffer.byteLength(payload)>20000)throw Error('Task too large');const old=db.prepare('SELECT payload FROM founder_jobs WHERE id=?').get(input.id);if(old){if(old.payload!==payload)throw Error('Conflicting task');return input.id;}
   if(db.prepare('SELECT COUNT(*) n FROM founder_jobs').get().n>=5000)throw Error('Task capacity reached');
   db.prepare("INSERT INTO founder_jobs(id,payload,status,created_ms,updated_ms) VALUES(?,?,'queued',?,?)").run(input.id,payload,Date.now(),Date.now());audit(input.id,'queued');return input.id;
  }).immediate,
  control:db.transaction((action,revision=state().revision)=>{
   const s=state();if(action!=='emergency-stop'&&s.revision!==revision)throw Error('Controller changed');
   let next={start:'running',resume:'running',pause:'paused',stop:'stopped','emergency-stop':'emergency_stopped'}[action];
   const allowed={start:['stopped','emergency_stopped'],resume:['paused'],pause:['running'],stop:['running','paused','stopped','emergency_stopped'],'emergency-stop':['running','paused','stopped','emergency_stopped']};
   if(!next||!allowed[action].includes(s.status))throw Error('Invalid control transition');
   if(action==='stop'&&s.status==='emergency_stopped')next='emergency_stopped';
   const aborting=['stop','emergency-stop'].includes(action);
   db.prepare('UPDATE founder_control SET status=?,revision=revision+1,generation=generation+? WHERE id=1').run(next,Number(aborting));
   if(aborting)for(const a of active.values())a.abort.abort();audit(null,action);return snapshot();
  }).immediate,
  tick(){if(closing)return Promise.resolve([]);const p=(async()=>{await recoverResults();const jobs=claim.immediate();const promises=jobs.map(job=>{const p=execute(job);const a=active.get(job.task.id);if(a)a.promise=p;return p;});return Promise.allSettled(promises);})();ticks.add(p);p.then(()=>ticks.delete(p),()=>ticks.delete(p));return p;},
  snapshot,
  planningHistory(){return db.prepare('SELECT id,payload,status,updated_ms FROM founder_jobs ORDER BY created_ms DESC,id LIMIT 5000').all().map(r=>({...r,...JSON.parse(r.payload),payload:undefined}));},
  hasTask(id){if(!validId(id))throw Error('Invalid task');return !!db.prepare('SELECT 1 FROM founder_jobs WHERE id=?').get(id);},
  retry:db.transaction((id,updatedMs)=>{if(!validId(id)||!Number.isSafeInteger(updatedMs))throw Error('Invalid retry');const row=db.prepare('SELECT * FROM founder_jobs WHERE id=?').get(id);if(!row||row.updated_ms!==updatedMs||!retryAllowed(row))throw Error('Retry unavailable');update(id,'queued');return snapshot();}).immediate,
  result(id){if(!validId(id))throw Error('Invalid result');const r=db.prepare("SELECT result,digest FROM founder_jobs WHERE id=? AND status='done'").get(id);if(!r||hash(r.result)!==r.digest)throw Error('Result unavailable');return JSON.parse(r.result);},
  close(){if(closePromise)return closePromise;closing=true;for(const a of active.values())a.abort.abort();closePromise=(async()=>{await Promise.allSettled([...ticks,...[...active.values()].map(a=>a.promise)]);db.close();})();return closePromise;}
 };return api;
}
