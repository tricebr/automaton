import https from 'node:https';
import dns from 'node:dns';
import type {ClientRequest} from 'node:http';
import {publicIPv4Address} from './fixed-public-fetch.js';
import {searchRequest,validateSearchTask,type SearchTask} from './search-adapters.js';
import {readSearchCredential} from './search-credentials.js';

export type SearchTransport=(task:SearchTask,signal:AbortSignal,beforeSend?:()=>void)=>Promise<unknown>;
/** Dedicated authenticated fixed-endpoint transport, not an arbitrary URL fetcher. */
export const fixedSearchTransport:SearchTransport=async(task,signal,beforeSend)=>{
 signal.throwIfAborted();
 validateSearchTask(task);
 const spec=searchRequest(task,await readSearchCredential(task.provider));
 signal.throwIfAborted();
 beforeSend?.();
 const url=new URL(spec.url);
 return new Promise((resolve,reject)=>{
  let request:ClientRequest|undefined,settled=false;
  const finish=(ok:boolean,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(ok)resolve(value);else reject(Error('Search transport failed; review required before retry'));};
  const abort=()=>{request?.destroy();finish(false);};
  const timer=setTimeout(abort,15000);
  try{
   request=https.request(url,{method:spec.method,agent:false,rejectUnauthorized:true,family:4,headers:spec.headers,
    lookup:(host,_options,callback)=>{
     if(host!==url.hostname){callback(Error('Host rejected'),'',4);return;}
     dns.lookup(host,{all:true,family:4},(error,addresses)=>{
      if(settled||signal.aborted||error||!addresses?.length||addresses.some(a=>a.family!==4||!publicIPv4Address(a.address))){callback(Error('Public DNS required'),'',4);return;}
      callback(null,addresses[0].address,4);
     });
    }},response=>{
     const length=Number(response.headers['content-length']??0);
     if(response.statusCode!==200||response.headers['retry-after']!==undefined||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'||
      !String(response.headers['content-type']).toLowerCase().includes('application/json')||!Number.isFinite(length)||length<0||length>1000000){response.destroy();abort();return;}
     let bytes=0;const chunks:Buffer[]=[];
     response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1000000){response.destroy();abort();}else chunks.push(chunk);});
     response.on('error',abort);response.on('aborted',abort);
     response.on('end',()=>{try{finish(true,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(false);}});
    });
   request.on('error',abort);signal.addEventListener('abort',abort,{once:true});
   if(signal.aborted)abort();else request.end(spec.method==='GET'?undefined:spec.body);
  }catch{abort();}
 });
};
