import Database from 'better-sqlite3';
export function normalizeOrderReport(report){
 const input=report?.prs??report?.pr_states;if(!Array.isArray(input)||input.length>500)throw Error('Missing PR evidence');
 const rows=input.map(p=>p?.status==='fulfilled'?p.value:p),valid=p=>p&&typeof p.repo==='string'&&/^[\w.-]+\/[\w.-]+$/.test(p.repo)&&Number.isSafeInteger(p.n)&&p.n>0;
 return {at:report.checked_at??report.at,failures:rows.filter(p=>!valid(p)||p.error===true).length,prs:rows.filter(valid).map(p=>({repo:p.repo,n:p.n,state:p.state,merged:p.merged===true,error:p.error===true}))};
}
// Local ownership registrations come from reviewed submission reports, never model proposals.
export function openFounderOrders(file){
 const db=new Database(file);db.pragma('journal_mode = WAL');db.pragma('busy_timeout = 5000');
 db.exec(`CREATE TABLE IF NOT EXISTS own_orders(id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_id TEXT NOT NULL,owner TEXT NOT NULL,provenance TEXT NOT NULL,UNIQUE(provider,external_id));
 CREATE TABLE IF NOT EXISTS order_evidence(provider TEXT NOT NULL,external_id TEXT NOT NULL,revision TEXT NOT NULL,observed_at TEXT NOT NULL,own_order_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(provider,external_id,revision));`);
 const str=(x,max=200)=>typeof x==='string'&&x.length>0&&x.length<=max;
 return {
 register(r){if(!r||!str(r.id)||!str(r.provider)||!str(r.externalId)||r.owner!=='tricebr'||!/^artifacts\/[\w.-]+\/completion\.json$/.test(r.provenance??''))throw Error('Invalid ownership provenance');
 const old=db.prepare('SELECT * FROM own_orders WHERE id=?').get(r.id);if(old){if(old.provider!==r.provider||old.external_id!==r.externalId||old.provenance!==r.provenance)throw Error('Ownership conflict');return false;}
 db.prepare('INSERT INTO own_orders VALUES(?,?,?,?,?)').run(r.id,r.provider,r.externalId,r.owner,r.provenance);return true;},
 ingest(e){return db.transaction(()=>{
 if(!e||!str(e.provider)||!str(e.externalId)||!str(e.revision)||!str(e.ownOrderId)||!Number.isFinite(Date.parse(e.observedAt))||!['assignment','delivery','acceptance','compensation','deadline','observation','payment'].includes(e.kind))throw Error('Invalid evidence');
 const own=db.prepare('SELECT * FROM own_orders WHERE id=?').get(e.ownOrderId);if(!own)throw Error('Own order not registered');
 const direct=own.provider===e.provider&&own.external_id===e.externalId;
 const linked=['gmail','calendar'].includes(e.provider)&&e.kind==='observation'&&own.provider==='github'&&e.payload?.linkProof==='https://github.com/'+own.external_id&&e.payload?.privacy==='private'&&e.payload?.assignmentConfirmed===false&&e.payload?.acceptanceConfirmed===false&&e.payload?.paymentConfirmed===false;
 if(!direct&&!linked)throw Error('Own order not registered');
 // Platform text and model output cannot establish bank receipt. A separate verified reconciliation is required.
 if(e.kind==='payment')throw Error('Payment evidence requires independent reconciliation');
 const payload=JSON.stringify(e.payload);if(!payload||Buffer.byteLength(payload)>64000)throw Error('Evidence size');
 const old=db.prepare('SELECT * FROM order_evidence WHERE provider=? AND external_id=? AND revision=?').get(e.provider,e.externalId,e.revision);
 if(old){if(old.payload!==payload||old.kind!==e.kind||old.own_order_id!==e.ownOrderId)throw Error('Revision conflict');return false;}
 db.prepare('INSERT INTO order_evidence VALUES(?,?,?,?,?,?,?)').run(e.provider,e.externalId,e.revision,e.observedAt,e.ownOrderId,e.kind,payload);return true;
 }).immediate();},
 snapshot(){return {orders:db.prepare('SELECT * FROM own_orders ORDER BY id').all(),evidence:db.prepare('SELECT * FROM order_evidence ORDER BY observed_at DESC,revision LIMIT 500').all().map(r=>({...r,payload:JSON.parse(r.payload)}))};},
 integrity(){return db.pragma('integrity_check',{simple:true});},close(){db.close();}
 };
}
