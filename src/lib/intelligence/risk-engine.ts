const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

export const RISK_ALGORITHM_VERSION = 'risk-v1' as const;

export type RiskAlgorithmVersion = typeof RISK_ALGORITHM_VERSION;
export type RiskSeverity = 'low' | 'medium' | 'high';

export interface RiskInput {
  readonly organizationId: string;
  readonly unitId: string;
  readonly isVacant: boolean | null;
  readonly leaseExpiryDays: number | null;
  readonly hasOutstandingMaintenance: boolean | null;
  readonly dataObservedAt: string;
}

export interface RiskRule {
  readonly id: string;
  readonly points: number;
  readonly explanation: string;
}

export interface RiskFinding {
  readonly ruleId: string;
  readonly points: number;
  readonly explanation: string;
}

export interface RiskDataCompleteness {
  readonly isComplete: boolean;
  readonly missingFields: readonly (
    | 'isVacant'
    | 'leaseExpiryDays'
    | 'hasOutstandingMaintenance'
  )[];
}

export interface RiskAssessment {
  readonly organizationId: string;
  readonly unitId: string;
  readonly score: number;
  readonly maximumScore: number;
  readonly priority: RiskSeverity;
  readonly triggeredRuleIds: readonly string[];
  readonly findings: readonly RiskFinding[];
  readonly dataCompleteness: RiskDataCompleteness;
  readonly expiredLeaseDays: number | null;
  readonly algorithmVersion: RiskAlgorithmVersion;
  readonly dataObservedAt: string;
  readonly evaluatedAsOf: string;
}

export const RISK_RULES: readonly RiskRule[] = Object.freeze([
  Object.freeze({
    id: 'unit.vacant',
    points: 40,
    explanation: 'The unit is currently marked as vacant.',
  }),
  Object.freeze({
    id: 'lease.expiring_within_90_days',
    points: 30,
    explanation: 'The lease is due to expire within the next 90 days.',
  }),
  Object.freeze({
    id: 'maintenance.outstanding',
    points: 20,
    explanation: 'The unit has an outstanding maintenance issue.',
  }),
]);

export const MAXIMUM_RISK_SCORE = RISK_RULES.reduce(
  (total, rule) => total + rule.points,
  0,
);

function isValidTimestamp(value: string): boolean {
  if (typeof value !== 'string') return false;
  const parts = TIMESTAMP_PATTERN.exec(value);
  if (!parts) return false;

  const [, year, month, day, hour, minute, second, zone, , offsetHour, offsetMinute] =
    parts;
  const calendarDate = `${year}-${month}-${day}`;
  const parsedDate = Date.parse(`${calendarDate}T00:00:00.000Z`);
  const validCalendarDate =
    Number.isFinite(parsedDate) &&
    new Date(parsedDate).toISOString().slice(0, 10) === calendarDate;
  const validClock =
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
  const validOffset =
    zone === 'Z' ||
    (Number(offsetHour) <= 14 &&
      Number(offsetMinute) <= 59 &&
      (Number(offsetHour) < 14 || Number(offsetMinute) === 0));

  return (
    validCalendarDate &&
    validClock &&
    validOffset &&
    Number.isFinite(Date.parse(value))
  );
}

function validateInput(input: RiskInput, evaluatedAsOf: string): void {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.organizationId !== 'string' ||
    !UUID_PATTERN.test(input.organizationId) ||
    typeof input.unitId !== 'string' ||
    !UUID_PATTERN.test(input.unitId) ||
    !(input.isVacant === null || typeof input.isVacant === 'boolean') ||
    !(
      input.leaseExpiryDays === null ||
      (Number.isSafeInteger(input.leaseExpiryDays) &&
        typeof input.leaseExpiryDays === 'number')
    ) ||
    !(
      input.hasOutstandingMaintenance === null ||
      typeof input.hasOutstandingMaintenance === 'boolean'
    ) ||
    !isValidTimestamp(input.dataObservedAt) ||
    !isValidTimestamp(evaluatedAsOf) ||
    Date.parse(input.dataObservedAt) > Date.parse(evaluatedAsOf)
  ) {
    throw new TypeError('Invalid property risk assessment input.');
  }
}

function classifyPriority(score: number): RiskSeverity {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

/**
 * Evaluates fixed, illustrative rules against explicitly supplied data.
 * Callers must authorize access to the organization and unit before invoking it.
 */
export function assessPropertyRisk(
  input: RiskInput,
  evaluatedAsOf: string,
): RiskAssessment {
  validateInput(input, evaluatedAsOf);

  const findings: RiskFinding[] = [];
  const [vacancyRule, leaseRule, maintenanceRule] = RISK_RULES;

  if (input.isVacant === true) {
    findings.push({
      ruleId: vacancyRule.id,
      points: vacancyRule.points,
      explanation: vacancyRule.explanation,
    });
  }

  if (input.leaseExpiryDays !== null && input.leaseExpiryDays >= 0 && input.leaseExpiryDays <= 90) {
    findings.push({
      ruleId: leaseRule.id,
      points: leaseRule.points,
      explanation: leaseRule.explanation,
    });
  }

  if (input.hasOutstandingMaintenance === true) {
    findings.push({
      ruleId: maintenanceRule.id,
      points: maintenanceRule.points,
      explanation: maintenanceRule.explanation,
    });
  }

  const missingFields: (
    | 'isVacant'
    | 'leaseExpiryDays'
    | 'hasOutstandingMaintenance'
  )[] = [];
  if (input.isVacant === null) missingFields.push('isVacant');
  if (input.leaseExpiryDays === null) missingFields.push('leaseExpiryDays');
  if (input.hasOutstandingMaintenance === null) {
    missingFields.push('hasOutstandingMaintenance');
  }

  const score = findings.reduce((total, finding) => total + finding.points, 0);

  return {
    organizationId: input.organizationId,
    unitId: input.unitId,
    score,
    maximumScore: MAXIMUM_RISK_SCORE,
    priority: classifyPriority(score),
    triggeredRuleIds: findings.map((finding) => finding.ruleId),
    findings,
    dataCompleteness: {
      isComplete: missingFields.length === 0,
      missingFields,
    },
    expiredLeaseDays:
      input.leaseExpiryDays !== null && input.leaseExpiryDays < 0
        ? Math.abs(input.leaseExpiryDays)
        : null,
    algorithmVersion: RISK_ALGORITHM_VERSION,
    dataObservedAt: input.dataObservedAt,
    evaluatedAsOf,
  };
}
