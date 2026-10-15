import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {openHistoryStore} from '../src/revenue/long-history/store.ts';import {openHistoryRunner} from '../src/revenue/long-history/runner.ts';import {tradingKnowledge} from '../src/revenue/trading-knowledge.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function executeHistoryCommand(argv,{directory=resolve(root,'artifacts/numaron-long-history')}={}){
 const command=argv[0];if(!['status','sources','import','run','pause','resume','stop','report'].includes(command))throw Error('Unbekannter Forschungsbefehl');
 if(['import','report'].includes(command)){if(argv.length!==3||argv[1]!== (command==='import'?'--source':'--id')||!/^[a-zA-Z0-9_-]{1,100}$/.test(argv[2]))throw Error('Ungültige Forschungsargumente');}else if(argv.length!==1)throw Error('Unerwartete Forschungsargumente');
 const store=openHistoryStore(directory),runner=openHistoryRunner({store,knowledge:tradingKnowledge()});try{
  if(command==='sources')return runner.sources();if(command==='report')return runner.report(argv[2]);
  if(command==='import'){const source=store.getSource(argv[2]);if(!source||source.licenseStatus!=='allowed')throw Error('Nutzungsrechte dieser Quelle nicht freigegeben');const previous=runner.snapshot().status;runner.control('resume');await runner.tick({sourceId:source.id,importOnly:true});if(previous!=='running')runner.control(previous==='stopped'?'stop':'pause');const result=store.listDatasets().find(d=>d.sourceId===source.id);if(!result)throw Error(runner.snapshot().blockers.join(' · ')||'Datenimport fehlgeschlagen');return result;}
  if(command==='run'){runner.control('resume');await runner.tick();const s=runner.snapshot();if(!s.counts.datasets||!s.counts.reports)throw Error(s.blockers.join(' · ')||'Keine echten Forschungsdaten verfügbar');return s;}
  if(['pause','resume','stop'].includes(command))return runner.control(command);
  return runner.snapshot();
 }finally{await runner.close();store.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))executeHistoryCommand(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
