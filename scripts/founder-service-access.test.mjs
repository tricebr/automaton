import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {readServiceAccess} from './founder-service-access.mjs';
import {execFileSync} from 'node:child_process';
test('Windows CurrentUser binary DPAPI credentials round-trip without PowerShell security cmdlets',{skip:process.platform!=='win32'},()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dpapi-roundtrip-'));const value={provider:'amplitude',billingEnabled:false,credential:'synthetic-test-value',scope:{projectId:'878459',region:'us'}};
 const encrypted=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"],{input:JSON.stringify(value),encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','ignore']});
 try{fs.writeFileSync(path.join(directory,'amplitude-access.dpapi'),Buffer.from(encrypted,'base64'));const r=readServiceAccess('amplitude',{directory});assert.equal(r.available,true);assert.equal(r.credential,value.credential);}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('service access rejects billing, wrong account, expiry and malformed credentials without leaking them',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'service-access-'));fs.writeFileSync(path.join(directory,'google-access.dpapi'),'ciphertext');
 const record={provider:'google',billingEnabled:false,credential:'private-value',expiresAt:Date.now()+3600000,scope:{account:'numaronia@gmail.com',labelId:'Label_1'}};
 try{const read=x=>readServiceAccess('google',{directory,decrypt:()=>JSON.stringify(x)});assert.equal(read(record).available,true);
 for(const bad of [{...record,billingEnabled:true},{...record,expiresAt:0},{...record,scope:{account:'personal@example.com'}}]){const r=read(bad);assert.equal(r.available,false);assert.ok(!JSON.stringify(r).includes('private-value'));}
 assert.equal(readServiceAccess('../other',{directory}).available,false);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
