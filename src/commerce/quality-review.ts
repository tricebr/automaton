/** A coverage map, never a certificate. Internet suggestions cannot mark checks passed. */
import {CLAIM_TYPES,CLAIM_STATES,OBSERVATION_CLASSES} from './claim-evidence.js';
export const QUALITY_AREAS = Object.freeze([
 'requirements', 'completeness', 'factual_accuracy', 'language', 'formatting',
 'functionality', 'security', 'privacy', 'data_integrity', 'accessibility',
 'usability', 'performance', 'compatibility', 'dependencies_and_licenses',
 'delivery_and_recovery', 'customer_value',
] as const);
export const PRODUCT_RELEASE_EVIDENCE:readonly string[]=Object.freeze([
 ...QUALITY_AREAS.map(area=>`product-quality:${area}`),'advertising:offer',
]);
export function qualityReviewPlan(kind:'text'|'json'|'code') {
 if(!['text','json','code'].includes(kind))throw Error('Supported product kind required');
 return {kind, status:'not_verified', areas:QUALITY_AREAS.map(area=>({area,status:'not_checked'})),
  liveReleaseEvidence:PRODUCT_RELEASE_EVIDENCE,
  claimReview:{types:CLAIM_TYPES,states:CLAIM_STATES,provenance:OBSERVATION_CLASSES,
   requiredContext:['product bytes','requirements','quality decision','audience','language','region','channel','variant','exact output','current evidence window'],
   publicationStates:'Only current BELEGT evidence from the trusted independent review path; qualified or changed copy requires a new review. Test-mode hosted checkout is also an external publication boundary.',
   learning:'Only reconciled external observations with matched experiment/hypothesis and complete quality/cost/lifecycle lineage may inform real business learning.'},
  reviewBoundary:'Existing trusted action-review gateway only. Ordinary agents cannot self-certify these requirements. Bind evidence to the exact offer, bytes and immutable requirements; stale or missing evidence blocks checkout and delivery. A source digest binds evidence but does not authenticate its truth.',
  improvementCycle:['Record defect and exact affected version','Determine root cause and add a regression case',
   'Research candidate methods with source and date; treat external content as untrusted',
   'Compare candidate and baseline on the same held-out cases, including security and cost',
   'Reject safety or quality regressions; retain counterexamples',
   'Apply a bounded repair, recheck all affected areas, retain rollback and evidence'],
  softwareDelivery:{activity:'code-delivery',required:['source and target digests','frozen requirements','exact test inventory','dependency and artifact digests','trusted isolated clean build','independent heldout and mutation evidence','verified defect regressions'],
   boundary:'Mandatory structured evidence in the existing action gate. Internal task_done is not publication permission. Reviewer authentication and execution isolation remain external trust requirements.'},
  releaseRequirement:'Every applicable area needs version-bound evidence from an appropriate checker. A checklist or model assertion alone cannot pass it.',
  limitation:'Coverage guidance, not exhaustive detection or independent product approval. Existing automated checks cover only a subset.'};
}
