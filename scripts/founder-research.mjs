import fs from 'node:fs';
import path from 'node:path';
import {openOnline} from '../src/online/workspace.ts';
import {researchSchedule} from '../src/online/scheduler.ts';
import {improvementResearchSchedule} from '../src/revenue/proactive-research.ts';
import {createTargetedResearch,specificResearch} from './founder-targeted-research.mjs';
export function createFounderResearch({directory,request,now=()=>Date.now()}) {
 const file=path.join(directory,'research.db');
 const online=openOnline(fs.existsSync(file)?{resume:file,request}:{directory,request});
 online.runtime.configureAutonomy(true);
 const targeted=createTargetedResearch({db:online.database.raw,request,now});
 let interruptedJob=null;
 return {available:true,maxCostRappen:0,retrySafe:true,autoRetrySafe:true,
  get waitState(){
   if(interruptedJob!==null)return null;
   const db=online.database.raw,primary=researchSchedule(db),s=primary.reason==='cooldown_or_review'?improvementResearchSchedule(db):primary;
   if(s.topic||s.reason==='queued_work')return null;
   const cooldown=['cooldown_or_review','improvement_cooldown'].includes(s.reason);
   const labels={source_quota:'Das Abruflimit für öffentliche Quellen ist erreicht.',evidence_capacity_review:'Gespeicherte Quellen müssen geprüft werden.',opportunity_capacity_review:'Gespeicherte Chancen müssen geprüft werden.',research_capacity_review:'Gespeicherte Rechercheergebnisse müssen geprüft werden.',improvement_history_review:'Die bisherigen Methodenversuche müssen geprüft werden.',improvement_review_required:'Keine weitere geprüfte Methodenrecherche freigegeben.',initial_market_research_first:'Zuerst muss die Grundlagenrecherche abgeschlossen werden.'};
   const row=cooldown?db.prepare("SELECT MIN(unixepoch(created_at)*1000+86400000) at FROM online_jobs WHERE status='done' AND unixepoch(created_at)*1000+86400000>?").get(Date.now()):null;
   // Review is a condition, never a promised start one minute from now.
   return {code:s.reason,reason:cooldown?'Die Recherche hält ihre 24-Stunden-Pause ein; ein Start erfolgt erst bei freigegebenem Thema.':labels[s.reason]??'Quellenprüfung erforderlich.',until:null,earliestReviewAt:row?.at??null,checkAt:Date.now()+60000};
  },
  get nextReadyAt(){const w=this.waitState;return w?Math.min(w.until??Infinity,w.checkAt):0;},
  waitStateFor(ctx){return specificResearch(ctx)?targeted.waitState(ctx):this.waitState;},
  nextReadyAtFor(ctx){const w=this.waitStateFor(ctx);return w?(w.until??w.checkAt??Infinity):0;},
  async execute(ctx) {
   if(specificResearch(ctx))return targeted.execute(ctx);
   const {signal,assertActive}=ctx;
   assertActive();if(signal.aborted)throw Error('Stopped');
   const runtime=online.runtime;
   if(runtime.status==='paused')runtime.control('resume');else if(runtime.status==='stopped')runtime.control('start');
   const stop=()=>{if(runtime.status==='running'){const row=online.database.raw.prepare("SELECT id FROM online_jobs WHERE status='running'").get();runtime.control('pause');if(signal.aborted&&row)interruptedJob=row.id;}};
   signal.addEventListener('abort',stop,{once:true});
   try {
    let count;
    if(interruptedJob!==null){const id=interruptedJob;interruptedJob=null;const changed=online.database.raw.prepare("UPDATE online_jobs SET status='pending',error=NULL WHERE id=? AND status='cancelled' AND error='Cancelled by operator'").run(id).changes;if(!changed)throw Error('Interrupted read changed');online.database.raw.prepare("INSERT INTO online_audit(action,detail) VALUES('founder_resume_read',?)").run(JSON.stringify({jobId:id,scope:'same bounded public GET; quotas preserved'}));count=await runtime.tick();}
    else count=await runtime.autonomousTick();
    assertActive();
    const sources=runtime.research.evidence().slice(-40).map(e=>({id:e.id,url:e.sourceUrl,claim:e.excerpt??e.summary??'',observedAt:e.observedAt,verification:'reported',digest:e.digest}));
    return {kind:'research',observedAt:new Date().toISOString(),processed:count,sources,checks:{publicSourcesOnly:true,claimsIndependentlyVerified:false}};
   } finally {signal.removeEventListener('abort',stop);stop();}
  },
  verify(r){return r?.kind==='research'&&r.processed>0&&r.sources.length>0&&r.sources.every(s=>typeof s.url==='string'&&s.url.startsWith('https://')&&s.digest);},
  close(){online.database.close();}
 };
}
