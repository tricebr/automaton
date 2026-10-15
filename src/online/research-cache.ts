import {createHash,randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {assertModelPrivacy} from '../security/privacy-egress.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const cacheKey=(context:unknown)=>hash(JSON.stringify({namespace:'public-discovery-v1',context}));
export function invalidatePublicResearch(db:Database,context:unknown){
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_result_cache'").get())db.prepare('DELETE FROM research_result_cache WHERE key=?').run(cacheKey(context));
}
/** Normalized public discovery only; never caches authorization or execution. */
export async function reusePublicResearch<T>(db:Database,context:unknown,signal:AbortSignal,work:()=>Promise<T>,validate:(value:unknown)=>value is T):Promise<T>{
 signal.throwIfAborted();
 const key=cacheKey(context),owner=randomUUID(),now=Date.now();
 const cached=db.transaction(()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS research_result_cache(key TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_ms INTEGER NOT NULL,payload TEXT,digest TEXT);
   CREATE TABLE IF NOT EXISTS research_reuse_metrics(id INTEGER PRIMARY KEY CHECK(id=1),hits INTEGER NOT NULL DEFAULT 0,misses INTEGER NOT NULL DEFAULT 0,busy INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS research_refresh_history(key TEXT PRIMARY KEY,content_digest TEXT NOT NULL,unchanged INTEGER NOT NULL,updated_ms INTEGER NOT NULL);
   INSERT OR IGNORE INTO research_reuse_metrics(id) VALUES(1);`);
  db.prepare('DELETE FROM research_result_cache WHERE expires_ms<=?').run(now);
  db.prepare('DELETE FROM research_refresh_history WHERE updated_ms<?').run(now-86400000);
  const row=db.prepare('SELECT payload,digest,expires_ms FROM research_result_cache WHERE key=?').get(key) as {payload:string|null;digest:string|null;expires_ms:number}|undefined;
  if(row){
   if(!Number.isSafeInteger(row.expires_ms)||row.expires_ms-now>300000)throw Error('Invalid cache freshness or clock');
   if(row.payload===null){db.prepare('UPDATE research_reuse_metrics SET busy=busy+1 WHERE id=1').run();return {busy:true} as const;}
   if(hash(row.payload)!==row.digest)throw Error('Research cache integrity failure');
   const result=JSON.parse(row.payload);assertModelPrivacy(result);
   if(!validate(result))throw Error('Research cache validation failed');
   db.prepare('UPDATE research_reuse_metrics SET hits=hits+1 WHERE id=1').run();return {result} as const;
  }
  if((db.prepare('SELECT COUNT(*) n FROM research_result_cache').get() as {n:number}).n>=100)throw Error('Research cache capacity reached');
  db.prepare('INSERT INTO research_result_cache VALUES(?,?,?,NULL,NULL)').run(key,owner,now+90000);
  db.prepare('UPDATE research_reuse_metrics SET misses=misses+1 WHERE id=1').run();return null;
 }).immediate();
 if(cached){if('busy' in cached)throw Error('Equivalent public research already in progress; defer instead of duplicating');return cached.result;}
 try{
  const result=await work();signal.throwIfAborted();
  if(!validate(result))throw Error('Research result validation failed');
  const payload=JSON.stringify(result);
  let reusable=Buffer.byteLength(payload)<=50000;
  // Public sources can contain PII: do not persist it in reusable storage.
  try{assertModelPrivacy(result);}catch{reusable=false;}
  if(reusable)db.transaction(()=>{
   const prior=db.prepare('SELECT content_digest,unchanged FROM research_refresh_history WHERE key=?').get(key) as {content_digest:string;unchanged:number}|undefined;
   if(prior&&(!Number.isSafeInteger(prior.unchanged)||prior.unchanged<0||prior.unchanged>3))throw Error('Invalid research refresh history');
   const fingerprint=hash(payload),unchanged=prior?.content_digest===fingerprint?Math.min(3,prior.unchanged+1):0;
   const ttl=Math.min(300000,60000*2**unchanged);
   const written=db.prepare('UPDATE research_result_cache SET payload=?,digest=?,expires_ms=? WHERE key=? AND owner=? AND expires_ms>?')
    .run(payload,fingerprint,Date.now()+ttl,key,owner,Date.now());
   if(written.changes){
    if(!prior&&(db.prepare('SELECT COUNT(*) n FROM research_refresh_history').get() as {n:number}).n>=100)return;
    db.prepare('INSERT INTO research_refresh_history VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET content_digest=excluded.content_digest,unchanged=excluded.unchanged,updated_ms=excluded.updated_ms')
     .run(key,fingerprint,unchanged,Date.now());
   }
  }).immediate();
  return result;
 }finally{db.prepare('DELETE FROM research_result_cache WHERE key=? AND owner=? AND payload IS NULL').run(key,owner);}
}
