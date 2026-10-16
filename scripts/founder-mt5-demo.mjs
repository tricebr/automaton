import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {readMt5Account} from '../src/revenue/mt5-readonly.ts';
const wrapper=path.resolve(import.meta.dirname,'mt5-demo-readonly.py');
export function readDemoProfile(file){
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8000)throw Error('Demo profile unavailable');
 const p=JSON.parse(fs.readFileSync(file,'utf8'));
 if(Object.keys(p).sort().join(',')!=='executionEnabled,login,portable,requireDemo,server,terminal,version'||p.version!==1||p.portable!==true||p.requireDemo!==true||p.executionEnabled!==false||!path.isAbsolute(p.terminal??'')||path.basename(p.terminal).toLowerCase()!=='terminal64.exe'||!Number.isSafeInteger(p.login)||p.login<1||typeof p.server!=='string'||!p.server||p.server.length>150||/[\r\n\0]/.test(p.server))throw Error('Strict demo profile required');
 return p;
}
export function createDemoMt5Readers({profileFile,python,accountReader=readMt5Account,run=promisify(execFile)}){
 let pinned=null;
 const load=()=>{const p=readDemoProfile(profileFile),serialized=JSON.stringify(p);if(pinned!==null&&pinned!==serialized)throw Error('Demo profile changed; controlled restart and account storage review required');pinned??=serialized;return p;};
 const base=(p,reader)=>[wrapper,'--reader',reader,'--terminal',p.terminal,'--login',String(p.login),'--server',p.server];
 const read=async(reader,extra=[])=>{const p=load();let stdout;try{({stdout}=await run(python,[...base(p,reader),...extra],{timeout:45000,maxBuffer:1048576,windowsHide:true}));}catch{throw Error('Demo-only MT5 reader unavailable; no fallback');}const result=JSON.parse(stdout);
  if(result.readOnly!==true||result.executionEnabled!==false||result.accountBinding?.demo!==true||result.accountBinding?.tradeMode!==0)throw Error('Demo-only read evidence missing');
  if(JSON.stringify(load())!==JSON.stringify(p))throw Error('Demo profile changed during read');return result;
 };
 return {
  async account(){const p=load();let result;try{result=await accountReader({python,terminal:p.terminal,script:wrapper,expectedLogin:p.login,expectedServer:p.server,expectedTradeMode:0,scriptArgs:['--server',p.server]});}catch{throw Error('Demo-only MT5 account unavailable; no fallback');}if(result.account.trade_mode!==0||result.executionEnabled!==false||JSON.stringify(load())!==JSON.stringify(p))throw Error('Demo account not confirmed');return result;},
  market({start=0,watch=[],dayWindow}={},reader='market'){
   if(!['market','trading'].includes(reader)||!Number.isSafeInteger(start)||start<0||!Array.isArray(watch)||watch.length>100||watch.some(x=>typeof x!=='string'||!/^[\w.#\[\]-]{1,80}$/.test(x)))throw Error('Invalid demo market read');
   return read(reader,['--start',String(start),...(reader==='trading'?watch.flatMap(x=>['--watch',x]):[]),...(reader==='trading'&&dayWindow?['--day-start',String(dayWindow.startsAt),'--day-end',String(dayWindow.endsAt)]:[])]);
  },
  history(symbols){if(!Array.isArray(symbols)||symbols.length>5||symbols.some(x=>typeof x!=='string'||!/^[\w.#\[\]-]{1,80}$/.test(x)))throw Error('Invalid demo history read');return read('history',['--symbols',symbols.join(',')]);}
 };
}
