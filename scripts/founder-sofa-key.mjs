import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
// Windows-user bound DPAPI ciphertext, outside the repository. Never read Codex OAuth stores.
export function readSofaCredential(){
 if(process.platform!=='win32'||!process.env.LOCALAPPDATA)return undefined;
 const file=path.join(process.env.LOCALAPPDATA,'Numaron','sofa-key.dpapi');if(!fs.existsSync(file))return undefined;
 try{const key=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Join-Path $env:LOCALAPPDATA 'Numaron/sofa-key.dpapi'; $s=(Get-Content -LiteralPath $p -Raw).Trim() | ConvertTo-SecureString; [Console]::Write([System.Net.NetworkCredential]::new('', $s).Password)"],{encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','ignore']});return key.length>20&&!/[\r\n]/.test(key)?key:undefined;}catch{return undefined;}
}
