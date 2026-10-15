import fs from 'node:fs';
import path from 'node:path';
import {openOnline} from '../src/online/workspace.ts';
export function createFounderResearch({directory,request}) {
 const file=path.join(directory,'research.db');
 const online=openOnline(fs.existsSync(file)?{resume:file,request}:{directory,request});
 online.runtime.configureAutonomy(true);
 let interruptedJob=null;
 return {available:true,maxCostRappen:0,retrySafe:true,
  async execute({signal,assertActive}) {
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
