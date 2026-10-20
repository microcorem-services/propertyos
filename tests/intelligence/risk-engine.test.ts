import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessPropertyRisk,
  MAXIMUM_RISK_SCORE,
  RISK_ALGORITHM_VERSION,
  RISK_RULES,
  type RiskInput,
} from '../../src/lib/intelligence/risk-engine';

const observedAt = '2026-10-20T10:00:00Z';
const evaluatedAsOf = '2026-10-20T12:00:00Z';
const baseInput: RiskInput = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  unitId: '00000000-0000-4000-8000-000000000401',
  isVacant: false,
  leaseExpiryDays: null,
  hasOutstandingMaintenance: null,
  dataObservedAt: observedAt,
};

test('returns no findings for known low-risk inputs', () => {
  const assessment = assessPropertyRisk(
    { ...baseInput, leaseExpiryDays: 180, hasOutstandingMaintenance: false },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 0);
  assert.equal(assessment.maximumScore, 90);
  assert.equal(assessment.priority, 'low');
  assert.deepEqual(assessment.triggeredRuleIds, []);
  assert.deepEqual(assessment.findings, []);
  assert.equal(assessment.dataCompleteness.isComplete, true);
});

test('scores vacancy only', () => {
  const assessment = assessPropertyRisk(
    {
      ...baseInput,
      isVacant: true,
      leaseExpiryDays: 180,
      hasOutstandingMaintenance: false,
    },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 40);
  assert.equal(assessment.priority, 'medium');
  assert.deepEqual(assessment.triggeredRuleIds, ['unit.vacant']);
});

test('scores lease expiry from zero through 90 days inclusively', () => {
  const assessment = assessPropertyRisk(
    { ...baseInput, leaseExpiryDays: 90, hasOutstandingMaintenance: false },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 30);
  assert.equal(assessment.priority, 'medium');
  assert.deepEqual(assessment.triggeredRuleIds, ['lease.expiring_within_90_days']);
  assert.match(assessment.findings[0].explanation, /next 90 days/);
});

test('scores outstanding maintenance only', () => {
  const assessment = assessPropertyRisk(
    { ...baseInput, leaseExpiryDays: 180, hasOutstandingMaintenance: true },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 20);
  assert.equal(assessment.priority, 'low');
  assert.deepEqual(assessment.triggeredRuleIds, ['maintenance.outstanding']);
});

test('scores combinations of two risks', () => {
  const assessment = assessPropertyRisk(
    {
      ...baseInput,
      isVacant: true,
      leaseExpiryDays: 90,
      hasOutstandingMaintenance: false,
    },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 70);
  assert.equal(assessment.priority, 'high');
  assert.deepEqual(assessment.triggeredRuleIds, [
    'unit.vacant',
    'lease.expiring_within_90_days',
  ]);
});

test('scores lease expiry with maintenance as a second risk', () => {
  const assessment = assessPropertyRisk(
    {
      ...baseInput,
      leaseExpiryDays: 45,
      hasOutstandingMaintenance: true,
    },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 50);
  assert.equal(assessment.priority, 'medium');
  assert.deepEqual(assessment.triggeredRuleIds, [
    'lease.expiring_within_90_days',
    'maintenance.outstanding',
  ]);
});

test('scores all three illustrative risks and explains each finding', () => {
  const assessment = assessPropertyRisk(
    {
      ...baseInput,
      isVacant: true,
      leaseExpiryDays: 0,
      hasOutstandingMaintenance: true,
    },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, MAXIMUM_RISK_SCORE);
  assert.equal(assessment.score, 90);
  assert.equal(assessment.priority, 'high');
  assert.equal(assessment.findings.length, 3);
  assert.ok(assessment.findings.every((finding) => finding.explanation.length > 0));
});

test('does not score an unknown lease expiry and reports incomplete data', () => {
  const assessment = assessPropertyRisk(
    { ...baseInput, hasOutstandingMaintenance: false },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 0);
  assert.deepEqual(assessment.dataCompleteness.missingFields, ['leaseExpiryDays']);
  assert.equal(assessment.dataCompleteness.isComplete, false);
});

test('does not assume unknown vacancy status means occupied', () => {
  const assessment = assessPropertyRisk(
    {
      ...baseInput,
      isVacant: null,
      leaseExpiryDays: 180,
      hasOutstandingMaintenance: false,
    },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 0);
  assert.deepEqual(assessment.dataCompleteness.missingFields, ['isVacant']);
  assert.equal(assessment.dataCompleteness.isComplete, false);
});

