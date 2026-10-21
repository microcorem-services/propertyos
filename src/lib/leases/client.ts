export type LeaseStatus = 'draft' | 'active' | 'expired' | 'terminated';
export type LeaseCurrency = 'GBP' | 'EUR' | 'USD';
export type LeasePaymentFrequency = 'monthly' | 'quarterly' | 'annually';
export type LeasePartyRole = 'landlord' | 'tenant' | 'guarantor';
export type LeasePartyType = 'individual' | 'organization';

export type LeaseUnitReference = {
  portfolio_id: string;
  site_id: string;
  building_id: string;
  unit_id: string;
};

export type LeaseUnit = LeaseUnitReference & {
  verified_status: 'active' | 'unavailable';
};

export type LeaseParty = {
  id: string;
  legal_name: string;
  role: LeasePartyRole;
  party_type: LeasePartyType;
};

export type LeasePartyInput = Omit<LeaseParty, 'id'>;

export type LeaseSummary = {
  id: string;
  organization_id: string;
  lease_reference: string;
  start_date: string;
  expiry_date: string;
  break_date: string | null;
  rent_amount: string;
  currency: LeaseCurrency;
  payment_frequency: LeasePaymentFrequency;
  status: LeaseStatus;
  units: LeaseUnitReference[];
  parties: LeaseParty[];
  created_at: string;
  updated_at: string;
};

export type LeaseAuditEvent = {
  actor_id: string;
  event_type:
    | 'created'
    | 'updated'
    | 'rent_schedule_created'
    | 'rent_schedule_updated'
    | 'rent_schedule_activated'
    | 'rent_schedule_generated'
    | 'charge_created'
    | 'charge_updated'
    | 'charge_activated'
    | 'charge_generated';
  changed_fields: string[];
  occurred_at: string;
};

export type Lease = Omit<LeaseSummary, 'units'> & {
  units: LeaseUnit[];
  audit_events: LeaseAuditEvent[];
};

export type LeaseList = {
  items: LeaseSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type LeasePermissions = {
  can_read: boolean;
  can_create: boolean;
  can_update: boolean;
};

export type LeaseFields = {
  lease_reference: string;
  start_date: string;
  expiry_date: string;
  break_date: string | null;
  rent_amount: string;
  currency: LeaseCurrency;
  payment_frequency: LeasePaymentFrequency;
  status: LeaseStatus;
  units: LeaseUnitReference[];
  parties: LeasePartyInput[];
};

export type LeaseUpdateFields = Partial<LeaseFields>;

export type RentScheduleStatus = 'draft' | 'active';
export type RentScheduleFrequency = 'monthly' | 'quarterly' | 'annually';
export type LeaseChargeCategory =
  | 'base_rent'
  | 'service_charge'
  | 'building_maintenance'
  | 'insurance_contribution'
  | 'shared_facilities'
  | 'other_property_charge';

export type RentSchedule = {
  id: string;
  organization_id: string;
  lease_id: string;
  charge_category: LeaseChargeCategory;
  description: string;
  amount_per_period: string;
  currency: LeaseCurrency;
  payment_frequency: RentScheduleFrequency;
  start_date: string;
  end_date: string;
  due_day: number;
  short_month_rule: 'clamp_to_month_end';
  status: RentScheduleStatus;
  manual_review_reasons: (
    | 'commencement_not_on_due_date'
    | 'end_not_on_period_boundary'
  )[];
  installments: {
    id: string;
    due_date: string;
    amount: string;
    currency: LeaseCurrency;
    status: 'expected';
  }[];
  created_at: string;
  updated_at: string;
};

export type RentScheduleFields = {
  charge_category?: LeaseChargeCategory;
  description?: string;
  amount_per_period: string;
  payment_frequency: RentScheduleFrequency;
  start_date: string;
  end_date: string;
  due_day: number;
  short_month_rule: 'clamp_to_month_end';
  status?: RentScheduleStatus;
};

export type PropertyExpenseAssetLevel = 'portfolio' | 'site' | 'building' | 'unit';
export type PropertyExpenseCategory =
  | 'utilities'
  | 'maintenance'
  | 'insurance'
  | 'repairs'
  | 'cleaning'
  | 'security'
  | 'shared_facilities'
  | 'other';

export type PropertyExpense = {
  id: string;
  organization_id: string;
  asset_level: PropertyExpenseAssetLevel;
  portfolio_id: string;
  site_id: string | null;
  building_id: string | null;
  unit_id: string | null;
  category: PropertyExpenseCategory;
  description: string;
  amount: string;
  currency: LeaseCurrency;
  expense_date: string;
  recoverability: 'recoverable' | 'non_recoverable';
  manual_review_reasons: ('allocation_not_configured' | 'recovery_terms_not_verified')[];
  audit_events: {
    actor_id: string;
    event_type: 'created' | 'updated';
    changed_fields: string[];
    occurred_at: string;
  }[];
  created_at: string;
  updated_at: string;
};

export type PropertyExpenseFields = {
  idempotency_key: string;
  asset_level: PropertyExpenseAssetLevel;
  portfolio_id: string;
  site_id?: string;
  building_id?: string;
  unit_id?: string;
  category: PropertyExpenseCategory;
  description: string;
  amount: string;
  currency: LeaseCurrency;
  expense_date: string;
  recoverability: 'recoverable' | 'non_recoverable';
};

export type PropertyExpenseUpdateFields = Partial<
  Pick<
    PropertyExpenseFields,
    'category' | 'description' | 'amount' | 'currency' | 'expense_date' | 'recoverability'
  >
>;

export class LeaseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LeaseRequestError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new LeaseRequestError('Invalid lease request.', 400);
}

