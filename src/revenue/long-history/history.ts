import type {ReturnSeries,MacroSeries,ResearchReport} from './types.js';import {assessQuality} from './normalize.js';
export function analyzeHistory(series:ReturnSeries,config:{id:string;runId:string;datasetId:string;start:number;end:number}):ResearchReport{
 if(series.kind!=='factor-returns'||!assessQuality(series).valid)throw Error('Invalid historical return data');
 const rows=series.rows.filter(r=>r.date>=config.start&&r.date<=config.end);if(!rows.length)throw Error('Empty history window');
 let equity=1,peak=1,maximumDrawdown=0;const decades:Record<string,{observations:number;return:number}>={};
 for(const r of rows){equity*=1+r.returnDecimals;peak=Math.max(peak,equity);maximumDrawdown=Math.max(maximumDrawdown,(peak-equity)/peak);const k=String(Math.floor(new Date(r.date).getUTCFullYear()/10)*10);const d=decades[k]??{observations:0,return:0};d.return=(1+d.return)*(1+r.returnDecimals)-1;d.observations++;decades[k]=d;}
 if(!Number.isFinite(equity))throw Error('Historical arithmetic limit');
 return {id:config.id,runId:config.runId,datasetId:config.datasetId,kind:'history',nativeCurrency:series.currency,costStatus:'gross',metrics:{observations:rows.length,start:rows[0].date,end:rows.at(-1)!.date,totalReturn:equity-1,maximumDrawdown,decades},limitations:[...series.limitations,'Retrospektive Beschreibung, kein kausaler Nachweis und keine nach Kosten handelbare Strategie.'],decision:'weiter untersuchen',evidenceHashes:[],liveAuthorized:false};
}
export function analyzeMacroHistory(series:MacroSeries,config:{id:string;runId:string;datasetId:string;start:number;end:number}):ResearchReport{
 if(!assessQuality(series).valid)throw Error('Invalid macro history');const rows=series.rows.filter(r=>r.date>=config.start&&r.date<=config.end);if(!rows.length)throw Error('Empty macro window');
 const values=rows.map(r=>r.annualRatePercent),decades:Record<string,{observations:number;meanAnnualRatePercent:number}>={};for(const r of rows){const key=String(Math.floor(new Date(r.date).getUTCFullYear()/10)*10);const d=decades[key]??{observations:0,meanAnnualRatePercent:0};d.meanAnnualRatePercent=(d.meanAnnualRatePercent*d.observations+r.annualRatePercent)/(d.observations+1);d.observations++;decades[key]=d;}
 return {id:config.id,runId:config.runId,datasetId:config.datasetId,kind:'macro-history',nativeCurrency:series.currency,costStatus:'unknown',metrics:{observations:rows.length,start:rows[0].date,end:rows.at(-1)!.date,minimumAnnualRatePercent:Math.min(...values),maximumAnnualRatePercent:Math.max(...values),latestAnnualRatePercent:values.at(-1),decades},limitations:[...series.limitations,'Zinsphasen begründen eine Finanzierungshypothese, keinen kausalen Handelsvorteil.'],decision:'weiter untersuchen',evidenceHashes:[],liveAuthorized:false};
}
