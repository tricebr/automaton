import {openFounderPower} from './founder-power.mjs';
import {openHistoryStore} from '../src/revenue/long-history/store.ts';
import {openHistoryRunner} from '../src/revenue/long-history/runner.ts';
import {createTradeEvidence} from './trade-evidence.mjs';

import {openFounderTrading} from './founder-trading.mjs';

import {tradingKnowledge} from '../src/revenue/trading-knowledge.ts';

import {createTradeRadar,readMarket} from './trade-radar.mjs';

import {loadFounderMission} from './founder-mission.mjs';

import {openFounderBilling} from './founder-billing.mjs';

import {openFounderCostImport} from './founder-cost-import.mjs';

import {openFounderLedger} from './founder-ledger.mjs';



import {openFounderOperations} from './founder-operations.mjs';



import { startFounderDashboard,createFounderStore } from './founder-dashboard.mjs';



import { readMt5Account } from '../src/revenue/mt5-readonly.ts';



import { resolve } from 'node:path';



import { spawn } from 'node:child_process';



import {reconcileFounderFinance} from './founder-finance.mjs';



import { readStripeAccount,readStripeTransactions } from './stripe-account-check.mjs';



import { readCoinbaseAccounts } from './coinbase-account-check.mjs';



import fs from 'node:fs';



import {openTradeJournal} from './trade-journal.mjs';



import {openFounderRuntime} from './founder-runtime.mjs';



import {readFounderKey} from './founder-key.mjs';







const [python, terminal, login, server, coinbaseKeyFile, stripeKeyFile] = process.argv.slice(2);



if (!python || !terminal || !/^\d+$/.test(login ?? '') || !server)



 throw Error('Required: PYTHON TERMINAL LOGIN SERVER');



const options={python:resolve(python),terminal:resolve(terminal),expectedLogin:Number(login),



 expectedServer:server,script:resolve('scripts/mt5-readonly.py')};



fs.mkdirSync(resolve('artifacts/founder-integration-20261012'),{recursive:true});



const tradeJournal=openTradeJournal(resolve('artifacts/founder-integration-20261012/trade-journal.db'));



const operations=openFounderOperations(resolve('artifacts/founder-integration-20261012/founder-operations.db'));



const ledger=openFounderLedger(resolve('artifacts/founder-integration-20261012/founder-finance.db'));



const costImport=openFounderCostImport(resolve('artifacts/founder-integration-20261012/founder-finance.db'));

const getApiKey=()=>{try{return readFounderKey(JSON.parse(fs.readFileSync(resolve('artifacts/founder-autonomy-20261013/provider.json'),'utf8')).keyFile);}catch{return undefined;}};



let power;
const powerOn=()=>power?.isOn()===true;
const autonomy=openFounderRuntime({base:resolve('.'),isEnabled:powerOn,getApiKey,mission:loadFounderMission(),stripeKeyFile:stripeKeyFile?resolve(stripeKeyFile):undefined,activate:true});
await autonomy.checkLocalReadiness();



const tradeEvidence=createTradeEvidence({file:resolve('artifacts/founder-integration-20261012/trade-evidence.json'),python:resolve(python),terminal:resolve(terminal),login,server,script:resolve('scripts/mt5-strategy-evidence.py'),control:()=>powerOn()?autonomy.controlState().status:'stopped'});

const tradeRadar=createTradeRadar({file:resolve('artifacts/founder-integration-20261012/trade-radar.json'),control:()=>powerOn()?autonomy.controlState().status:'stopped',evidence:()=>tradeEvidence.snapshot(),read:async({start})=>{await tradeEvidence.refresh(tradeRadar.snapshot().setups?.map(p=>p.symbol)??[]);const m=await readMarket({start,python:resolve(python),terminal:resolve(terminal),login,server,script:resolve('scripts/mt5-market-readonly.py')});tradeEvidence.observe(m.rows.filter(r=>r.entry).map(r=>r.symbol));return m;}});

const tradingEngine=openFounderTrading({file:resolve('artifacts/founder-integration-20261012/autonomous-trading-research-20261015-v2.db'),knowledge:tradingKnowledge(),historyLessons:()=>longHistory.lessons(),researchControl:()=>powerOn()&&autonomy.controlState().status==='running',read:({start,watch,dayWindow})=>readMarket({start,watch,dayWindow,python:resolve(python),terminal:resolve(terminal),login,server,script:resolve('scripts/mt5-trading-adapter.py')})});

const historyStore=openHistoryStore(resolve('artifacts/numaron-long-history'));
const longHistory=openHistoryRunner({store:historyStore,knowledge:tradingKnowledge()});

const billing=openFounderBilling(resolve('.'),{isEnabled:powerOn});
power=openFounderPower({file:resolve('artifacts/founder-integration-20261012/power-state.jsonl'),modules:[
 {name:'Aufgaben und AI-Fähigkeiten',start(){const s=autonomy.controlState();if(s.status!=='running')autonomy.control({action:s.status==='paused'?'resume':'start',revision:s.revision});autonomy.startLoop();},stop(){const s=autonomy.controlState();autonomy.control({action:'stop',revision:s.revision});}},
 {name:'Langzeit- und Strategieforschung',start(){longHistory.control('resume');longHistory.start();},stop(){longHistory.control('stop');}},
 {name:'Trading-Analyse und Marktbeobachtung',start(){tradeRadar.start();tradingEngine.start();},stop(){tradingEngine.suspend();}},
 {name:'Automatischer Kostenabruf',start(){billing.start();},stop(){billing.pause();}}
]});
power.reconcile();


const ui=await startFounderDashboard({port:51439,power,ledger,costImport,billing,store:createFounderStore(resolve('.'),operations),autonomy,tradeJournal,tradeRadar,tradingEngine,longHistory,readFinance:stripeKeyFile?async()=>reconcileFounderFinance(await readStripeTransactions(resolve(stripeKeyFile),{windowDays:732})):undefined,readStripe:stripeKeyFile?()=>readStripeAccount(resolve(stripeKeyFile)):undefined,readCoinbase:coinbaseKeyFile?()=>readCoinbaseAccounts(resolve(coinbaseKeyFile)):undefined,readTrading:async()=>{



 const result=await readMt5Account(options);



 // No account identifier or server details sent to the browser.



 delete result.account.login;delete result.account.server;



 return result;



}});









const browser=spawn('explorer.exe',[ui.loginUrl],{windowsHide:true,stdio:'ignore'});



browser.on('error',()=>process.stderr.write('Browser opening failed.\n'));browser.unref();



fs.writeFileSync(resolve('artifacts/founder-integration-20261012/runtime-health.json'),JSON.stringify({startedAt:new Date().toISOString(),pid:process.pid,url:ui.url,mode:'private-founder',persistent:true,executionEnabled:true,executionScope:'public-research-private-analysis-readonly-reports',budget:autonomy.snapshot().budget}));



console.log('numaron Founder: '+ui.url);



process.send?.('ready');



for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void ui.close().then(async()=>{await tradeRadar.close();await tradingEngine.close();await longHistory.close();historyStore.close();await autonomy.close();operations.close();ledger.close();costImport.close();billing.close();tradeJournal.close();});});
