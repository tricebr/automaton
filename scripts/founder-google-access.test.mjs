import test from 'node:test';import assert from 'node:assert/strict';import {createGoogleAccessManager} from './founder-google-access.mjs';
test('one refresh serves parallel callers and a rejected refresh stops access',async()=>{
 let calls=0,saved,clock=Date.now();let value={provider:'google',billingEnabled:false,credential:'expired',refreshToken:'r',expiresAt:clock-1,scope:{account:'numaronia@gmail.com',labelId:'Label_1'}};
 const m=createGoogleAccessManager({read:()=>value,write:v=>{saved=v;value=v;},readClient:()=>({client_id:'id',client_secret:'secret'}),now:()=>clock,request:async()=>{calls++;return Response.json({access_token:'new',expires_in:3600});}});
 await Promise.all([m.refresh(),m.refresh()]);assert.equal(calls,1);assert.equal(saved.scope.labelId,'Label_1');assert.equal(m.current().available,true);
 const bad=createGoogleAccessManager({read:()=>({...value,expiresAt:0}),write(){throw Error('must not save');},readClient:()=>({client_id:'id',client_secret:'secret'}),now:()=>clock,request:async()=>{calls++;return new Response(null,{status:401});}});
 await bad.refresh();await bad.refresh();assert.equal(calls,2);assert.equal(bad.current().available,false);
});
