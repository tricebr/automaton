import {readServiceAccess} from './founder-service-access.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const amplitudeDashboardUrl='https://app.amplitude.com/analytics/sweet-brook-088327/dashboard/zpuwi7ca';
const apiKey='f7d07467c3be44b239f7dcea69ec713e';
const exec=promisify(execFile);

// DPAPI: decrypt only in the current Windows user's server process, never in the browser.
async function readLocalSecret(){
 const native=readServiceAccess('amplitude');if(native.available&&String(native.scope?.projectId)==='878459'){const pair=Buffer.from(native.credential,'base64').toString('utf8'),colon=pair.indexOf(':');if(colon>0&&pair.slice(0,colon)===apiKey)return pair.slice(colon+1);}

 const file=path.join(os.homedir(),'.numaron','amplitude-secret.clixml');
 if(!fs.existsSync(file))return null;
 const stat=fs.lstatSync(file);
 if(process.platform!=='win32'||!stat.isFile()||stat.isSymbolicLink()||stat.size>16384||fs.lstatSync(path.dirname(file)).isSymbolicLink())throw Error('Credential unavailable');
 const command='$taskSecret = Import-Clixml -LiteralPath $env:NUMARON_AMPLITUDE_SECRET_FILE; $taskPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPtr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPtr) }';
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:4000,maxBuffer:4096,env:{...process.env,NUMARON_AMPLITUDE_SECRET_FILE:file}});
 const secret=stdout.trim();if(!/^[A-Za-z0-9_-]{16,256}$/.test(secret))throw Error('Credential unavailable');
 return secret;
}

async function readBody(response){
 if(!response.body)throw Error('Invalid response');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw Error('Response limit');chunks.push(value);}}
 finally{await reader.cancel();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createAmplitudeReader({readSecret=readLocalSecret,request=fetch,now=Date.now}={}){
 let cached,pending,nextAttempt=0;
 async function update(){
  const at=now(),observedAt=new Date(at).toISOString(),end=new Date(at),start=new Date(at);
  start.setUTCDate(start.getUTCDate()-29);
  const day=d=>d.toISOString().slice(0,10),period={start:day(start),end:day(end),days:30};
  const context={projectId:878459,dashboardUrl:amplitudeDashboardUrl,period,refreshMinutes:15,timezone:'Amplitude-Projektzeitzone'};
  let reason='provider';
  try{
   const secret=await readSecret();
   if(!secret)return {status:'not-configured',...context};
   const authorization='Basic '+Buffer.from(apiKey+':'+secret).toString('base64');
   const counts=await Promise.all(['seite aufgerufen','dashboard geöffnet'].map(async event_type=>{
    const url=new URL('https://amplitude.com/api/2/events/segmentation');
    url.search=new URLSearchParams({e:JSON.stringify({event_type}),m:'totals',start:period.start.replaceAll('-',''),end:period.end.replaceAll('-',''),i:'1'}).toString();
    const response=await request(url,{method:'GET',redirect:'error',headers:{Authorization:authorization},signal:AbortSignal.timeout(4500)});
    if(!response.ok){reason=[401,403].includes(response.status)?'authentication':response.status===429?'rate-limit':'provider';throw Error('Read unavailable');}
    const data=(await readBody(response)).data;
    const value=data?.seriesCollapsed?.[0]?.[0]?.value;
    if(!Array.isArray(data?.seriesCollapsed)||data.seriesCollapsed.length!==1||!Array.isArray(data.xValues)||data.xValues.length>31||!Number.isSafeInteger(value)||value<0)throw Error('Invalid aggregate');
    return value;
   }));
   cached={status:'connected',...context,observedAt,lastAttemptAt:observedAt,pageViews:counts[0],dashboardViews:counts[1]};
  }catch{
   cached=cached?.observedAt?{...cached,status:'stale',lastAttemptAt:observedAt,reason}:{status:'unavailable',...context,lastAttemptAt:observedAt,reason};
  }
  // A failed first fetch must not hide recovered provider access for 15 minutes.
  nextAttempt=at+(cached.status==='connected'||reason!=='provider'?900000:60000);
  return cached;
 }
 return async()=>{
  if(cached&&now()<nextAttempt)return structuredClone(cached);
  if(!pending)pending=update().finally(()=>{pending=undefined;});
  return structuredClone(await pending);
 };
}
