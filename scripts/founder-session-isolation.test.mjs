import test from 'node:test';import assert from 'node:assert/strict';
import {startFounderDashboard} from './founder-dashboard.mjs';
test('independent local dashboards use different cookies and stay logged in together',async()=>{
 const make=()=>startFounderDashboard({store:{snapshot:()=>({fixture:true})},readUsage:async()=>({status:'fixture'})});
 const a=await make(),b=await make();
 const login=async ui=>{const r=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({token:new URL(ui.loginUrl).hash.slice(1)})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 try{const ca=await login(a),cb=await login(b);assert.notEqual(ca.split('=')[0],cb.split('=')[0]);const cookie=ca+'; '+cb;
  for(const ui of [a,b])assert.equal((await fetch(ui.url+'/api/snapshot',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(a.url+'/api/snapshot',{headers:{Cookie:cb}})).status,401);
 }finally{await a.close();await b.close();}
});
