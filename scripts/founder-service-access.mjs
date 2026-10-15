import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const providers=new Set(['google','amplitude']);
// The only credential source is a separately provisioned, Windows-user-bound file.
// No Codex credential stores, browser cookies or inherited connector sessions are used.
export function readServiceAccess(provider,{directory=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Numaron'):null,decrypt}={}){
 if(!providers.has(provider)||!directory)return {available:false,reason:'Eigener Dienstzugang fehlt.'};
 try{const file=path.join(directory,`${provider}-access.dpapi`),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64000)throw Error();
 const text=decrypt?decrypt(fs.readFileSync(file,'utf8')):execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"],{input:fs.readFileSync(file).toString('base64'),encoding:'utf8',windowsHide:true,timeout:5000,stdio:['pipe','pipe','ignore']});
 const data=JSON.parse(text);if(data.provider!==provider||data.billingEnabled!==false||!data.scope||typeof data.credential!=='string'||!data.credential||data.credential.length>16000)throw Error();
 if(provider==='google'&&(data.scope.account!=='numaronia@gmail.com'||!Number.isFinite(data.expiresAt)||data.expiresAt<=Date.now()+30000))return {available:false,reason:'Google-Zugang fehlt oder muss erneuert werden.'};
 return {available:true,credential:data.credential,scope:data.scope};
 }catch{return {available:false,reason:'Eigener verschlüsselter Dienstzugang fehlt oder ist ungültig.'};}
}