test('reports an expired lease separately without applying the expiry rule', () => {
  const assessment = assessPropertyRisk(
    { ...baseInput, leaseExpiryDays: -12, hasOutstandingMaintenance: false },
    evaluatedAsOf,
  );

  assert.equal(assessment.score, 0);
  assert.equal(assessment.expiredLeaseDays, 12);
  assert.deepEqual(assessment.triggeredRuleIds, []);
});

test('rejects invalid booleans, non-finite and fractional day values', () => {
  for (const invalid of [
    { ...baseInput, isVacant: 'false' },
    { ...baseInput, leaseExpiryDays: Number.NaN },
    { ...baseInput, leaseExpiryDays: Number.POSITIVE_INFINITY },
    { ...baseInput, leaseExpiryDays: 1.5 },
    { ...baseInput, hasOutstandingMaintenance: 'false' },
  ]) {
    assert.throws(
      () => assessPropertyRisk(invalid as RiskInput, evaluatedAsOf),
      { name: 'TypeError', message: 'Invalid property risk assessment input.' },
    );
  }
});

test('rejects a missing input object or non-string evaluation timestamp', () => {
  assert.throws(
    () => assessPropertyRisk(null as unknown as RiskInput, evaluatedAsOf),
    { name: 'TypeError', message: 'Invalid property risk assessment input.' },
  );
  assert.throws(
    () =>
      assessPropertyRisk(
        baseInput,
        123 as unknown as string,
      ),
    { name: 'TypeError', message: 'Invalid property risk assessment input.' },
  );
});

test('rejects malformed organization and unit identifiers', () => {
  for (const invalid of [
    { ...baseInput, organizationId: 'org-secret-123' },
    { ...baseInput, unitId: '00000000-0000-0000-0000-000000000401' },
  ]) {
    assert.throws(
      () => assessPropertyRisk(invalid, evaluatedAsOf),
      { name: 'TypeError', message: 'Invalid property risk assessment input.' },
    );
  }
});

test('rejects invalid timestamps and observations later than evaluation', () => {
  assert.throws(
    () =>
      assessPropertyRisk(
        { ...baseInput, dataObservedAt: 'not-a-timestamp' },
        evaluatedAsOf,
      ),
    TypeError,
  );
  assert.throws(
    () =>
      assessPropertyRisk(
        { ...baseInput, dataObservedAt: '2026-10-20T13:00:00Z' },
        evaluatedAsOf,
      ),
    TypeError,
  );
  assert.throws(
    () =>
      assessPropertyRisk(
        { ...baseInput, dataObservedAt: '2026-02-30T10:00:00Z' },
        evaluatedAsOf,
      ),
    TypeError,
  );
  assert.throws(
    () =>
      assessPropertyRisk(
        { ...baseInput, dataObservedAt: '2026-10-20T10:00:00+14:30' },
        evaluatedAsOf,
      ),
    TypeError,
  );
});

test('keeps stable rule identifiers and version', () => {
  assert.deepEqual(
    RISK_RULES.map((rule) => rule.id),
    ['unit.vacant', 'lease.expiring_within_90_days', 'maintenance.outstanding'],
  );
  assert.equal(RISK_ALGORITHM_VERSION, 'risk-v1');
  assert.equal(
    assessPropertyRisk(baseInput, evaluatedAsOf).algorithmVersion,
    'risk-v1',
  );
});

test('uses an explicit evaluation timestamp deterministically', () => {
  const input = {
    ...baseInput,
    leaseExpiryDays: 5,
    hasOutstandingMaintenance: true,
  };
  const first = assessPropertyRisk(input, evaluatedAsOf);
  const second = assessPropertyRisk(input, evaluatedAsOf);

  assert.deepEqual(first, second);
  assert.equal(first.evaluatedAsOf, evaluatedAsOf);
});

test('does not mutate input and preserves organization and unit identity', () => {
  const input = Object.freeze({
    ...baseInput,
    isVacant: true,
    leaseExpiryDays: 15,
    hasOutstandingMaintenance: true,
  });
  const before = { ...input };
  const assessment = assessPropertyRisk(input, evaluatedAsOf);

  assert.deepEqual(input, before);
  assert.equal(assessment.organizationId, input.organizationId);
  assert.equal(assessment.unitId, input.unitId);
});
