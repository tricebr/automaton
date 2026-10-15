import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {buildGenesisSection} from '../src/agent/genesis.ts';
export function loadFounderMission(file=path.join(os.homedir(),'.automaton','automaton.json')){
 try{return prepareMission({directive:JSON.parse(fs.readFileSync(file,'utf8')).genesisPrompt});}catch{return null;}
}
export function prepareMission(mission){
 try{if(typeof mission?.directive!=='string'||!mission.directive.trim())return null;const section=buildGenesisSection(mission.directive);const bytes=Buffer.byteLength(section);if(bytes>56000)return null;return Object.freeze({directive:mission.directive,section,bytes,digest:createHash('sha256').update(section).digest('hex')});}catch{return null;}
}
