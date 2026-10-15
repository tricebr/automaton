import Database from 'better-sqlite3';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const providers=new Set(['OpenAI','Cloudflare','Hostpoint']);
export function openFounderCostImport(file){
 const db=new Database(file);db.pragma('journal_mode = WAL');
 db.exec('CREATE TABLE IF NOT EXISTS finance_imports(reference TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS finance_import_status(id INTEGER PRIMARY KEY CHECK(id=1),at TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS finance_import_resolutions(reference TEXT PRIMARY KEY,kind TEXT NOT NULL,evidence TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS finance_invoice_payments(reference TEXT PRIMARY KEY,payload TEXT NOT NULL)');
 return {
  ingest(records){
   if(!Array.isArray(records)||records.length>200)throw Error('Invalid batch');
   const clean=records.map(r=>{
    if(!providers.has(r.provider)||typeof r.reference!=='string'||!/^[-a-zA-Z0-9_:]{5,150}$/.test(r.reference)||!/^\d{4}-\d{2}-\d{2}$/.test(r.observedDay??'')||!Number.isSafeInteger(r.amountMinor)||r.amountMinor<=0||r.amountMinor>100000000||!['CHF','USD','EUR'].includes(r.currency)||typeof r.invoice!=='string'||r.invoice.length>100||!['scope','currency','period','ready'].includes(r.reason)||typeof r.source!=='string'||!/^https:\/\/(mail\.google\.com|platform\.openai\.com|dash\.cloudflare\.com|admin\.hostpoint\.ch)\//.test(r.source))throw Error('Invalid invoice');
    if(r.reason==='ready'&&(r.currency!=='CHF'||r.scope!=='numaron-only'||r.nature!=='consumed-service'||!/^\d{4}-\d{2}-\d{2}$/.test(r.accountingDay??'')||new Date(r.accountingDay+'T12:00:00Z').toISOString().slice(0,10)!==r.accountingDay||typeof r.allocationEvidence!=='string'||r.allocationEvidence.length<10||r.allocationEvidence.length>400))throw Error('Verified CHF allocation and accounting date required');
    return Object.fromEntries(['provider','reference','observedDay','amountMinor','currency','invoice','reason','source',...(r.reason==='ready'?['scope','nature','accountingDay','allocationEvidence']:[])].map(k=>[k,r[k]]));
   });
   db.transaction(()=>{for(const r of clean){const value=JSON.stringify(r),prior=db.prepare('SELECT payload FROM finance_imports WHERE reference=?').get(r.reference);if(prior&&prior.payload!==value)throw Error('Conflicting invoice');db.prepare('INSERT OR IGNORE INTO finance_imports VALUES(?,?)').run(r.reference,value);if(r.reason==='ready')db.prepare('INSERT OR IGNORE INTO finance_entries VALUES(?,?,?,?,?,?)').run('import-'+r.reference,r.accountingDay,'expense',r.amountMinor,r.provider+' · '+r.invoice,r.reference);}db.prepare('INSERT OR REPLACE INTO finance_import_status VALUES(1,?)').run(new Date().toISOString());})();
  },
  resolve(input){
   const row=db.prepare('SELECT payload FROM finance_imports WHERE reference=?').get(input?.reference??'');if(!row)throw Error('Unknown invoice');const invoice=JSON.parse(row.payload);
   if(input.action==='payment'){
    const {amount,numaronAmount,day,nature}=input;
    if(!Number.isSafeInteger(amount)||amount<=0||amount>100000000||!Number.isSafeInteger(numaronAmount)||numaronAmount<0||numaronAmount>amount||!['service','prepaid'].includes(nature)||!/^\d{4}-\d{2}-\d{2}$/.test(day??'')||!Number.isFinite(Date.parse(day+'T12:00:00Z'))||new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day||day>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))throw Error('Invalid CHF payment');
    const payment={amount,numaronAmount,day,nature,confirmedBy:'founder',confirmedAt:new Date().toISOString()};
    db.transaction(()=>{
     db.prepare('INSERT OR REPLACE INTO finance_invoice_payments VALUES(?,?)').run(invoice.reference,JSON.stringify(payment));
     const existing=db.prepare('SELECT id FROM finance_entries WHERE evidence=?').get(invoice.reference);
     if(numaronAmount===0)db.prepare('DELETE FROM finance_entries WHERE evidence=?').run(invoice.reference);
     else if(existing)db.prepare('UPDATE finance_entries SET day=?,kind=?,amount=?,title=? WHERE evidence=?').run(day,nature==='prepaid'?'transfer':'expense',numaronAmount,invoice.provider+' · '+invoice.invoice+' · '+(nature==='prepaid'?'Guthabenaufladung':'numaron-Anteil'),invoice.reference);
     else db.prepare('INSERT INTO finance_entries VALUES(?,?,?,?,?,?)').run('import-'+invoice.reference,day,nature==='prepaid'?'transfer':'expense',numaronAmount,invoice.provider+' · '+invoice.invoice+' · '+(nature==='prepaid'?'Guthabenaufladung':'numaron-Anteil'),invoice.reference);
     db.prepare('INSERT OR REPLACE INTO finance_import_resolutions VALUES(?,?,?)').run(invoice.reference,nature==='service'&&numaronAmount>0?'allocate':'exclude','Von dir bestätigt: CHF '+(amount/100).toFixed(2)+' bezahlt; numaron CHF '+(numaronAmount/100).toFixed(2)+'. '+(nature==='prepaid'?'Guthabenaufladung, kein zusätzlicher Verbrauch.':'Servicekosten.'));
    })();return;
   }
   if(invoice.reason==='ready'||db.prepare('SELECT 1 FROM finance_import_resolutions WHERE reference=?').get(input.reference)||!['allocate','exclude'].includes(input.action)||typeof input.evidence!=='string'||input.evidence.trim().length<10||input.evidence.length>400)throw Error('Resolution unavailable');
   if(input.action==='allocate'&&(!Number.isSafeInteger(input.amount)||input.amount<=0||input.amount>100000000||!/^\d{4}-\d{2}-\d{2}$/.test(input.day??'')||new Date(input.day+'T12:00:00Z').toISOString().slice(0,10)!==input.day||input.day>new Date().toISOString().slice(0,10)))throw Error('Invalid CHF allocation');
   db.transaction(()=>{if(input.action==='allocate')db.prepare('INSERT INTO finance_entries VALUES(?,?,?,?,?,?)').run('import-'+invoice.reference,input.day,'expense',input.amount,invoice.provider+' · '+invoice.invoice+' · numaron-Anteil',invoice.reference);db.prepare('INSERT INTO finance_import_resolutions VALUES(?,?,?)').run(invoice.reference,input.action,input.evidence.trim());})();
  },
  snapshot(){return {checkedAt:db.prepare('SELECT at FROM finance_import_status WHERE id=1').get()?.at??null,invoices:db.prepare('SELECT payload FROM finance_imports ORDER BY reference').all().map(r=>{const invoice=JSON.parse(r.payload),resolution=db.prepare('SELECT kind,evidence FROM finance_import_resolutions WHERE reference=?').get(invoice.reference),payment=db.prepare('SELECT payload FROM finance_invoice_payments WHERE reference=?').get(invoice.reference);return {...invoice,...(payment?{payment:JSON.parse(payment.payload)}:{}),...(resolution?{reason:resolution.kind==='allocate'?'ready':'excluded',resolutionEvidence:resolution.evidence}: {})};})};},
  close:()=>db.close()
 };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [file,input]=process.argv.slice(2);if(!file||!input)throw Error('Required: database and verified import JSON');
 const store=openFounderCostImport(path.resolve(file));try{store.ingest(JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,'')));console.log('Kostenbelege importiert.');}finally{store.close();}
}
