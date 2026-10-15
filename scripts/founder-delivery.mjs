import fs from 'node:fs';import path from 'node:path';import Database from 'better-sqlite3';import {createHash} from 'node:crypto';
import {writeNativeOutput,nativeRows} from './founder-native-output.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function openFounderDelivery({directory,access=()=>({available:false}),request=fetch}){
 fs.mkdirSync(directory,{recursive:true});const db=new Database(path.join(directory,'deliveries.db'));db.pragma('journal_mode=WAL');db.pragma('busy_timeout=5000');
 db.exec('CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,result_id TEXT NOT NULL,digest TEXT NOT NULL,content TEXT NOT NULL,checks TEXT NOT NULL,remote_status TEXT NOT NULL,remote_id TEXT,folder_id TEXT,at TEXT NOT NULL)');
 if(!db.prepare('PRAGMA table_info(deliveries)').all().some(c=>c.name==='format'))db.exec("ALTER TABLE deliveries ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'");
 const running=new Set();
 const read=id=>{const r=db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);if(!r||hash(r.content)!==r.digest)throw Error('Delivery integrity failed');return {format:r.format,operationId:r.id,resultId:r.result_id,digest:r.digest,content:r.content,checks:JSON.parse(r.checks),independentFactualVerification:false,remoteStatus:r.remote_status,remoteId:r.remote_id,folderId:r.folder_id,at:r.at};};
 async function json(url,options,ctx){ctx?.assertActive();const r=await request(url,{...options,redirect:'error',signal:ctx?.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});if(!r.ok)throw Error('Drive unavailable');const reader=r.body.getReader(),parts=[];let n=0;try{for(;;){const v=await reader.read();if(v.done)break;n+=v.value.length;if(n>100000)throw Error('Drive response limit');parts.push(v.value);}}finally{await reader.cancel();}return JSON.parse(Buffer.concat(parts).toString());}
 const api={
 prepare(x){if(!x||!['markdown','document','spreadsheet'].includes(x.format)||typeof x.resultId!=='string'||!/^[\w-]{1,100}$/.test(x.resultId)||typeof x.content!=='string'||x.content.length<(x.format==='spreadsheet'?2:300)||Buffer.byteLength(x.content)>50000||hash(x.content)!==x.digest||x.checks?.schema!==true||!Array.isArray(x.checks.sourceIds)||!x.checks.sourceIds.length||!x.checks.sourceIds.every(s=>typeof s==='string'&&s.length<=200))throw Error('Delivery validation failed');
 if(x.format==='spreadsheet')nativeRows(x.content);
 const id=hash(JSON.stringify(x.format==='markdown'?[x.resultId,x.digest]:[x.resultId,x.digest,x.format]));db.prepare("INSERT OR IGNORE INTO deliveries(id,result_id,digest,content,checks,remote_status,remote_id,folder_id,at,format) VALUES(?,?,?,?,?,'local',NULL,NULL,?,?)").run(id,x.resultId,x.digest,x.content,JSON.stringify({...x.checks,independentFactualVerification:false}),new Date().toISOString(),x.format);return read(id);},
 read,snapshot:()=>db.prepare('SELECT id FROM deliveries ORDER BY at DESC LIMIT 100').all().map(x=>{const {content,...r}=read(x.id);return r;}),
 async publish(id,ctx){ctx?.assertActive();if(running.has(id))throw Error('Delivery already active');running.add(id);
 try{let row=read(id);if(row.remoteStatus==='verified')return row;const a=access();if(!a.available||a.scope?.account!=='numaronia@gmail.com'||!/^[-\w]{1,200}$/.test(a.scope?.folderId??'')||!a.credential)throw Error('Drive access missing');
 const folder=a.scope.folderId;if(row.folderId&&row.folderId!==folder)throw Error('Drive folder changed');const headers={Authorization:`Bearer ${a.credential}`,'Content-Type':'application/json'};
 const q=`'${folder}' in parents and trashed = false and appProperties has { key='numaronOperation' and value='${id}' }`;
 const found=await json(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=2&fields=files(id,parents,appProperties,md5Checksum),nextPageToken`,{method:'GET',headers},ctx);
 if(!Array.isArray(found.files)||found.files.length>1||found.nextPageToken)throw Error('Ambiguous Drive delivery');let remote=found.files[0];
 if(remote&&(!remote.parents?.includes(folder)||remote.appProperties?.numaronOperation!==id||remote.appProperties?.digest!==row.digest))throw Error('Drive ownership mismatch');
 if(!remote){if(row.remoteStatus!=='local')throw Error('Unknown write requires reconciliation');ctx?.assertActive();const claim=db.prepare("UPDATE deliveries SET remote_status='unknown',folder_id=? WHERE id=? AND remote_status='local'").run(folder,id);if(claim.changes!==1)throw Error('Unknown write requires reconciliation');
 const metadata={name:`numaron-${row.resultId}-${row.digest.slice(0,12)}.md`,mimeType:row.format==='document'?'application/vnd.google-apps.document':row.format==='spreadsheet'?'application/vnd.google-apps.spreadsheet':'text/markdown',parents:[folder],appProperties:{numaronOperation:id,digest:row.digest}};
 if(row.format==='markdown'){
 const boundary=`numaron_${id}`;
 const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${row.content}\r\n--${boundary}--`;
 remote=await json('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,parents,appProperties,md5Checksum',{method:'POST',headers:{Authorization:headers.Authorization,'Content-Type':`multipart/related; boundary=${boundary}`},body},ctx);
 }else remote=await json('https://www.googleapis.com/drive/v3/files?fields=id,parents,appProperties',{method:'POST',headers,body:JSON.stringify(metadata)},ctx);
 }
 if(!/^[-\w]{1,200}$/.test(remote.id??''))throw Error('Drive identity missing');db.prepare("UPDATE deliveries SET remote_id=?,remote_status='uploading',folder_id=? WHERE id=?").run(remote.id,folder,id);
 if(row.format!=='markdown'){await writeNativeOutput({format:row.format,id:remote.id,content:row.content,headers,call:json,ctx});}else{
 if(remote.md5Checksum!==createHash('md5').update(row.content).digest('hex'))throw Error('Drive content checksum mismatch; existing file preserved');}

 db.prepare("UPDATE deliveries SET remote_status='verified' WHERE id=?").run(id);return read(id);
 }finally{running.delete(id);}},close(){db.close();}
 };return api;
}
