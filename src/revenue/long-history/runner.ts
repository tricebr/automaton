import {createHash,randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';
import {sourceCatalogue} from './sources.js';import {HISTORY_LIMITS,type SourceRecord,type Series,type ResearchReport,type RunConfig} from './types.js';import type {HistoryStore} from './store.js';
import {fetchSource} from './download.js';import {extractSingleCsvZip,extractBoardXmlZip} from './archive.js';import {normalizeFrenchCsv,normalizeBoardXml,normalizeCashBars,assessQuality} from './normalize.js';
import {analyzeHistory,analyzeMacroHistory} from './history.js';import {registerRun,phaseView,claimFinalEvaluation} from './registry.js';import {evaluateCashTrial} from './evaluate.js';import {strategyCatalogue} from '../strategy-research.js';import {deriveLessons,recordLessons,buildResearchContext,type KnowledgeContext} from './lessons.js';
import {analystKnowledge} from './trading-context.js';
import {researchWorker} from './worker-client.js';
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
const requestedStart=Date.UTC(1926,9,14),requestedEnd=Date.UTC(2026,9,15)-1;
export function normalizeSource(source:SourceRecord,bytes:Uint8Array):Series{
 if(source.id==='fed-h15')return normalizeBoardXml(extractBoardXmlZip(bytes,{maxBytes:HISTORY_LIMITS.fileBytes}));
 if(source.kind==='factor-returns')return normalizeFrenchCsv(extractSingleCsvZip(bytes,{maxBytes:HISTORY_LIMITS.fileBytes}),source);
 if(source.kind==='cash-ohlc'){const data=JSON.parse(Buffer.from(bytes).toString('utf8'));return normalizeCashBars(data.bars,data.metadata);}
 throw Error('Für diese Produkt-/Quellenart fehlt ein verifizierter Datenadapter.');
}
type Download=typeof fetchSource;
interface Options {store:HistoryStore;clock?:()=>number;download?:Download;normalize?:(source:SourceRecord,bytes:Uint8Array)=>Series;knowledge?:KnowledgeContext;evaluate?:typeof researchWorker;}
interface Control {mode:'paused'|'running'|'stopped';roundId:string;startedAt:number;datasets:string[];trials:number;activity:string;blockers:string[];}
const dayKey=(now:number)=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));const get=(type:string)=>parts.find(p=>p.type===type)!.value;return get('year')+'-'+get('month')+'-'+get('day');};
function publicReport(r:ResearchReport){const {periodPnlCents,stressPeriodPnlCents,...metrics}=r.metrics;return {...r,metrics};}
export function openHistoryRunner({store,clock=Date.now,download=fetchSource,normalize=normalizeSource,knowledge={},evaluate=researchWorker}:Options){
 for(const s of sourceCatalogue())if(!store.getSource(s.id))store.registerSource(s);
 const owner=randomUUID(),codeHash=hash(['runner.ts','store.ts','registry.ts','normalize.ts','history.ts','evaluate.ts','lessons.ts','types.ts','sources.ts','download.ts','archive.ts','worker-client.ts','trading-context.ts','../paper-trading.ts','../strategy-research.ts','../../../scripts/long-history-worker.mjs'].map(f=>readFileSync(new URL(f,import.meta.url),'utf8')).join('\n'));
 let busy:Promise<void>|null=null,abort:AbortController|null=null,timer:ReturnType<typeof setInterval>|undefined,closed=false;
 const readControl=():Control=>store.getJob('runner-control')?.detail as unknown as Control??{mode:'paused',roundId:'initial',startedAt:clock(),datasets:[],trials:0,activity:'Bereit für die erste Forschungsrunde',blockers:[]};
 const controlJob=(c:Control)=>({id:'runner-control',status:c.mode==='running'?'queued' as const:c.mode==='stopped'?'completed' as const:'cancelled' as const,detail:{...c}});
 const writeControl=(c:Control,explicit=false)=>store.mutateControl(old=>{const previous=old?.detail as unknown as Control|undefined;if(previous&&!explicit){if(previous.roundId!==c.roundId||previous.mode==='stopped')return old!;c.mode=previous.mode;}return controlJob(c);});
 const check=(round:string)=>{const c=readControl();if(closed||abort?.signal.aborted||c.mode==='stopped'||c.roundId!==round)throw Error('Forschung abgebrochen');store.assertLease(owner,clock());if(clock()<c.startedAt-1000||clock()-c.startedAt>=HISTORY_LIMITS.roundMs)throw Error('Zeitbudget der Forschungsrunde erreicht');};
 const evaluateDataset=async(datasetId:string,series:Series,round:string)=>{
  check(round);const data=store.getDataset(datasetId)!;const values=series.kind==='cash-ohlc'?series.bars.map(b=>b.time):series.rows.map(r=>r.date),start=Math.max(requestedStart,data.start),end=Math.min(requestedEnd,data.end);
  if(start>end)throw Error('Keine Daten im angefragten Zeitraum');
  const normalizedHash=hash(JSON.stringify(series)),jobId=hash('research|'+data.sourceId+'|'+normalizedHash+'|'+codeHash),existing=store.getJob(jobId);if(existing?.status==='completed'||existing?.status==='failed')return;
  const c=readControl();if(!c.datasets.includes(normalizedHash)){if(c.datasets.length>=HISTORY_LIMITS.datasets)throw Error('Datensatzlimit der Runde erreicht');c.datasets.push(normalizedHash);writeControl(c);}
  const times=values.filter(t=>t>=start&&t<=end),long=start<=Date.UTC(1985,0,1)&&end>=Date.UTC(2006,0,1);let developmentEnd=long?Date.UTC(1986,0,1)-1:Math.floor(start+(end-start)*.6),validationEnd=long?Date.UTC(2006,0,1)-1:Math.floor(start+(end-start)*.8);
  if(!(start<developmentEnd&&developmentEnd<validationEnd&&validationEnd<end)){developmentEnd=start+1;validationEnd=start+2;}
  const runId=hash(jobId+'|run'),variants=strategyCatalogue().map(v=>v.id);
  const config:RunConfig={id:runId,registeredAt:clock(),datasetIds:[data.id],variantIds:variants,rulesVersion:'long-history-v1',split:{developmentEnd,validationEnd,finalEnd:Math.max(end,validationEnd+1)},requestedStart:start,costs:{status:'model',feeBps:10,slippageBps:10,minimumFeeCents:100},seed:42,limits:{...HISTORY_LIMITS},codeHash};
  const old=store.getRun(runId);registerRun(store,old??config);store.saveJob({id:jobId,status:'running',detail:{datasetId}});
  const context=buildResearchContext(store,knowledge);
  const contextRecord={version:context.version??null,references:context.references??[],lessonIds:(context.lessons??[]).map(l=>l.id),modelRetrained:false};
  for(const variant of strategyCatalogue())if(!store.getHypothesis(hash(runId+'|hypothesis|'+variant.id)))store.saveHypothesis({id:hash(runId+'|hypothesis|'+variant.id),runId,variantId:variant.id,parameters:{...variant},context:contextRecord});
  const reports:ResearchReport[]=[];
  if(series.kind==='factor-returns'||series.kind==='macro'){
   const params={id:hash(jobId+'|history'),runId,datasetId,start,end};const history=series.kind==='macro'?analyzeMacroHistory(series,params):analyzeHistory(series,params);history.evidenceHashes=[data.rawSha256];
   reports.push({id:hash(jobId+'|not-tradeable'),runId,datasetId,kind:'product-readiness',nativeCurrency:data.currency,costStatus:'unknown',metrics:{observations:times.length},limitations:['Diese Reihe enthält '+(series.kind==='macro'?'Zinsquotierungen':'aggregierte Renditen')+', keine ausführbaren OHLC-/Bid/Ask-Preise.','Cash-/CFD-Strategien werden darauf nicht simuliert. Geeignete Produktdaten fehlen.'],decision:'nicht prüfbar',evidenceHashes:[data.rawSha256],liveAuthorized:false});
   reports.push(history);
  }else{
   for(const variant of variants){check(round);const current=readControl();store.registerTrial({id:hash(round+'|'+jobId+'|trial|'+variant),roundId:round,runId,datasetId:data.id,variantId:variant});current.trials=store.trialCount(round);writeControl(current);
    for(const phase of ['development','validation','final'] as const){check(round);const outcomeId=hash(jobId+'|outcome|'+variant+'|'+phase),priorOutcome=store.getTrialOutcome(outcomeId);if(priorOutcome){reports.push(priorOutcome);continue;}const view=phaseView(store,runId,phase,data.id);const claim=phase==='final'?claimFinalEvaluation(store,runId,variant,data.id):null;
     try{const report=await evaluate<ResearchReport>({kind:'cash',series,registration:{id:runId,datasetId,start:view.start,end:view.end,seed:42,variantIds:variants},variantId:variant},abort!.signal,HISTORY_LIMITS.roundMs-(clock()-readControl().startedAt));check(round);report.metrics.phase=phase;report.metrics.hypothesisId=hash(runId+'|hypothesis|'+variant);report.metrics.knowledgeVersion=context.version??null;report.metrics.contaminated=!!(claim?.contaminated||claim?.repeated);report.evidenceHashes=[data.rawSha256];if(claim?.contaminated||claim?.repeated)report.limitations.push('Dieser Schlussprüfabschnitt ist bereits aus einer früheren Runde bekannt.');store.withResearchLease(owner,clock(),round,()=>store.saveTrialOutcome(outcomeId,report));reports.push(report);}
     catch(error){if(abort!.signal.aborted||readControl().mode==='stopped')throw error;const failed:ResearchReport={id:hash(jobId+'|'+variant+'|'+phase+'|failed'),runId,datasetId,kind:'cash-paper',nativeCurrency:data.currency,costStatus:'unknown',metrics:{phase,variantId:variant},limitations:[String((error as Error).message)],decision:'nicht prüfbar',evidenceHashes:[data.rawSha256],liveAuthorized:false};store.withResearchLease(owner,clock(),round,()=>store.saveTrialOutcome(outcomeId,failed));reports.push(failed);}
    }
   }
   for(const phase of ['development','validation','final']){check(round);const family=reports.filter(r=>r.metrics.phase===phase);const completed=await evaluate<ResearchReport[]>({kind:'family',reports:family,seed:42,expectedVariants:variants.length},abort!.signal);for(const r of completed){const index=reports.findIndex(x=>x.id===r.id);reports[index]=r;}}
  }
  check(round);store.withResearchLease(owner,clock(),round,()=>{for(const report of reports){store.saveReport(report);recordLessons(store,deriveLessons(report,context));}store.saveJob({id:jobId,status:'completed',detail:{datasetId,reports:reports.length}});});
 };
 const tick=(options:{sourceId?:string;importOnly?:boolean}={}):Promise<void>=>{if(closed)return Promise.resolve();if(busy)return busy;if(readControl().mode!=='running')return Promise.resolve();
  store.mutateControl(old=>{const c=old?.detail as unknown as Control;if(c.mode==='running'&&dayKey(c.startedAt)!==dayKey(clock()))return controlJob({...c,roundId:randomUUID(),startedAt:clock(),datasets:[],trials:0,blockers:[]});return old!;});
  busy=(async()=>{if(!store.acquireLease(owner,clock()))return;abort=new AbortController();const round=readControl().roundId;
   const heartbeat=setInterval(()=>{try{store.assertLease(owner,clock());store.acquireLease(owner,clock());if(readControl().mode==='stopped'||readControl().roundId!==round)abort?.abort();}catch{abort?.abort();}},1000);heartbeat.unref?.();
   try{
    const c=readControl();c.blockers=[];c.activity='Historische Quellen und neue Datenstände prüfen';writeControl(c);
    for(const source of store.listSources().filter(s=>s.licenseStatus==='allowed'&&(!options.sourceId||s.id===options.sourceId))){
     check(round);if(readControl().mode!=='running')break;
     const jobId=hash('import|'+source.id+'|'+source.reviewedAt+'|'+dayKey(clock()));const importJob=store.getJob(jobId);
     if(importJob?.status==='completed'||importJob?.status==='failed')continue;
     store.saveJob({id:jobId,status:'running',detail:{sourceId:source.id}});
     try{
      const downloaded=await download(source,{signal:abort.signal,remainingBytes:Math.min(HISTORY_LIMITS.fileBytes,HISTORY_LIMITS.archiveBytes-store.archiveBytes())});check(round);
      const series=normalize(source,downloaded.bytes);check(round);const quality=assessQuality(series),times=series.kind==='cash-ohlc'?series.bars.map(b=>b.time):series.rows.map(r=>r.date);if(!quality.valid)throw Error('Qualitätsprüfung fehlgeschlagen');
      const data=store.withResearchLease(owner,clock(),round,()=>{const d=store.putDataset({sourceId:source.id,rawSha256:downloaded.sha256,revision:downloaded.sha256,normalizationVersion:'long-history-v1',kind:series.kind,start:times[0],end:times.at(-1)!,frequency:series.kind==='macro'?'monthly':'source-series',unit:series.kind==='macro'?'percent-per-year':series.kind==='factor-returns'?'decimal-return':'cash-cents',currency:series.currency,quality,limitations:[...series.limitations,...(quality.warnings??[])],provenance:'licensed-public-source'},downloaded.bytes);store.saveJob({id:jobId,status:'completed',detail:{sourceId:source.id,datasetId:d.id}});return d;});if(!options.importOnly)await evaluateDataset(data.id,series,round);
     }catch(error){if(readControl().mode==='stopped'||abort.signal.aborted)throw error;if(store.getJob(jobId)?.status!=='completed')store.saveJob({id:jobId,status:'failed',detail:{sourceId:source.id,reason:String((error as Error).message)}});const current=readControl();current.blockers.push(source.label+': '+String((error as Error).message));writeControl(current);}
    }
    // Resume interrupted research from already saved raw data without reimport.
    const seen=new Set<string>();if(!options.importOnly)for(const data of store.listDatasets()){if(seen.has(data.sourceId))continue;seen.add(data.sourceId);if(seen.size>3)break;if(store.getSource(data.sourceId)?.licenseStatus!=='allowed'||!data.quality.valid)continue;check(round);if(readControl().mode!=='running')break;await evaluateDataset(data.id,normalize(store.getSource(data.sourceId)!,store.rawData(data.id)),round);}
    const current=readControl();current.activity=store.snapshot().counts.reports?'Forschungsberichte gespeichert · neue Datenstände werden geprüft':'Geeignete Daten fehlen';current.blockers.push(...store.listSources().filter(s=>s.licenseStatus!=='allowed').map(s=>s.label+': Nutzungsrechte '+s.licenseStatus));writeControl(current);
   }catch(error){const c=readControl();if(c.mode!=='stopped'){c.activity='Forschung wartet';c.blockers=[...new Set([...c.blockers,String((error as Error).message)])];writeControl(c);}}
   finally{clearInterval(heartbeat);store.releaseLease(owner);abort=null;}
  })().finally(()=>busy=null);return busy;
 };
 return {tick,start(){if(!timer){timer=setInterval(()=>void tick(),15*60*1000);timer.unref?.();if(readControl().mode==='running')void tick();}},control(action:string){if(!['pause','resume','stop'].includes(action))throw Error('Unbekannte Forschungsaktion');const c=readControl();if(action==='resume'&&(c.roundId==='initial'||c.mode==='stopped')){c.roundId=randomUUID();c.startedAt=clock();c.datasets=[];c.trials=0;}c.mode=action==='resume'?'running':action==='pause'?'paused':'stopped';c.activity=action==='stop'?'Forschung gestoppt':action==='pause'?'Forschung pausiert':'Forschung aktiviert';writeControl(c,true);if(action==='stop')abort?.abort();return this.snapshot();},snapshot(){const c=readControl(),s=store.snapshot();return {...s,status:c.mode,activity:c.activity,blockers:[...new Set([...s.blockers,...c.blockers])],counts:s.counts,recentReports:store.listReports(12).map(publicReport),sources:store.listSources().map(s=>({id:s.id,label:s.label,status:s.licenseStatus})),coverage:store.listDatasets(1000).filter((d,i,all)=>all.findIndex(x=>x.sourceId===d.sourceId)===i).map(d=>({sourceId:d.sourceId,label:store.getSource(d.sourceId)?.label,kind:d.kind,start:d.start,end:d.end,frequency:d.frequency,valid:d.quality.valid,startsLate:d.start>requestedStart,endsEarly:d.end<requestedEnd})),requestedStart,requestedEnd,analystKnowledge:analystKnowledge()};},report(id:string){const report=store.getReport(id);if(!report)throw Error('Bericht nicht gefunden');return publicReport(report);},lessons(){return store.listLessons(20);},sources(){return store.listSources().map(s=>({id:s.id,label:s.label,status:s.licenseStatus,licenseEvidence:s.licenseEvidence}));},async close(){closed=true;clearInterval(timer);abort?.abort();await busy;store.releaseLease(owner);}};
}
export type HistoryRunner=ReturnType<typeof openHistoryRunner>;
