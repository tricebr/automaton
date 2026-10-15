import {Worker} from 'node:worker_threads';
export function researchWorker<T>(data:Record<string,unknown>,signal:AbortSignal,timeoutMs=60000):Promise<T>{return new Promise((resolve,reject)=>{
 if(signal.aborted){reject(Error('Forschung abgebrochen'));return;}
 const worker=new Worker(new URL('../../../scripts/long-history-worker.mjs',import.meta.url),{workerData:data,execArgv:['--import','tsx'],resourceLimits:{maxOldGenerationSizeMb:512}});let finished=false;
 const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);void worker.terminate();};
 const finish=(error:Error|null,value?:T)=>{if(finished)return;finished=true;cleanup();if(error)reject(error);else resolve(value!);};
 const stop=()=>finish(Error('Forschung abgebrochen')),timer=setTimeout(()=>finish(Error('Zeitlimit der Berechnung erreicht')),Math.max(1,Math.min(60000,timeoutMs)));
 signal.addEventListener('abort',stop,{once:true});worker.once('message',m=>finish(m.ok?null:Error(String(m.error)),m.value));worker.once('error',error=>finish(error));worker.once('exit',()=>{if(!finished)finish(Error('Forschungsberechnung ohne Ergebnis beendet'));});
});}
