import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTradingEngine} from '../web/founder/trading.mjs';
class Element {constructor(){this.children=[];this.textContent='';}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}text(){return this.textContent+' '+this.children.map(c=>c.text()).join(' ');}}
test('forward observations without a final quote display an unknown result without crashing',()=>{
 const saved=global.document;global.document={createElement:()=>new Element()};
 try{
  const box=new Element();
  renderTradingEngine(box,{forward:{open:[],totalOpen:0,totalClosed:2,closed:[{symbol:'EURUSD',reason:'timeout-no-quote',grossR:null,exitAt:null,coverageGap:true},{symbol:'GBPUSD',reason:'stop',grossR:-1,exitAt:1800000000000}]}},()=>{});
  const text=box.text();assert.match(text,/EURUSD · Zeitlimit ohne neuen Kurs · Ergebnis unbekannt/);assert.match(text,/GBPUSD · Stop beobachtet · -1.00 R vor Gebühren/);assert.doesNotMatch(text,/1\.1\.1970|01\.01\.1970|Invalid Date/);
 }finally{global.document=saved;}
});
test('dashboard distinguishes new research observations, loss reasons and incomplete costs',()=>{const saved=global.document;global.document={createElement:()=>new Element()};try{const box=new Element();renderTradingEngine(box,{status:'waiting',optimization:{startedAt:1800000000000,variants:[{id:'spread',open:2,known:0,unknown:3,filtered:4,stop:1,timeout:2,scenarioR:0,stressScenarioR:0,filterReasons:{'spread-too-high':4}}],researchLeader:null,limitation:'Neue Beobachtungen, keine Ausführung.',archiveFull:false}},()=>{});const text=box.text();assert.match(text,/Strategieoptimierung · neue Daten/);assert.match(text,/Hohe Spreadbelastung vermeiden/);assert.match(text,/3 mit unklarem Verlauf/);assert.match(text,/Spread zu hoch: 4/);assert.match(text,/Kommission, Finanzierung/);assert.match(text,/Noch kein ausreichend belegter Forschungsfavorit/);}finally{global.document=saved;}});
