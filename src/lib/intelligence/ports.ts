import type { RiskAssessment } from './risk-engine';

export interface LeaseRiskData {
  readonly daysUntilExpiry: number | null;
  readonly observedAt: string;
}

export interface OccupancyRiskData {
  readonly isVacant: boolean | null;
  readonly observedAt: string;
}

export interface MaintenanceRiskData {
  readonly hasOutstandingIssue: boolean | null;
  readonly observedAt: string;
}

export interface LeaseDataProvider {
  getLeaseRiskData(
    organizationId: string,
    unitId: string,
    evaluatedAsOf: string,
  ): Promise<LeaseRiskData>;
}

export interface OccupancyDataProvider {
  getOccupancyRiskData(
    organizationId: string,
    unitId: string,
    evaluatedAsOf: string,
  ): Promise<OccupancyRiskData>;
}

export interface MaintenanceDataProvider {
  getMaintenanceRiskData(
    organizationId: string,
    unitId: string,
    evaluatedAsOf: string,
  ): Promise<MaintenanceRiskData>;
}

export interface RiskDataProvider
  extends LeaseDataProvider, OccupancyDataProvider, MaintenanceDataProvider {}

export interface PropertyIntelligenceService {
  assessUnitRisk(
    organizationId: string,
    unitId: string,
    evaluatedAsOf: string,
  ): Promise<RiskAssessment>;
}

export interface LLMExplanationProvider {
  explainAssessment(assessment: RiskAssessment): Promise<string>;
}
