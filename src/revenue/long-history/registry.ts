import {HISTORY_LIMITS,type RunConfig} from './types.js';import type {HistoryStore} from './store.js';
export type RegisteredRun=RunConfig;
export function registerRun(store:HistoryStore,config:RunConfig):RegisteredRun{
 if(!Array.isArray(config.datasetIds)||!config.datasetIds.length||config.datasetIds.length>3||!Array.isArray(config.variantIds)||!config.variantIds.length||config.variantIds.length>HISTORY_LIMITS.variants||new Set(config.variantIds).size!==config.variantIds.length)throw Error('Research limit');
 if(!Number.isSafeInteger(config.seed)||!config.rulesVersion||! /^[a-f0-9]{64}$/.test(config.codeHash)||![config.registeredAt,config.split.developmentEnd,config.split.validationEnd,config.split.finalEnd].every(Number.isFinite)||!(config.split.developmentEnd<config.split.validationEnd&&config.split.validationEnd<config.split.finalEnd))throw Error('Invalid registration');
 for(const id of config.datasetIds){const d=store.getDataset(id);if(!d||!d.quality.valid||store.getSource(d.sourceId)?.licenseStatus!=='allowed')throw Error('Dataset unavailable');}
 store.saveRun(config);return store.getRun(config.id)!;
}
export function phaseView(store:HistoryStore,runId:string,phase:'development'|'validation'|'final',datasetId:string){
 const r=store.getRun(runId),d=store.getDataset(datasetId);if(!r||!d||!r.datasetIds.includes(datasetId)||!['development','validation','final'].includes(phase))throw Error('Unregistered phase');
 const start=phase==='development'?d.start:phase==='validation'?r.split.developmentEnd+1:r.split.validationEnd+1;
 const end=phase==='development'?r.split.developmentEnd:phase==='validation'?r.split.validationEnd:r.split.finalEnd;
 return {phase,start:Math.max(d.start,start,r.requestedStart??d.start),end:Math.min(d.end,end)};
}
export function claimFinalEvaluation(store:HistoryStore,runId:string,variantId:string,datasetId:string){const v=phaseView(store,runId,'final',datasetId);if(v.start>v.end)throw Error('Empty final phase');return store.claimFinal(runId,variantId,datasetId,v.start,v.end);}
