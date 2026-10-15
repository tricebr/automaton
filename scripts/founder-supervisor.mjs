import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'artifacts/founder-integration-20261012');
const config=JSON.parse(fs.readFileSync(path.join(directory,'launch-config.json'),'utf8'));
if(!Array.isArray(config.args)||config.args.length!==6||config.args.some(v=>typeof v!=='string'||v.includes('\0')))throw Error('Invalid local launch configuration');
const log=fs.openSync(path.join(directory,'service.log'),'a');
let child,stopping=false,restarts=0,timer;
function state(status){fs.writeFileSync(path.join(directory,'service-status.json'),JSON.stringify({at:new Date().toISOString(),status,supervisorPid:process.pid,childPid:child?.pid,restarts,url:'http://127.0.0.1:51439',paidExecution:'See authenticated controller budget and capabilities'},null,2));}
function launch(){
 child=spawn(process.execPath,['--import','tsx','scripts/founder-mt5.mjs',...config.args],{cwd:root,windowsHide:true,stdio:['ignore',log,log,'ipc']});
 state('starting');
 child.on('message',message=>{if(message==='ready')state('running');});
 child.once('error',()=>{state('launch-failed');});
 child.once('exit',code=>{
  if(stopping){state('stopped');return;}
  if(code===0){state('stopped');return;}
  if(++restarts>5){state('needs-attention');return;}
  state('restarting');timer=setTimeout(launch,Math.min(30000,2000*restarts));
 });
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;clearTimeout(timer);child?.kill();});
launch();