function safeMessage(status: number): string {
  if (status === 400) return 'Lease information is invalid.';
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) return 'You do not have access to this organisation or action.';
  if (status === 404) return 'Lease not found.';
  if (status === 409) return 'This lease conflicts with existing data.';
  return 'Lease Management is temporarily unavailable.';
}

async function requestJson<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH',
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new LeaseRequestError(safeMessage(503), 503);
  }
  if (!response.ok) {
    throw new LeaseRequestError(safeMessage(response.status), response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new LeaseRequestError('Lease service returned an invalid response.', 502);
  }
}

function organizationQuery(organizationId: string): string {
  assertUuid(organizationId);
  return `organizationId=${encodeURIComponent(organizationId)}`;
}

export function fetchLeasePermissions(
  organizationId: string,
): Promise<LeasePermissions> {
  return requestJson(
    `/api/leases/permissions?${organizationQuery(organizationId)}`,
    'GET',
  );
}

export function fetchLeases(options: {
  organizationId: string;
  limit: number;
  offset: number;
  status?: LeaseStatus | 'all';
  search?: string;
  sortBy?: 'lease_reference' | 'status' | 'start_date' | 'expiry_date' | 'rent_amount' | 'updated_at';
  sortDirection?: 'asc' | 'desc';
}): Promise<LeaseList> {
  const query = new URLSearchParams({
    organizationId: options.organizationId,
    limit: String(options.limit),
    offset: String(options.offset),
  });
  assertUuid(options.organizationId);
  if (options.status && options.status !== 'all') query.set('status', options.status);
  if (options.search?.trim()) query.set('search', options.search.trim());
  query.set('sort_by', options.sortBy ?? 'updated_at');
  query.set('sort_direction', options.sortDirection ?? 'desc');
  return requestJson(`/api/leases?${query}`, 'GET');
}

export function fetchLease(
  organizationId: string,
  leaseId: string,
): Promise<Lease> {
  assertUuid(leaseId);
  return requestJson(
    `/api/leases/${encodeURIComponent(leaseId)}?${organizationQuery(organizationId)}`,
    'GET',
  );
}

export function createLease(
  organizationId: string,
  fields: LeaseFields,
): Promise<Lease> {
  return requestJson(
    `/api/leases?${organizationQuery(organizationId)}`,
    'POST',
    fields,
  );
}

export function updateLease(
  organizationId: string,
  leaseId: string,
  fields: LeaseUpdateFields,
): Promise<Lease> {
  assertUuid(leaseId);
  return requestJson(
    `/api/leases/${encodeURIComponent(leaseId)}?${organizationQuery(organizationId)}`,
    'PATCH',
    fields,
  );
}

function rentSchedulePath(organizationId: string, leaseId: string): string {
  assertUuid(organizationId);
  assertUuid(leaseId);
  return `/api/leases/${encodeURIComponent(leaseId)}/rent-schedules?${organizationQuery(organizationId)}`;
}

export function fetchRentSchedules(
  organizationId: string,
  leaseId: string,
): Promise<RentSchedule[]> {
  return requestJson(rentSchedulePath(organizationId, leaseId), 'GET');
}

export function createRentSchedule(
  organizationId: string,
  leaseId: string,
  fields: RentScheduleFields,
): Promise<RentSchedule> {
  return requestJson(rentSchedulePath(organizationId, leaseId), 'POST', fields);
}

export function updateRentSchedule(
  organizationId: string,
  leaseId: string,
  scheduleId: string,
  fields: Partial<RentScheduleFields>,
): Promise<RentSchedule> {
  assertUuid(leaseId);
  assertUuid(scheduleId);
  return requestJson(
    `/api/leases/${encodeURIComponent(leaseId)}/rent-schedules/${encodeURIComponent(scheduleId)}?${organizationQuery(organizationId)}`,
    'PATCH',
    fields,
  );
}

export function generateRentSchedule(
  organizationId: string,
  leaseId: string,
  scheduleId: string,
): Promise<RentSchedule> {
  assertUuid(scheduleId);
  return requestJson(
    `/api/leases/${encodeURIComponent(leaseId)}/rent-schedules/${encodeURIComponent(scheduleId)}/generate?${organizationQuery(organizationId)}`,
    'POST',
  );
}

function propertyExpensesPath(organizationId: string): string {
  return `/api/property-expenses?${organizationQuery(organizationId)}`;
}

export function fetchPropertyExpenses(
  organizationId: string,
): Promise<PropertyExpense[]> {
  return requestJson(propertyExpensesPath(organizationId), 'GET');
}

export function createPropertyExpense(
  organizationId: string,
  fields: PropertyExpenseFields,
): Promise<PropertyExpense> {
  return requestJson(propertyExpensesPath(organizationId), 'POST', fields);
}

export function updatePropertyExpense(
  organizationId: string,
  expenseId: string,
  fields: PropertyExpenseUpdateFields,
): Promise<PropertyExpense> {
  assertUuid(expenseId);
  return requestJson(
    `/api/property-expenses/${encodeURIComponent(expenseId)}?${organizationQuery(organizationId)}`,
    'PATCH',
    fields,
  );
}
