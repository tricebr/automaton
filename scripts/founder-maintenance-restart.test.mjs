import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Run a copied launcher with only fake processes and a temporary power log.
function restart(saved,changeDuringLookup=false) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'founder-maintenance-'));
 try {
  fs.mkdirSync(path.join(dir,'scripts'));
  fs.copyFileSync(new URL('./start-numaron-founder.ps1',import.meta.url),path.join(dir,'scripts/start-numaron-founder.ps1'));
  const runtime=path.join(dir,'artifacts/founder-integration-20261012');fs.mkdirSync(runtime,{recursive:true});
  if(saved!==undefined)fs.writeFileSync(path.join(runtime,'power-state.jsonl'),JSON.stringify(saved)+'\n');
  const harness=path.join(dir,'harness.ps1');
  fs.writeFileSync(harness,`
$global:actions = [System.Collections.Generic.List[string]]::new()
function Get-NetTCPConnection { [pscustomobject]@{OwningProcess=101} }
function Get-CimInstance { param($ClassName,$Filter) if($Filter -match '101'){[pscustomobject]@{CommandLine='node scripts/founder-mt5.mjs';ParentProcessId=102;ProcessId=101}}else{[pscustomobject]@{CommandLine='node scripts/founder-supervisor.mjs';ProcessId=102}} }
${changeDuringLookup ? `function Get-CimInstance { param($ClassName,$Filter) '{"enabled":true,"revision":9}' | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'artifacts/founder-integration-20261012/power-state.jsonl'); if($Filter -match '101'){[pscustomobject]@{CommandLine='node scripts/founder-mt5.mjs';ParentProcessId=102;ProcessId=101}}else{[pscustomobject]@{CommandLine='node scripts/founder-supervisor.mjs';ProcessId=102}} }` : ''}
function Stop-Process { param($Id) $global:actions.Add('stop') }
function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle) $global:actions.Add('launch') }
function Get-Command { [pscustomobject]@{Source='fake-node.exe'} }
try { & (Join-Path $PSScriptRoot 'scripts/start-numaron-founder.ps1') -Restart | Out-Null; $problem=$null } catch { $problem=$_.Exception.Message }
[pscustomobject]@{actions=@($global:actions);problem=$problem} | ConvertTo-Json -Compress
`);
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-File',harness],{encoding:'utf8',windowsHide:true}));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
test('maintenance restart refuses ON before stopping any process',()=>{
 const r=restart({enabled:true,revision:8});assert.deepEqual(r.actions,[]);assert.match(r.problem,/eingeschaltet/);
});
test('maintenance restart refuses an unknown power state before stopping any process',()=>{
 const r=restart(undefined);assert.deepEqual(r.actions,[]);assert.match(r.problem,/Betriebszustand/);
});
test('maintenance restart accepts a verified OFF state with fake processes only',()=>{
 const r=restart({enabled:false,revision:7});assert.equal(r.problem,null);assert.deepEqual(r.actions,['stop','stop','launch']);
});
test('maintenance restart refuses malformed enabled values',()=>{
 const r=restart({enabled:'false',revision:7});assert.deepEqual(r.actions,[]);assert.match(r.problem,/Betriebszustand/);
});
test('maintenance restart rechecks a new personal start before stopping processes',()=>{
 const r=restart({enabled:false,revision:7},true);assert.deepEqual(r.actions,[]);assert.match(r.problem,/eingeschaltet/);
});
