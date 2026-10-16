import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import Database from 'better-sqlite3';import {openFounderController} from './founder-controller.mjs';
test('older completed prerequisites of open work remain available with title and done status outside recent history',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'numaron-prerequisites-'));let writes=0;const budget={snapshot:()=>({active:false,entries:[]}),reserve(){writes++;},settle(){writes++;}};
 const c=openFounderController({file:path.join(dir,'controller.db'),budget,adapters:{read:{maxCostRappen:0}}}),db=new Database(c.databaseFile);
 const add=(id,dependencies=[])=>c.enqueue({id,rootTaskId:'root',kind:'read',input:{title:'Titel '+id},dependencies,resources:[]});
 try{add('old-proof');add('unrelated-old');db.exec("UPDATE founder_jobs SET status='done',created_ms=1,result='{}'");
  for(let i=0;i<140;i++){const id='new-'+i;add(id);db.prepare("UPDATE founder_jobs SET status='done',created_ms=? WHERE id=?").run(1000+i,id);}
  add('waiting',['old-proof','missing-proof']);const before=db.serialize(),tasks=c.snapshot().tasks;
  const prerequisite=tasks.find(t=>t.id==='old-proof');assert.equal(prerequisite?.status,'done');assert.equal(prerequisite.input.title,'Titel old-proof');assert.equal(tasks.some(t=>t.id==='unrelated-old'),false);assert.equal(tasks.some(t=>t.id==='missing-proof'),false);assert.equal(tasks.filter(t=>t.status==='done').length,101);assert.deepEqual(db.serialize(),before);assert.equal(writes,0);
 }finally{db.close();await c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
