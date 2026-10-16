import https from 'node:https';
import dns from 'node:dns';
import type {ClientRequest} from 'node:http';
import {isIP} from 'node:net';
import {gunzipSync,inflateSync} from 'node:zlib';
import {assertPublicEndpoint,SOURCE_LIMITS,type PublicFetch} from './sources.js';
/** Conservative IPv4-only egress. No IPv6 fallback, proxies or second DNS lookup.
 * Reject mixed public/private answers rather than choosing a convenient answer. */
export function publicIPv4Address(address:string):boolean{
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||
  a===192&&(b===168||b===0||b===88&&c===99)||a===100&&b>=64&&b<=127||
  a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
/** Fixed anonymous HTTPS transport for reviewed shadow sources. TLS hostname
 * verification stays enabled. The validated DNS address is the socket address;
 * redirects are never followed. No agent environment proxy is consulted. */
export const fixedPublicFetch:PublicFetch=async(input,init)=>{
 const url=assertPublicEndpoint(input instanceof Request?input.url:String(input));
 const headers=new Headers(init?.headers),headerValues:Record<string,string>={};headers.forEach((v,k)=>{headerValues[k]=v;});
 if(init?.method!=='GET'||init.redirect!=='error'||init.credentials!=='omit'||
  Object.keys(headerValues).some(k=>!['accept','user-agent'].includes(k))||!init.signal)throw Error('Fixed public transport contract required');
 const signal=init.signal;signal.throwIfAborted();
 return new Promise<Response>((resolve,reject)=>{
  let settled=false;let request:ClientRequest|undefined;
  const finish=(error?:Error,response?:Response)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error)reject(new Error('Fixed public transport rejected'));else resolve(response!);};
  const abort=()=>{request?.destroy();finish(new Error('aborted'));};
  const timer=setTimeout(abort,SOURCE_LIMITS.timeoutMs);
  try{request=https.request(url,{method:'GET',agent:false,family:4,rejectUnauthorized:true,
   headers:headerValues,lookup:(host,_options,callback)=>{
    if(host!==url.hostname){callback(new Error('Unexpected DNS host'),' ',4);return;}
    dns.lookup(host,{all:true,family:4},(error,addresses)=>{
     if(settled||signal.aborted||error||!addresses?.length||addresses.some(a=>a.family!==4||!publicIPv4Address(a.address))){callback(new Error('Public DNS required'),' ',4);return;}
     callback(null,addresses[0].address,4);
    });
   }},response=>{
    const status=response.statusCode??0,declared=Number(response.headers['content-length']??0);
    const retry=response.headers['retry-after'];
    // Preserve a provider restriction even on a rejected response. No body,
    // cookies, locations or unrelated headers are exposed to the caller.
    if(retry!==undefined&&status>=200&&status<=599){
     finish(undefined,new Response(null,{status,headers:{'retry-after':typeof retry==='string'&&retry.length<=200?retry:'invalid'}}));
     response.destroy();request?.destroy();return;
    }
    // Optional public files may be absent. Let the caller distinguish absence,
    // authentication restrictions and rate limits, without exposing error bodies.
    if(status>=400&&status<=599){
     finish(undefined,new Response(null,{status}));response.destroy();request?.destroy();return;
    }
    if(status!==200||!Number.isFinite(declared)||declared<0||declared>SOURCE_LIMITS.responseBytes){response.destroy();request?.destroy();finish(new Error('Response rejected'));return;}
    const chunks:Buffer[]=[];let bytes=0;
    response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>SOURCE_LIMITS.responseBytes){response.destroy();request?.destroy();finish(new Error('Body limit'));}else chunks.push(chunk);});
    response.on('error',()=>finish(new Error('Body failed')));
    response.on('aborted',()=>finish(new Error('Body aborted')));
    response.on('end',()=>{if(settled)return;try{
     const body=Buffer.concat(chunks),encoding=response.headers['content-encoding'];
     const decoded=encoding==='gzip'?gunzipSync(body,{maxOutputLength:SOURCE_LIMITS.responseBytes}):encoding==='deflate'?inflateSync(body,{maxOutputLength:SOURCE_LIMITS.responseBytes}):body;
     if(encoding&&!['identity','gzip','deflate'].includes(String(encoding)))throw Error('Unsupported compression');
     finish(undefined,new Response(decoded,{status,headers:{'content-type':'application/json'}}));
    }catch{finish(new Error('Invalid or oversized compressed response'));}});
   });
  request.on('error',()=>finish(new Error('Request failed')));
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else request.end();}catch{finish(new Error('Transport setup failed'));}
 });
};
