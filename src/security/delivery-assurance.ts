/** Trusted reviewer evidence only. Digests bind scope; they do not authenticate a runner. */
export const DELIVERY_CHECKS = Object.freeze(['requirements', 'build', 'typecheck', 'tests', 'integration',
  'heldout', 'mutation', 'security', 'dependencies', 'artifact'] as const);
export type DeliveryCheckKind = typeof DELIVERY_CHECKS[number];
export interface DeliverySubject {
  sourceDigest: string; targetDigest: string; requirementsDigest: string;
  testInventoryDigest: string; dependencyDigest: string; artifactDigest: string;
}
export interface DeliveryEvidence {
  subject: DeliverySubject;
  implementer: string; reviewer: string; runner: string;
  frozenAt: number; implementationStartedAt: number; checkedAt: number; expiresAt: number;
  requirements: {id: string; checkIds: string[]; resolved: boolean}[];
  checks: {id: string; kind: DeliveryCheckKind; passed: boolean; subject: DeliverySubject;
    evidenceDigest: string; startedAt: number; finishedAt: number}[];
  inventory: {expected: string[]; executed: string[]; skipped: string[]; previous: string[]; retired: never[]};
  isolation: {approvedRunnerDigest: string; hostFallback: false; network: 'none'; cleanBuild: true};
  heldout: {curator: string; suiteDigest: string; exposedBeforeImplementation: false};
  mutation: {required: string[]; detected: string[]};
  defects: {category: DefectCategory; regressionCheckIds: string[]; rootCauseDigest: string;
    correctionDigest: string; reworkMinutes: number; directCashCostCents: number}[];
}
export type DefectCategory = 'integration' | 'test_discovery' | 'fixture' | 'protocol' | 'security';
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,180}$/.test(v);
const clock = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10000 &&
  Array.from(v).every(id) && new Set(v).size === v.length;
export function sameDeliverySubject(a: DeliverySubject, b: DeliverySubject): boolean {
  const keys = ['sourceDigest','targetDigest','requirementsDigest','testInventoryDigest','dependencyDigest','artifactDigest'] as const;
  return !!a && !!b && keys.every(k => digest(a[k]) && a[k] === b[k]);
}
/** Fixed lessons change required verification, never permissions, profit or safety limits. */
export function deliveryLearningChecks(categories: readonly DefectCategory[]): DeliveryCheckKind[] {
  const map: Record<DefectCategory, DeliveryCheckKind[]> = {
    integration: ['integration','build'], test_discovery: ['tests','mutation'],
    fixture: ['typecheck','heldout'], protocol: ['integration','mutation'], security: ['security','heldout'],
  };
  if (!Array.isArray(categories) || categories.length > 100 || !Array.from(categories).every(c => Object.hasOwn(map,c)))
    throw Error('Invalid delivery defect categories');
  return [...new Set(categories.flatMap((c: DefectCategory) => map[c]))];
}
/** Fail closed on malformed, stale, incomplete or contradictory attestations. No execution. */
export function deliveryDecision(e: DeliveryEvidence | undefined, subject: DeliverySubject | undefined, now: number): string | null {
  try {
    if (!e || !subject) return 'DELIVERY_EVIDENCE_ABSENT';
    if (!clock(now) || !sameDeliverySubject(e.subject, subject)) return 'DELIVERY_SCOPE_CHANGED';
    if (![e.implementer,e.reviewer,e.runner].every(id) || e.implementer === e.reviewer) return 'DELIVERY_INDEPENDENT_REVIEW_REQUIRED';
    if (![e.frozenAt,e.implementationStartedAt,e.checkedAt,e.expiresAt].every(clock) ||
      e.frozenAt > e.implementationStartedAt || e.implementationStartedAt > e.checkedAt || e.checkedAt > now ||
      e.expiresAt <= e.checkedAt || e.expiresAt - e.checkedAt > 7*86400000) return 'DELIVERY_CLOCK_INVALID';
    if (e.expiresAt <= now) return 'DELIVERY_STALE';
    if (!e.isolation || !digest(e.isolation.approvedRunnerDigest) || e.isolation.hostFallback !== false ||
      e.isolation.network !== 'none' || e.isolation.cleanBuild !== true) return 'DELIVERY_ISOLATION_REQUIRED';
    if (!e.heldout || !id(e.heldout.curator) || e.heldout.curator === e.implementer ||
      !digest(e.heldout.suiteDigest) || e.heldout.exposedBeforeImplementation !== false) return 'DELIVERY_HELDOUT_REQUIRED';
    if (!Array.isArray(e.checks) || !e.checks.length || e.checks.length > 500 ||
      !ids(e.checks.map(c => c.id)) || e.checks.some(c => !DELIVERY_CHECKS.includes(c.kind) || c.passed !== true ||
        !digest(c.evidenceDigest) || !sameDeliverySubject(c.subject,subject) || !clock(c.startedAt) || !clock(c.finishedAt) ||
        c.startedAt < e.implementationStartedAt || c.finishedAt < c.startedAt || c.finishedAt > e.checkedAt)) return 'DELIVERY_CHECK_FAILED';
    if (DELIVERY_CHECKS.some(kind => !e.checks.some(c => c.kind === kind))) return 'DELIVERY_CHECK_MISSING';
    if (!Array.isArray(e.requirements) || !e.requirements.length || e.requirements.length > 200 ||
      !ids(e.requirements.map(r => r.id)) || e.requirements.some(r => r.resolved !== true || !ids(r.checkIds) ||
        !r.checkIds.length || r.checkIds.some(checkId => !e.checks.some(c => c.id === checkId)))) return 'DELIVERY_REQUIREMENTS_UNRESOLVED';
    const i = e.inventory;
    if (!i || ![i.expected,i.executed,i.skipped,i.previous,i.retired].every(ids) || !i.expected.length ||
      i.skipped.length || i.retired.length || i.executed.length !== i.expected.length ||
      i.expected.some(test => !i.executed.includes(test)) || i.previous.some(test => !i.expected.includes(test))) return 'DELIVERY_TEST_INVENTORY_CHANGED';
    if (!e.mutation || !ids(e.mutation.required) || !e.mutation.required.length || !ids(e.mutation.detected) ||
      e.mutation.required.some(m => !e.mutation.detected.includes(m))) return 'DELIVERY_MUTATION_SURVIVED';
    if (!Array.isArray(e.defects) || e.defects.length > 100) return 'DELIVERY_LESSON_INVALID';
    deliveryLearningChecks(e.defects.map(d => d.category));
    if (e.defects.some(d => !digest(d.rootCauseDigest) || !digest(d.correctionDigest) || !ids(d.regressionCheckIds) ||
      !d.regressionCheckIds.length || d.regressionCheckIds.some(c => !e.checks.some(check => check.id === c)) ||
      !clock(d.reworkMinutes) || !clock(d.directCashCostCents) ||
      deliveryLearningChecks([d.category]).some(kind => !d.regressionCheckIds.some(c => e.checks.some(check => check.id === c && check.kind === kind))))) return 'DELIVERY_LESSON_UNVERIFIED';
    return null;
  } catch { return 'DELIVERY_EVIDENCE_INVALID'; }
}
