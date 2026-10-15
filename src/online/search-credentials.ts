import {execFile} from 'node:child_process';
import path from 'node:path';
import {registerLogSecrets} from '../observability/redaction.js';
import {validSearchCredential,type SearchProvider} from './search-adapters.js';

/** Fixed Windows DPAPI read, captured in a private pipe. No shell command from
 * an agent, no credential on argv, no raw child errors returned to callers.
 * DPAPI protects at rest, not against compromise of the same Windows account. */
export async function readSearchCredential(provider:SearchProvider):Promise<string|undefined>{
 if(provider==='ted')return undefined;
 if(!['serper','tavily','exa','brave','firecrawl'].includes(provider)||process.platform!=='win32')throw Error('Protected search credentials unavailable');
 const script=`$ErrorActionPreference='Stop'; try {
 $root=Join-Path $env:LOCALAPPDATA 'Obolus\\SearchCredentials';
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
 $p=Join-Path $root '${provider}.dpapi';
 foreach($entry in @($root,$p)){
  if((Get-Item -LiteralPath $entry).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Link rejected'};
  $acl=Get-Acl -LiteralPath $entry;
  foreach($r in $acl.Access){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'ACL rejected'}}
 };
 if(-not (Get-Acl -LiteralPath $root).AreAccessRulesProtected){throw 'ACL inheritance rejected'};
 $s=ConvertTo-SecureString ([IO.File]::ReadAllText($p));
 $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);
 try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b);$s.Dispose()}
 } catch {exit 1}`;
 const value=await new Promise<string>((resolve,reject)=>{
  execFile(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
   ['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:8192,
    env:Object.fromEntries(['SystemRoot','WINDIR','LOCALAPPDATA','USERPROFILE','TEMP','TMP'].flatMap(k=>process.env[k]?[[k,process.env[k]!]]:[]))},(error,stdout)=>{
    if(error){reject(Error('Protected search credential read failed'));return;}resolve(stdout);
   });
 });
 if(!validSearchCredential(provider,value))throw Error('Protected search credential invalid');
 registerLogSecrets([value]);return value;
}
