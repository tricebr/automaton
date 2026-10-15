import {createHash} from 'node:crypto';
import type {InferenceRequest,ModelEntry} from '../types.js';
export interface OptimizationRecipe {
 tier:InferenceRequest['tier'];taskType:InferenceRequest['taskType'];maxTokens:number;temperature:number;
 modelId:string;provider:ModelEntry['provider'];modelDigest:string;
}
/** Freeze the local execution/pricing contract, excluding volatile timestamps and labels. */
export function optimizationModelDigest(model:ModelEntry){
 return createHash('sha256').update(JSON.stringify({modelId:model.modelId,provider:model.provider,
  tierMinimum:model.tierMinimum,costPer1kInput:model.costPer1kInput,costPer1kOutput:model.costPer1kOutput,
  maxTokens:model.maxTokens,contextWindow:model.contextWindow,supportsTools:model.supportsTools,
  supportsVision:model.supportsVision,parameterStyle:model.parameterStyle,enabled:model.enabled})).digest('hex');
}
export function canonicalOptimizationRecipe(input:OptimizationRecipe):OptimizationRecipe {
 if(!input||!['dead','critical','low_compute','normal','high'].includes(input.tier)||
  !['agent_turn','heartbeat_triage','safety_check','summarization','planning'].includes(input.taskType)||
  !Number.isSafeInteger(input.maxTokens)||input.maxTokens<1||input.maxTokens>16384||
  !Number.isFinite(input.temperature)||input.temperature<0||input.temperature>2||
  typeof input.modelId!=='string'||!/^[A-Za-z0-9_.:/-]{1,100}$/.test(input.modelId)||
  !['openai','anthropic','conway','ollama','other'].includes(input.provider)||
  typeof input.modelDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.modelDigest))throw Error('Bounded immutable optimization recipe required');
 return {tier:input.tier,taskType:input.taskType,maxTokens:input.maxTokens,temperature:input.temperature,modelId:input.modelId,provider:input.provider,modelDigest:input.modelDigest};
}
