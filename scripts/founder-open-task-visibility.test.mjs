import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import Database from 'better-sqlite3';
import {openFounderController} from './founder-controller.mjs';
test('all older open tasks remain visible beyond 100 newer completed tasks without starting or changing work',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'numaron-open-visibility-'));let calls=0;
 const budget={snapshot:()=>({active:false,entries:[],remainingRappen:0,dayRemainingRappen:0}),reserve(){calls++;throw Error('No provider work allowed');},settle(){calls++;}};
 const c=openFounderController({file:path.join(dir,'controller.db'),budget,adapters:{read:{maxCostRappen:0}}}),db=new Database(c.databaseFile);
 try{
  const add=id=>c.enqueue({id,rootTaskId:id,kind:'read',input:{title:id},dependencies:[],resources:[]});
  for(const status of ['queued','blocked','failed','running','verifying']){add('old-'+status);db.prepare('UPDATE founder_jobs SET status=?,created_ms=1 WHERE id=?').run(status,'old-'+status);}
  for(let i=0;i<150;i++){const id='recent-'+i;add(id);db.prepare("UPDATE founder_jobs SET status='done',created_ms=?,result='{}' WHERE id=?").run(1000+i,id);}
  const before=db.serialize(),s=c.snapshot();
  for(const status of ['queued','blocked','failed','running','verifying'])assert.ok(s.tasks.some(t=>t.id==='old-'+status),status);
  assert.equal(s.tasks.filter(t=>t.status==='done').length,100);assert.equal(s.tasks.length,105);assert.equal(s.taskCounts.done,150);assert.deepEqual(db.serialize(),before);assert.equal(calls,0);assert.equal(s.status,'stopped');
 }finally{db.close();await c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
