import fs from 'node:fs';import path from 'node:path';
export function openFounderPower({file,modules=[]}){
 let state={enabled:false,revision:0};
 try{const saved=JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n').at(-1));if(typeof saved.enabled==='boolean'&&Number.isSafeInteger(saved.revision)&&saved.revision>=0)state={...saved,enabled:false,revision:saved.revision+Number(saved.enabled),cause:'startup-off'};}catch{}
 const write=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,JSON.stringify(state)+'\n',{flush:true})};
 write();
 const stop=()=>{const errors=[];for(const m of modules)try{m.stop()}catch{errors.push(m.name)}return errors};
 const snapshot=()=>({enabled:state.enabled,status:state.enabled?'on':'off',revision:state.revision,changedAt:state.changedAt??null,modules:modules.map(m=>({name:m.name,enabled:state.enabled})),liveTradingEnabled:false});
 return {snapshot,isOn:()=>state.enabled,
 reconcile(){if(!state.enabled){stop();return snapshot()}try{for(const m of modules)m.start();return snapshot()}catch{state={enabled:false,revision:state.revision+1,changedAt:new Date().toISOString()};stop();try{write()}catch{}throw Error('Numaron bleibt ausgeschaltet: Start einer Fähigkeit fehlgeschlagen.')}},
 control(input){if(!input||Object.keys(input).sort().join(',')!=='enabled,revision'||typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.revision))throw Error('Ungültige Ein-/Aus-Aktion.');if(input.enabled&&input.revision!==state.revision)throw Error('Betriebszustand geändert. Bitte aktualisieren.');state={enabled:input.enabled,revision:state.revision+1,changedAt:new Date().toISOString(),cause:input.enabled?'explicit-start-request':'stop-request'};
 if(!input.enabled){const errors=stop();try{write()}catch{throw Error('Numaron gestoppt; Ausschaltzustand konnte nicht gespeichert werden. Beim Neustart bleibt Numaron aus.')}if(errors.length)throw Error('Ausgeschaltet; einzelne laufende Dienste konnten den Stopp noch nicht bestätigen.');return snapshot()}
 try{write()}catch{state={...state,enabled:false};stop();throw Error('Start verweigert: Betriebszustand konnte nicht gespeichert werden.')}return this.reconcile();}
 };
}
