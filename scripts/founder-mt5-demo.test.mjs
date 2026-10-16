import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDemoMt5Readers} from './founder-mt5-demo.mjs';
test('all MT5 readers bind the same explicit demo profile, portable wrapper and zero execution',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'demo-binding-')),file=path.join(dir,'demo.json'),terminal=path.join(dir,'terminal64.exe');
 fs.writeFileSync(file,JSON.stringify({version:1,terminal,login:123,server:'demo-server',portable:true,requireDemo:true,executionEnabled:false}));let calls=[];
 const readers=createDemoMt5Readers({profileFile:file,python:'python',accountReader:async options=>{calls.push(options);return {executionEnabled:false,account:{trade_mode:0}};},run:async(p,args)=>{calls.push(args);return {stdout:JSON.stringify({readOnly:true,executionEnabled:false,accountBinding:{demo:true,tradeMode:0},rows:[],reports:[]})};}});
 try{await readers.account();await readers.market({start:0});await readers.market({watch:['EURUSD']},'trading');await readers.history(['EURUSD']);assert.equal(calls[0].expectedTradeMode,0);assert.equal(calls[0].expectedLogin,123);assert.equal(calls[0].expectedServer,'demo-server');assert.match(calls[0].script,/mt5-demo-readonly.py$/);for(const args of calls.slice(1)){assert.equal(args[args.indexOf('--terminal')+1],terminal);assert.equal(args[args.indexOf('--login')+1],'123');assert.ok(!args.includes('--operation'));}const changed=JSON.parse(fs.readFileSync(file));changed.requireDemo=false;fs.writeFileSync(file,JSON.stringify(changed));await assert.rejects(readers.account());assert.equal(calls.length,4);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing demo profile fails closed without falling back to launch arguments',async()=>{const readers=createDemoMt5Readers({profileFile:path.join(os.tmpdir(),'missing-demo-'+Date.now()),python:'python',accountReader:()=>assert.fail('No fallback')});await assert.rejects(readers.account());});
test('failed process reads do not disclose account identity or command arguments',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'demo-error-')),file=path.join(dir,'profile.json');fs.writeFileSync(file,JSON.stringify({version:1,terminal:path.join(dir,'terminal64.exe'),login:123,server:'demo-server',portable:true,requireDemo:true,executionEnabled:false}));
 const fail=async()=>{throw Error('Command failed with private-account-identity');};const readers=createDemoMt5Readers({profileFile:file,python:'python',accountReader:fail,run:fail});
 try{for(const run of [()=>readers.account(),()=>readers.market()])await assert.rejects(run(),e=>!e.message.includes('private-account-identity'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('another valid demo account requires a new service instance rather than mixing stored observations',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'demo-pinned-')),file=path.join(dir,'profile.json');const profile={version:1,terminal:path.join(dir,'terminal64.exe'),login:123,server:'demo-server',portable:true,requireDemo:true,executionEnabled:false};fs.writeFileSync(file,JSON.stringify(profile));let calls=0;
 const readers=createDemoMt5Readers({profileFile:file,python:'python',accountReader:async()=>{calls++;return {executionEnabled:false,account:{trade_mode:0}};}});
 try{await readers.account();fs.writeFileSync(file,JSON.stringify({...profile,login:456}));await assert.rejects(readers.account());assert.equal(calls,1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('bracketed Admirals symbols stay literal arguments; malformed names remain rejected',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'demo-symbol-')),file=path.join(dir,'profile.json');fs.writeFileSync(file,JSON.stringify({version:1,terminal:path.join(dir,'terminal64.exe'),login:123,server:'demo-server',portable:true,requireDemo:true,executionEnabled:false}));const calls=[];
 const readers=createDemoMt5Readers({profileFile:file,python:'python',run:async(p,args)=>{calls.push(args);return {stdout:JSON.stringify({readOnly:true,executionEnabled:false,accountBinding:{demo:true,tradeMode:0}})};}});
 try{await readers.market({watch:['[DJI30]']},'trading');await readers.history(['[DJI30]']);assert.ok(calls[0].includes('[DJI30]'));assert.equal(calls[1].at(-1),'[DJI30]');for(const symbol of ['--operation','a,b','a\nb','a b','a;z','a'.repeat(81)]){if(symbol==='--operation')continue;assert.throws(()=>readers.market({watch:[symbol]},'trading'));assert.throws(()=>readers.history([symbol]));}assert.equal(calls.length,2);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
