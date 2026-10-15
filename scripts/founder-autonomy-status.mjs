import {supplementsVersion} from './founder-autonomy-policy.mjs';
export function autonomyStatus({tasks=[],capabilities=[]}={}){
 const exceptions=tasks.filter(t=>['blocked','failed'].includes(t.status)).map(t=>{
  const code=t.diagnostic?.code;
  const nextAction=Number.isFinite(t.nextRetryAt)?'scheduled-retry':t.reason==='Budget daily limit'?'wait-for-budget':t.reason==='Voraussetzung nicht erfolgreich abgeschlossen.'?'wait-for-dependency':code==='invalid_api_key'?'restore-account-access':code==='provider_outcome_unknown'||/Kosten.*abgeglichen|Kosten.*reserviert/.test(t.reason??'')?'reconcile-provider-outcome':code==='insufficient_quota'?'wait-for-provider-quota':'technical-recovery';
  const requiresHuman=nextAction==='restore-account-access';
  return {taskId:t.id,owner:requiresHuman?'founder':'numaron',requiresHuman,nextAction,nextRetryAt:t.nextRetryAt??null};
 });
 return {mode:'self-directed',supplementsVersion,controls:['start','pause','resume','stop','emergency-stop'],complete:false,completionReason:'General isolated code execution and public submission have not passed end-to-end acceptance.',exceptions,capabilityGaps:capabilities.filter(c=>c.status==='blocked').map(({kind,reason})=>({kind,reason}))};
}
