import {createSplitPrivateAdapters,appendPrivateLessons} from './founder-private-split.mjs';
import os from 'node:os';
import {createLocalAccessCache,readLocalCredential} from './founder-local-access.mjs';
import {founderMethods,pluginReadiness} from './founder-methods.mjs';
import fs from 'node:fs';import path from 'node:path';
import {createHash} from 'node:crypto';
import {openFounderBudget} from './founder-budget.mjs';
import {openFounderController} from './founder-controller.mjs';
import {openFounderKnowledge,planFounderWork,admissibleResearchSources} from './founder-knowledge.mjs';
import {createFounderResearch} from './founder-research.mjs';
import {createFounderWorker} from './founder-worker.mjs';
import {readFounderReports} from './founder-operations.mjs';
import {createFounderFinanceAdapter} from './founder-finance.mjs';
import {createFounderConnectors} from './founder-connectors.mjs';
import {readSofaCredential} from './founder-sofa-key.mjs';
import {createFounderPlanner,validatePlan} from './founder-planner.mjs';
import {openFounderOrders} from './founder-orders.mjs';
import {loadOwnOrderRegistry} from './founder-order-registry.mjs';
import {createServiceReaders} from './founder-service-readers.mjs';
import {openFounderDelivery} from './founder-delivery.mjs';
import Database from 'better-sqlite3';
import {createGoogleAccessManager} from './founder-google-access.mjs';
import {autonomyStatus} from './founder-autonomy-status.mjs';
import {createOrderFlow} from './founder-order-flow.mjs';
export function openFounderRuntime({base,directory=path.join(base,'artifacts/founder-autonomy-20261013'),apiKey,getApiKey,mission,stripeKeyFile,adapters:overrides,orderFlow:providedOrderFlow,activate=false,onError,isEnabled=()=>true}){
 fs.mkdirSync(directory,{recursive:true});
 const budget=openFounderBudget(path.join(directory,'budget.db')),knowledge=openFounderKnowledge(path.join(directory,'knowledge.db'));
 const orders=openFounderOrders(path.join(directory,'orders.db')),registry=loadOwnOrderRegistry(base);for(const r of registry)orders.register(r);
 const workflow=new Database(path.join(directory,'workflow.db'));workflow.pragma('journal_mode=WAL');workflow.exec('CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,payload TEXT NOT NULL,at INTEGER NOT NULL)');
 const googleAccess=overrides?null:createGoogleAccessManager({isActive:()=>isEnabled()&&controller.controlState().status==='running'});
 const localDirectory=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData/Local'),'Numaron');
 const amplitudeAccess=overrides?null:createLocalAccessCache({file:path.join(localDirectory,'amplitude-access.dpapi'),read:()=>readLocalCredential('service',{provider:'amplitude',directory:localDirectory})});
 const delivery=openFounderDelivery({directory:path.join(directory,'deliveries'),access:()=>googleAccess?.current()??{available:false}});
 const readers=overrides?null:createServiceReaders({directory:path.join(directory,'services'),registry,access:kind=>kind==='amplitude-metrics'?amplitudeAccess.current():googleAccess.current()});
 const initial=!budget.snapshot().startAt;
 if(activate&&initial)budget.activate({startAt:Date.now(),authorizationRef:'patrice:2026-10-15:CHF150-30days:CHF20-day:CHF2.50-task'});
 const research=overrides?null:createFounderResearch({directory:path.join(directory,'research')});
 const connectors=overrides?null:createFounderConnectors({directory:path.join(directory,'connectors'),sofaKey:readSofaCredential()});
 const orderFlow=providedOrderFlow??(overrides?null:createOrderFlow({directory:path.join(directory,'code-orders'),apiKey,getApiKey,mission,onSubmitted:r=>{
  const p=r.prepared,url=r.submission.url,externalId=url.slice('https://github.com/'.length),id='code-'+p.id;
  const provenance=`artifacts/founder-code-order-${p.id}/completion.json`,file=path.join(base,provenance);
  if(!fs.existsSync(file)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({owner:'tricebr',pullRequest:url,issue:p.url,submissionConfirmed:true,acceptanceConfirmed:false,paymentConfirmed:false},null,2),{flag:'wx'});}
  const registration={id,provider:'github',externalId,owner:'tricebr',provenance};orders.register(registration);if(!registry.some(x=>x.id===id))registry.push(registration);
  orders.ingest({provider:'github',externalId,revision:p.id,ownOrderId:id,kind:'delivery',observedAt:p.observedAt,payload:{url,submissionConfirmed:true,acceptanceConfirmed:false,paymentConfirmed:false}});
 }}));
 const adapters=overrides?Object.fromEntries(Object.entries(overrides).map(([kind,a])=>[kind,Object.defineProperties({},Object.getOwnPropertyDescriptors(a))])):{
  research,...connectors.adapters,...readers.adapters,
  'work-planner':createFounderPlanner({apiKey,getApiKey,mission}),
  'private-analysis':createFounderWorker({apiKey,getApiKey,mission}),
  'private-draft':createFounderWorker({apiKey,getApiKey,mission,purpose:'deliverable'}),
  'drive-output':{get available(){const a=googleAccess.current();return a.available&&!!a.scope.folderId;},reason:'Eigener Google-Zugang und numaron-Ausgabeordner erforderlich.',maxCostRappen:0,retrySafe:true,reconcileSafe:true,async execute(ctx){const r=await delivery.publish(ctx.task.input.operationId,ctx);const {content,...metadata}=r;return {kind:'drive-output',privacy:'private',...metadata};},verify:r=>r?.remoteStatus==='verified'&&!!r.remoteId},
  'order-report':{maxCostRappen:0,retrySafe:true,async execute({assertActive}){assertActive();return {kind:'order-report',observedAt:new Date().toISOString(),report:readFounderReports(base).orders};},verify:r=>['recent','partial','stale'].includes(r.report?.status)},
  'finance-report':createFounderFinanceAdapter({file:stripeKeyFile}),
  'code-execution':{available:false,maxCostRappen:0,reason:'Automatischer Code-Worker mit geprüfter Offline-Isolation noch nicht verbunden.'},
  'external-communication':{available:false,maxCostRappen:0,reason:'Empfänger- und Auftragsrahmen für autonome Nachrichten noch nicht festgelegt.'},
  'live-trading':{available:false,maxCostRappen:0,reason:'Kein Handelskapital oder Verlustlimit durch das Betriebsbudget zugeteilt.'}
 };
 if(!overrides)Object.assign(adapters,createSplitPrivateAdapters({apiKey,getApiKey,mission}));
 for(const kind of ['private-analysis','private-draft','private-part'])if(adapters[kind]){const original=adapters[kind].execute;adapters[kind].execute=async ctx=>{const k=knowledge.snapshot();const dependencies=ctx.dependencies.map(r=>({...r,sources:admissibleResearchSources(r.sources??[],k)}));if(!dependencies.some(r=>r.sources.length))throw Error('Fresh uncontradicted evidence unavailable');const lessons=k.filter(r=>r.id.startsWith('sofa-')&&!r.stale&&r.verification!=='contradicted').sort((a,b)=>b.observedAt-a.observedAt).slice(0,2).map(r=>({id:r.id,url:r.sources[0],claim:`Ungeprüfter technischer Lösungsansatz, kein Nachfragebeleg: ${r.claim}`,observedAt:new Date(r.observedAt).toISOString()}));return original({...ctx,dependencies:appendPrivateLessons(dependencies,lessons,ctx.task)});};}
 Object.assign(adapters,orderFlow?.adapters??{});
 const controller=openFounderController({file:path.join(directory,'controller.db'),budget,adapters});
 if(activate&&initial&&isEnabled())controller.control('start');
 let current=null,closed=false,timer,error=null;
 const snapshot=()=>{const s=controller.snapshot();const cs=connectors?.status()??[];const plugins=pluginReadiness.map(p=>{const serviceKind={GitHub:'github-orders',Amplitude:'amplitude-metrics'}[p.name];const service=serviceKind?readers?.status().find(r=>r.kind===serviceKind):null;const drive=p.name==='Google Drive'?s.capabilities.find(c=>c.kind==='drive-output'):null;if(service)return {...p,runtimeConnected:service.available&&service.last?.status==='succeeded',runtimeStatus:!service.available?'Dienstzugang fehlt':service.last?.status==='succeeded'?'Letzter eigener Dienstabruf erfolgreich.':'Letzter eigener Dienstabruf nicht erfolgreich.',lastCheckedAt:service.last?new Date(service.last.at).toISOString():null};if(drive)return {...p,runtimeConnected:drive.status!=='blocked'&&!!drive.lastSuccessAt,runtimeStatus:drive.status==='blocked'?drive.reason:drive.lastSuccessAt?'Private Drive-Ablage durch Lauf belegt.':'Drive eingerichtet; erfolgreicher Lauf noch offen.',lastCheckedAt:drive.lastOutcome?new Date(drive.lastOutcome.at).toISOString():null};const c=cs.find(c=>c.kind===`${p.name.toLowerCase()}-research`);return c?{...p,runtimeConnected:c.available&&c.last?.status==='succeeded',runtimeStatus:!c.available?c.reason:c.last?.status==='succeeded'?'Direkter Dienstaufruf erfolgreich; kostenloser Lesezugang.':c.last?'Letzter direkter Versuch nicht erfolgreich.':'Direkter Adapter eingerichtet; erfolgreicher Lauf noch offen.',lastCheckedAt:c.last?new Date(c.last.at).toISOString():null}:p;});return {...s,autonomyContract:autonomyStatus(s),methods:founderMethods.map(({guidance,...m})=>m),plugins,knowledge:knowledge.snapshot(),schedulerError:error,scope:'Autonome öffentliche Recherche, private Analyse und lesende Bestandsberichte. Keine verbindliche Auftragsannahme.',capabilities:s.capabilities.map(c=>({...c,status:c.status==='blocked'?'blocked':c.lastSuccessAt?'verified':'configured'}))};};
 const api={controlState:()=>controller.controlState(),snapshot:()=>({...snapshot(),codeOrders:orderFlow?.status()??null,services:readers?.status()??[],orders:orders.snapshot(),deliveries:delivery.snapshot(),decisions:workflow.prepare('SELECT id,payload,at FROM decisions ORDER BY at DESC LIMIT 30').all().map(r=>({...r,decision:JSON.parse(r.payload),payload:undefined})),googleBillingAllowed:false}),result:id=>controller.result(id),
  checkLocalReadiness:()=>orderFlow?.probeIsolation?.(),
  archive:input=>controller.archive(input),
  retry(input){if(!input||Object.keys(input).sort().join(',')!=='id,updatedMs')throw Error('Invalid retry');controller.retry(input.id,input.updatedMs);return snapshot();},
  control(input){if(!input||Object.keys(input).sort().join(',')!=='action,revision'||!Number.isSafeInteger(input.revision))throw Error('Invalid control');controller.control(input.action,input.revision);return snapshot();},
  async cycle(){
   if(closed||!isEnabled())return;if(current)return current;
   current=(async()=>{
    let s=controller.snapshot();if(s.status!=='running'||!s.budget.active)return;
    await Promise.all([googleAccess?.refresh(),amplitudeAccess?.refresh()]);if(!isEnabled()||controller.controlState().status!=='running')return;s=controller.snapshot();s.tasks=controller.planningHistory();
    for(const task of planFounderWork({completed:s.tasks.map(t=>t.id),capabilities:s.capabilities,observations:s.tasks,budget:s.budget,knowledge:knowledge.snapshot()}))if(!controller.hasTask(task.id))controller.enqueue(task);
    const known=new Set(knowledge.snapshot().map(k=>k.id));
    for(const t of s.tasks.filter(t=>t.status==='done'&&['research','exa-research','firecrawl-research','sofa-research','github-orders'].includes(t.kind))){
     const r=controller.result(t.id);
     for(const source of r.sources??[]){const observedAt=Date.parse(source.observedAt);if(known.has(source.id)||!Number.isFinite(observedAt)||observedAt>Date.now()+1000)continue;knowledge.record({id:source.id,claim:String(source.claim).slice(0,5000),sources:[source.url],observedAt,expiresAt:observedAt+7*86400000,verification:'reported'});known.add(source.id);}
     if(t.kind==='exa-research'){const id=`firecrawl-${t.id}`;if(adapters['firecrawl-research']&&adapters['firecrawl-research'].available!==false&&!controller.hasTask(id))controller.enqueue({id,rootTaskId:t.rootTaskId,kind:'firecrawl-research',input:{title:'Eine gefundene öffentliche Quelle vertiefen'},dependencies:[t.id],resources:['firecrawl']});continue;}
     if(t.kind==='sofa-research')continue;
     const fingerprint=createHash('sha256').update(JSON.stringify(r.sources.map(x=>[x.id,x.digest??x.claim]).sort())).digest('hex').slice(0,32),id=`analysis-${fingerprint}`;
     if(adapters['work-planner']?.available!==false&&adapters['work-planner']){const pid=`plan-${fingerprint}`;if(!controller.hasTask(pid))controller.enqueue({id:pid,rootTaskId:t.rootTaskId,kind:'work-planner',input:{title:'Gemäß Genesis nächste sinnvolle Arbeit auswählen oder begründet warten'},dependencies:[t.id],resources:['planner']});continue;}
     if(adapters['private-analysis']&&adapters['private-analysis'].available!==false&&admissibleResearchSources(r.sources??[],knowledge.snapshot()).length&&!controller.hasTask(id))controller.enqueue({id,rootTaskId:t.rootTaskId,kind:'private-analysis',input:{title:'Aus öffentlichen Quellen eine konkrete Arbeitschance auswählen und ihre Grenzen erklären'},dependencies:[t.id],resources:[]});
    }
    for(const t of s.tasks.filter(t=>t.status==='done'&&t.kind==='private-analysis'&&!adapters['work-planner'])){
     const id=`draft-${t.id}`;if(adapters['private-draft']&&adapters['private-draft'].available!==false&&!controller.hasTask(id))controller.enqueue({id,rootTaskId:t.rootTaskId,kind:'private-draft',input:{title:'Aus der ausgewählten Chance eine nutzbare private Arbeitsvorlage erstellen'},dependencies:[t.id],resources:[]});
    }
    for(const t of s.tasks.filter(t=>t.status==='done')){
     if(workflow.prepare('SELECT 1 FROM decisions WHERE id=?').get(t.id))continue;const r=controller.result(t.id);
     if(['github-orders','gmail-orders','calendar-deadlines'].includes(t.kind))for(const e of r.evidence??[])orders.ingest(e);
     let decision={kind:t.kind,handled:true};
     if(t.kind==='work-planner'){
      const rootSpent=s.budget.entries.filter(e=>e.taskId===t.rootTaskId).reduce((n,e)=>n+(e.actualCostRappen??e.maxCostRappen),0);
      decision=validatePlan({candidates:r.analysis?.candidates,capabilities:s.capabilities,evidence:r.sources??[],budget:{...s.budget,remainingRappen:Math.min(s.budget.remainingRappen,Math.max(0,s.budget.taskRappen-rootSpent))}});
      decision.reason=String(r.analysis?.summary??'Keine zulässige wirtschaftlich begründete Folgearbeit.').slice(0,1000);decision.nextReviewAt=new Date(Date.now()+21600000).toISOString();
      if(!decision.accepted.length&&s.tasks.filter(x=>x.rootTaskId===t.rootTaskId&&x.kind==='work-planner').length<4){
       const id='wait-review-'+createHash('sha256').update(t.id).digest('hex').slice(0,32);
       if(!controller.hasTask(id))controller.enqueue({id,rootTaskId:t.rootTaskId,kind:'work-planner',input:{title:'Gespeicherte Warteentscheidung und verfügbare Belege erneut bewerten',notBefore:Date.parse(decision.nextReviewAt)},dependencies:[t.id],resources:['planner']});
      }
      for(const c of decision.accepted){const id=`selected-${c.fingerprint}`;if(!controller.hasTask(id))controller.enqueue({id,rootTaskId:t.rootTaskId,kind:c.kind,input:{title:c.title,expectedBenefit:c.expectedBenefit,uncertainty:c.uncertainty,nextReviewAt:c.nextReviewAt,notBefore:c.kind.endsWith('-research')?Math.max(Date.parse(c.nextReviewAt),Math.ceil(Date.now()/21600000)*21600000):0},dependencies:[t.id],resources:c.kind.startsWith('private-')?[]:[c.kind]});}
     }
     if(t.kind==='private-draft'&&r.analysis?.deliverableMarkdown){
      const markdown=r.analysis.deliverableMarkdown,rows=[['Quelle','URL','Prüfstatus'],...(r.sources??[]).map(source=>[String(source.id),String(source.url),'Quellenbehauptung; keine Abnahme oder Zahlung bestätigt'])];
      decision.deliveries=['markdown','document','spreadsheet'].map(format=>{const content=format==='spreadsheet'?JSON.stringify(rows):markdown;return delivery.prepare({resultId:t.id,digest:createHash('sha256').update(content).digest('hex'),content,format,checks:{schema:true,sourceIds:r.analysis.sourceIds,independentFactualVerification:false}}).operationId;});
     }
     if(['private-analysis','private-draft'].includes(t.kind)&&adapters['work-planner']?.available!==false&&adapters['work-planner']){
      const depth=s.tasks.filter(x=>x.rootTaskId===t.rootTaskId&&x.kind==='work-planner').length,id=`replan-${createHash('sha256').update(t.id).digest('hex').slice(0,32)}`;
      if(depth<4&&!controller.hasTask(id))controller.enqueue({id,rootTaskId:t.rootTaskId,kind:'work-planner',input:{title:'Ergebnis und verbleibende Wissenslücken prüfen; nächste nützliche Arbeit oder Warten wählen'},dependencies:[t.id],resources:['planner']});
     }
     workflow.prepare('INSERT INTO decisions VALUES(?,?,?)').run(t.id,JSON.stringify(decision),Date.now());
    }
    if(adapters['drive-output']?.available)for(const d of delivery.snapshot().filter(d=>d.remoteStatus!=='verified')){
     const id=`upload-${d.operationId}`;if(!controller.hasTask(id))controller.enqueue({id,rootTaskId:s.tasks.find(t=>t.id===d.resultId)?.rootTaskId??d.resultId,kind:'drive-output',input:{title:'Geprüfte private Ergebnisversion im numaron-Ordner ablegen',operationId:d.operationId},dependencies:[d.resultId],resources:['drive-output']});
    }
    if(!isEnabled())return;await orderFlow?.refresh({isEnabled});if(!isEnabled())return;orderFlow?.advance(controller);
    if(!isEnabled())return;if(!overrides)controller.preparePrivateSplits();await controller.tick();error=null;
   })().catch(e=>{if(overrides)onError?.(e);error='Arbeitsplanung fehlgeschlagen. Gespeicherte Ergebnisse bleiben erhalten.';}).finally(()=>{current=null;});return current;
  },
  startLoop(){if(timer||closed)return;void api.cycle();timer=setInterval(()=>void api.cycle(),10000);},
  async close(){if(closed)return;closed=true;clearInterval(timer);await controller.close();await current;research?.close();connectors?.close();readers?.close();orderFlow?.close();delivery.close();orders.close();workflow.close();knowledge.close();budget.close();}
 };return api;
}
