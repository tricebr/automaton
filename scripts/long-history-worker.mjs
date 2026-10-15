import {parentPort,workerData} from 'node:worker_threads';
import {evaluateCashTrial,completeFamilyReports} from '../src/revenue/long-history/evaluate.ts';
try {
 if(workerData.kind==='cash')parentPort.postMessage({ok:true,value:evaluateCashTrial(workerData.series,workerData.registration,workerData.variantId)});
 else if(workerData.kind==='family')parentPort.postMessage({ok:true,value:completeFamilyReports(workerData.reports,workerData.seed,workerData.expectedVariants)});
 else throw Error('Unsupported research worker job');
} catch(error){parentPort.postMessage({ok:false,error:error.message});}
