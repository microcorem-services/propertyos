import {
  assessPropertyRisk,
  type RiskAssessment,
  type RiskInput,
} from './risk-engine';

const EVALUATED_AS_OF = '2026-02-01T12:00:00.000Z';

type DemoRiskInput = Omit<RiskInput, 'organizationId'>;

const SYNTHETIC_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

const DEMO_UNITS: readonly {
  input: DemoRiskInput;
  unitName: string;
  buildingName: string;
}[] = [
  {
    input: {
      unitId: '00000000-0000-4000-8000-000000000101',
      isVacant: false,
      leaseExpiryDays: 180,
      hasOutstandingMaintenance: false,
      dataObservedAt: '2026-01-31T09:00:00.000Z',
    },
    unitName: 'Demo Unit 101',
    buildingName: 'Demo House North',
  },
  {
    input: {
      unitId: '00000000-0000-4000-8000-000000000102',
      isVacant: true,
      leaseExpiryDays: 180,
      hasOutstandingMaintenance: false,
      dataObservedAt: '2026-01-31T09:00:00.000Z',
    },
    unitName: 'Demo Unit 102',
    buildingName: 'Demo House North',
  },
  {
    input: {
      unitId: '00000000-0000-4000-8000-000000000201',
      isVacant: true,
      leaseExpiryDays: 45,
      hasOutstandingMaintenance: false,
      dataObservedAt: '2026-01-31T09:00:00.000Z',
    },
    unitName: 'Demo Unit 201',
    buildingName: 'Demo House South',
  },
  {
    input: {
      unitId: '00000000-0000-4000-8000-000000000202',
      isVacant: false,
      leaseExpiryDays: null,
      hasOutstandingMaintenance: true,
      dataObservedAt: '2026-01-31T09:00:00.000Z',
    },
    unitName: 'Demo Unit 202',
    buildingName: 'Demo House South',
  },
  {
    input: {
      unitId: '00000000-0000-4000-8000-000000000301',
      isVacant: false,
      leaseExpiryDays: 30,
      hasOutstandingMaintenance: false,
      dataObservedAt: '2026-01-31T09:00:00.000Z',
    },
    unitName: 'Demo Unit 301',
    buildingName: 'Demo House West',
  },
  {
    input: {
      unitId: '00000000-0000-4000-8000-000000000302',
      isVacant: null,
      leaseExpiryDays: null,
      hasOutstandingMaintenance: null,
      dataObservedAt: '2026-01-31T09:00:00.000Z',
    },
    unitName: 'Demo Unit 302',
    buildingName: 'Demo House West',
  },
  {
    input: {
      unitId: '00000000-0000-4000-8000-000000000401',
      isVacant: false,
      leaseExpiryDays: -15,
      hasOutstandingMaintenance: false,
      dataObservedAt: '2026-01-31T09:00:00.000Z',
    },
    unitName: 'Demo Unit 401',
    buildingName: 'Demo House East',
  },
];

export interface IntelligenceAssessment {
  readonly unitName: string;
  readonly buildingName: string;
  readonly assessment: RiskAssessment;
}

export const DEMO_ASSESSMENTS: readonly IntelligenceAssessment[] =
  DEMO_UNITS.map(({ input, unitName, buildingName }) => ({
    unitName,
    buildingName,
    assessment: assessPropertyRisk(
      { ...input, organizationId: SYNTHETIC_ORGANIZATION_ID },
      EVALUATED_AS_OF,
    ),
  }));

export interface AssessmentSummary {
  readonly unitsAssessed: number;
  readonly highPriority: number;
  readonly mediumPriority: number;
  readonly incompleteData: number;
}

export function summarizeAssessments(
  assessments: readonly IntelligenceAssessment[],
): AssessmentSummary {
  return assessments.reduce<AssessmentSummary>(
    (summary, { assessment }) => ({
      unitsAssessed: summary.unitsAssessed + 1,
      highPriority:
        summary.highPriority + Number(assessment.priority === 'high'),
      mediumPriority:
        summary.mediumPriority + Number(assessment.priority === 'medium'),
      incompleteData:
        summary.incompleteData +
        Number(!assessment.dataCompleteness.isComplete),
    }),
    { unitsAssessed: 0, highPriority: 0, mediumPriority: 0, incompleteData: 0 },
  );
}
