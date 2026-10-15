import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {auditFounderTasks} from './founder-task-audit.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const controller=new Database(':memory:'),budget=new Database(':memory:');
 controller.exec("CREATE TABLE founder_control(status TEXT);INSERT INTO founder_control VALUES('running');CREATE TABLE founder_jobs(id TEXT PRIMARY KEY,payload TEXT,status TEXT,reason TEXT,run_id TEXT,result TEXT,digest TEXT,updated_ms INTEGER,attempts INTEGER,next_retry_ms INTEGER);CREATE TABLE founder_events(at TEXT,task_id TEXT,action TEXT);CREATE TABLE founder_reconciliations(task_id TEXT,at TEXT,evidence TEXT);");
 budget.exec('CREATE TABLE founder_reservations(id TEXT,root_task TEXT,max_cost INTEGER,actual_cost INTEGER,receipt TEXT)');
 const add=(id,status='failed',kind='exa-research',cost=0,actual=0,attempts=1)=>{
  const result=status==='done'?JSON.stringify({kind,provider:'exa',sources:[{id:'exa-source',url:'https://github.com/example/project',claim:'Public source',digest:hash('Public source')}],costReceipt:{actualCostRappen:0,evidenceRef:'free:'+id}}):null;
  controller.prepare('INSERT INTO founder_jobs VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id,JSON.stringify({id,rootTaskId:id,kind,input:{},dependencies:[]}),status,'Old failure','run-'+id,result,result?hash(result):null,status==='done'?20:10,attempts);
  budget.prepare('INSERT INTO founder_reservations VALUES(?,?,?,?,?)').run('run-'+id,id,cost,actual,actual===null?null:'free:'+id);
 };
 return {controller,budget,add,close(){controller.close();budget.close();}};
}
test('supersedes only a proven free obsolete search, retains evidence and never changes budget',()=>{
 const f=fixture();try{f.add('old');f.add('new','done');const before=f.budget.serialize();
  assert.equal(auditFounderTasks({...f,power:{enabled:true}}).actions[0].action,'superseded-free-search');assert.equal(f.controller.prepare("SELECT status FROM founder_jobs WHERE id='old'").get().status,'failed');
  const report=auditFounderTasks({...f,power:{enabled:true},apply:true});assert.equal(report.applied,1);assert.equal(f.controller.prepare("SELECT status FROM founder_jobs WHERE id='old'").get().status,'cancelled');assert.deepEqual(f.budget.serialize(),before);assert.equal(auditFounderTasks({...f,power:{enabled:true},apply:true}).applied,0);
 }finally{f.close();}
});
test('unknown paid outcomes and exhausted attempts get truthful reasons without retry or success',()=>{
 const f=fixture();try{f.add('unknown','failed','work-planner',50,null);f.add('exhausted','failed','private-draft',50,12,3);f.add('new','done');
  auditFounderTasks({...f,power:{enabled:true},apply:true});const rows=f.controller.prepare("SELECT id,status,reason,attempts,next_retry_ms FROM founder_jobs WHERE status='failed' ORDER BY id").all();assert.equal(rows.length,2);assert.match(rows[0].reason,/3 Versuche/);assert.match(rows[1].reason,/ungeklärt/);assert.ok(rows.every(r=>r.next_retry_ms===null));assert.equal(f.budget.prepare("SELECT actual_cost FROM founder_reservations WHERE id='run-unknown'").get().actual_cost,null);
 }finally{f.close();}
});
test('does not supersede searches with dependents, positive reservations or unverified replacement',()=>{
 for(const mode of ['dependent','cost','digest']){const f=fixture();try{f.add('old');f.add('new','done');if(mode==='dependent'){f.add('child','queued','work-planner');f.controller.prepare("UPDATE founder_jobs SET payload=? WHERE id='child'").run(JSON.stringify({kind:'work-planner',dependencies:['old']}));}if(mode==='cost')f.budget.exec("UPDATE founder_reservations SET max_cost=50 WHERE id='run-old'");if(mode==='digest')f.controller.exec("UPDATE founder_jobs SET digest='invalid' WHERE id='new'");const r=auditFounderTasks({...f,power:{enabled:true},apply:true});assert.equal(r.actions.some(a=>a.action==='superseded-free-search'),false);assert.equal(f.controller.prepare("SELECT status FROM founder_jobs WHERE id='old'").get().status,'failed');}finally{f.close();}}
});
test('requires the personally started running session for writes',()=>{
 const f=fixture();try{f.add('old');f.add('new','done');assert.throws(()=>auditFounderTasks({...f,power:{enabled:false},apply:true}),/running/);assert.equal(f.controller.prepare("SELECT status FROM founder_jobs WHERE id='old'").get().status,'failed');}finally{f.close();}
});
test('accepts the controller local zero-cost receipt for a verified replacement',()=>{
 const f=fixture();try{f.add('old');f.add('new','done');f.budget.exec("UPDATE founder_reservations SET receipt='local:run-new' WHERE id='run-new'");assert.equal(auditFounderTasks({...f,power:{enabled:true},apply:true}).actions[0].action,'superseded-free-search');}finally{f.close();}
});
