import 'server-only';

import { loadAppOrigin } from './cognito';
import { readSessionCookie } from './session';

const API_PREFIX = '/api/v1/organizations';
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const STATUSES = new Set(['draft', 'active', 'expired', 'terminated']);
const CURRENCIES = new Set(['GBP', 'EUR', 'USD']);
const FREQUENCIES = new Set(['monthly', 'quarterly', 'annually']);
const PARTY_ROLES = new Set(['landlord', 'tenant', 'guarantor']);
const PARTY_TYPES = new Set(['individual', 'organization']);
const CHARGE_CATEGORIES = new Set([
  'base_rent',
  'service_charge',
  'building_maintenance',
  'insurance_contribution',
  'shared_facilities',
  'other_property_charge',
]);
const EXPENSE_CATEGORIES = new Set([
  'utilities',
  'maintenance',
  'insurance',
  'repairs',
  'cleaning',
  'security',
  'shared_facilities',
  'other',
]);
const INVOICE_RECEIVABLE_STATUSES = new Set(['draft', 'due', 'overdue', 'paid']);
const INVOICE_EVENT_TYPES = new Set(['created', 'updated', 'issued']);
const PAYMENT_EVENT_TYPES = new Set(['recorded']);
const MONEY_PATTERN = /^\d{1,12}\.\d{2}$/;
const QUANTITY_PATTERN = /^\d{1,9}(?:\.\d{1,3})?$/;

type RetrievedSession = { data: Record<string, string> };
type SessionManager = {
  retrieve(id: string): Promise<RetrievedSession | null>;
};

type LeaseServiceConfiguration = { baseUrl: URL; timeoutMs: number };

type LeaseHandlerDependencies = {
  configuration?: () => LeaseServiceConfiguration;
  appOrigin?: () => URL;
  sessions: () => SessionManager;
  fetch?: typeof fetch;
  now?: () => number;
};

function errorResponse(status: number, error: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    !Number.isNaN(Date.parse(value))
  );
}

function moneyCents(value: string): bigint {
  const [whole, fraction] = value.split('.');
  return BigInt(whole) * BigInt(100) + BigInt(fraction);
}

function calculatedLineCents(quantity: string, unitAmount: string): bigint {
  const [whole, fraction = ''] = quantity.split('.');
  const thousandths =
    BigInt(whole) * BigInt(1000) + BigInt(fraction.padEnd(3, '0'));
  return (
    (thousandths * moneyCents(unitAmount) + BigInt(500)) / BigInt(1000)
  );
}

function isInvoiceLineInput(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.description === 'string' &&
    value.description.trim().length > 0 &&
    value.description.length <= 250 &&
    typeof value.quantity === 'string' &&
    QUANTITY_PATTERN.test(value.quantity) &&
    (BigInt(value.quantity.split('.')[0]) > BigInt(0) ||
      BigInt((value.quantity.split('.')[1] ?? '').padEnd(3, '0')) > BigInt(0)) &&
    typeof value.unit_amount === 'string' &&
    MONEY_PATTERN.test(value.unit_amount) &&
    moneyCents(value.unit_amount) > BigInt(0) &&
    (value.source_installment_id === undefined ||
      value.source_installment_id === null ||
      isUUID(value.source_installment_id))
  );
}

function isInvoice(value: unknown, organizationId: string): boolean {
  if (
    !isRecord(value) ||
    !isUUID(value.id) ||
    !isUUID(value.organization_id) ||
    value.organization_id.toLowerCase() !== organizationId.toLowerCase() ||
    !isUUID(value.lease_id) ||
    typeof value.lease_reference !== 'string' ||
    !value.lease_reference ||
    typeof value.invoice_number !== 'string' ||
    !value.invoice_number ||
    !isDate(value.issue_date) ||
    !isDate(value.due_date) ||
    value.due_date < value.issue_date ||
    !CURRENCIES.has(String(value.currency)) ||
    typeof value.subtotal !== 'string' ||
    !MONEY_PATTERN.test(value.subtotal) ||
    typeof value.total !== 'string' ||
    !MONEY_PATTERN.test(value.total) ||
    value.subtotal !== value.total ||
    typeof value.allocated_amount !== 'string' ||
    !MONEY_PATTERN.test(value.allocated_amount) ||
    typeof value.outstanding_balance !== 'string' ||
    !MONEY_PATTERN.test(value.outstanding_balance) ||
    moneyCents(value.allocated_amount) > moneyCents(value.total) ||
    moneyCents(value.outstanding_balance) !==
      moneyCents(value.total) - moneyCents(value.allocated_amount) ||
    (value.status !== 'draft' && value.status !== 'issued') ||
    !INVOICE_RECEIVABLE_STATUSES.has(String(value.receivable_status)) ||
    !(value.issued_at === null || isTimestamp(value.issued_at)) ||
    !Array.isArray(value.lines) ||
    value.lines.length === 0 ||
    value.lines.length > 100 ||
    !Array.isArray(value.audit_events) ||
    !value.audit_events.every(
      (event) =>
        isRecord(event) &&
        isUUID(event.actor_id) &&
        INVOICE_EVENT_TYPES.has(String(event.event_type)) &&
        Array.isArray(event.changed_fields) &&
        event.changed_fields.every((field) => typeof field === 'string') &&
        isTimestamp(event.occurred_at),
    ) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at)
  ) {
    return false;
  }
  let sum = BigInt(0);
  const sources = new Set<string>();
  for (const line of value.lines) {
    if (
      !isRecord(line) ||
      !isUUID(line.id) ||
      !isInvoiceLineInput(line) ||
      typeof line.quantity !== 'string' ||
      typeof line.unit_amount !== 'string' ||
      typeof line.line_total !== 'string' ||
      !MONEY_PATTERN.test(line.line_total) ||
      (line.source_installment_id !== null &&
        !isUUID(line.source_installment_id)) ||
      calculatedLineCents(line.quantity, line.unit_amount) !==
        moneyCents(line.line_total)
    ) {
      return false;
    }
    if (typeof line.source_installment_id === 'string') {
      if (sources.has(line.source_installment_id)) return false;
      sources.add(line.source_installment_id);
    }
    sum += moneyCents(line.line_total);
  }
  return sum === moneyCents(value.total);
}

function isPayment(value: unknown, organizationId: string): boolean {
  if (
    !isRecord(value) ||
    !isUUID(value.id) ||
    !isUUID(value.organization_id) ||
    value.organization_id.toLowerCase() !== organizationId.toLowerCase() ||
    typeof value.reference !== 'string' ||
    !value.reference.trim() ||
    !isDate(value.received_on) ||
    !CURRENCIES.has(String(value.currency)) ||
    typeof value.amount !== 'string' ||
    !MONEY_PATTERN.test(value.amount) ||
    typeof value.method_description !== 'string' ||
    !value.method_description.trim() ||
    !Array.isArray(value.allocations) ||
    value.allocations.length === 0 ||
    !Array.isArray(value.audit_events) ||
    !value.audit_events.every(
      (event) =>
        isRecord(event) &&
        isUUID(event.actor_id) &&
        PAYMENT_EVENT_TYPES.has(String(event.event_type)) &&
        Array.isArray(event.changed_fields) &&
        event.changed_fields.every((field) => typeof field === 'string') &&
        isTimestamp(event.occurred_at),
    ) ||
    !isTimestamp(value.created_at)
  ) {
    return false;
  }
  const invoices = new Set<string>();
  let allocated = BigInt(0);
  for (const item of value.allocations) {
    if (
      !isRecord(item) ||
      !isUUID(item.invoice_id) ||
      typeof item.invoice_number !== 'string' ||
      !item.invoice_number ||
      typeof item.amount !== 'string' ||
      !MONEY_PATTERN.test(item.amount) ||
      moneyCents(item.amount) <= BigInt(0) ||
      invoices.has(item.invoice_id)
    ) {
      return false;
    }
    invoices.add(item.invoice_id);
    allocated += moneyCents(item.amount);
  }
  return allocated <= moneyCents(value.amount);
}

function isEligibleInstallment(value: unknown, leaseId: string): boolean {
  return (
    isRecord(value) &&
    isUUID(value.id) &&
    isUUID(value.lease_id) &&
    value.lease_id.toLowerCase() === leaseId.toLowerCase() &&
    isUUID(value.schedule_id) &&
    typeof value.description === 'string' &&
    value.description.length > 0 &&
    CHARGE_CATEGORIES.has(String(value.charge_category)) &&
    isDate(value.due_date) &&
    typeof value.amount === 'string' &&
    MONEY_PATTERN.test(value.amount) &&
    CURRENCIES.has(String(value.currency))
  );
}

function isParty(value: unknown): boolean {
  return (
    isRecord(value) &&
    isUUID(value.id) &&
    typeof value.legal_name === 'string' &&
    value.legal_name.length > 0 &&
    PARTY_ROLES.has(String(value.role)) &&
    PARTY_TYPES.has(String(value.party_type))
  );
}

function isUnit(value: unknown, requireVerifiedStatus = false): boolean {
  return (
    isRecord(value) &&
    isUUID(value.portfolio_id) &&
    isUUID(value.site_id) &&
    isUUID(value.building_id) &&
    isUUID(value.unit_id) &&
    (!requireVerifiedStatus ||
      value.verified_status === 'active' ||
      value.verified_status === 'unavailable')
  );
}

function isLeaseRecord(
  value: unknown,
  organizationId: string,
  requireAudit: boolean,
): boolean {
  if (!isRecord(value)) return false;
  return (
    isUUID(value.id) &&
    isUUID(value.organization_id) &&
    value.organization_id.toLowerCase() === organizationId.toLowerCase() &&
    typeof value.lease_reference === 'string' &&
    value.lease_reference.length > 0 &&
    isDate(value.start_date) &&
    isDate(value.expiry_date) &&
    (value.break_date === null || isDate(value.break_date)) &&
    typeof value.rent_amount === 'string' &&
    /^\d{1,12}\.\d{2}$/.test(value.rent_amount) &&
    CURRENCIES.has(String(value.currency)) &&
    FREQUENCIES.has(String(value.payment_frequency)) &&
    STATUSES.has(String(value.status)) &&
    Array.isArray(value.units) &&
    value.units.length <= 50 &&
    value.units.every((unit) => isUnit(unit, true)) &&
    Array.isArray(value.parties) &&
    value.parties.length <= 100 &&
    value.parties.every(isParty) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at) &&
    (requireAudit
      ? Array.isArray(value.audit_events) &&
        value.audit_events.every(
      (event) =>
        isRecord(event) &&
        isUUID(event.actor_id) &&
        [
          'created',
          'updated',
          'rent_schedule_created',
          'rent_schedule_updated',
          'rent_schedule_activated',
          'rent_schedule_generated',
          'charge_created',
          'charge_updated',
          'charge_activated',
          'charge_generated',
        ].includes(String(event.event_type)) &&
        Array.isArray(event.changed_fields) &&
        event.changed_fields.every((field) => typeof field === 'string') &&
        isTimestamp(event.occurred_at),
        )
      : true)
  );
}

function isLeaseSummary(value: unknown, organizationId: string): boolean {
  return (
    isRecord(value) &&
    isUUID(value.id) &&
    isUUID(value.organization_id) &&
    value.organization_id.toLowerCase() === organizationId.toLowerCase() &&
    typeof value.lease_reference === 'string' &&
    value.lease_reference.length > 0 &&
    isDate(value.start_date) &&
    isDate(value.expiry_date) &&
    (value.break_date === null || isDate(value.break_date)) &&
    typeof value.rent_amount === 'string' &&
    /^\d{1,12}\.\d{2}$/.test(value.rent_amount) &&
    CURRENCIES.has(String(value.currency)) &&
    FREQUENCIES.has(String(value.payment_frequency)) &&
    STATUSES.has(String(value.status)) &&
    Array.isArray(value.units) &&
    value.units.length <= 50 &&
    value.units.every((unit) => isUnit(unit)) &&
    Array.isArray(value.parties) &&
    value.parties.length <= 100 &&
    value.parties.every(isParty) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  );
}

function isRentSchedule(
  value: unknown,
  organizationId: string,
  leaseId: string,
): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.installments) ||
    value.installments.length === 0 ||
    value.installments.length > 1200
  ) {
    return false;
  }
  const dueDates = new Set<string>();
  let previousDueDate = '';
  const installmentsValid = value.installments.every((item) => {
    if (
      !isRecord(item) ||
      !isUUID(item.id) ||
      !isDate(item.due_date) ||
      item.due_date < String(value.start_date) ||
      item.due_date > String(value.end_date) ||
      typeof item.amount !== 'string' ||
      !/^\d{1,12}\.\d{2}$/.test(item.amount) ||
      item.amount !== value.amount_per_period ||
      !CURRENCIES.has(String(item.currency)) ||
      item.currency !== value.currency ||
      item.status !== 'expected' ||
      dueDates.has(item.due_date) ||
      item.due_date < previousDueDate
    ) {
      return false;
    }
    dueDates.add(item.due_date);
    previousDueDate = item.due_date;
    return true;
  });
  return (
    isUUID(value.id) &&
    isUUID(value.organization_id) &&
    value.organization_id.toLowerCase() === organizationId.toLowerCase() &&
    isUUID(value.lease_id) &&
    value.lease_id.toLowerCase() === leaseId.toLowerCase() &&
    CHARGE_CATEGORIES.has(String(value.charge_category)) &&
    typeof value.description === 'string' &&
    value.description.trim().length > 0 &&
    typeof value.amount_per_period === 'string' &&
    /^\d{1,12}\.\d{2}$/.test(value.amount_per_period) &&
    CURRENCIES.has(String(value.currency)) &&
    FREQUENCIES.has(String(value.payment_frequency)) &&
    isDate(value.start_date) &&
    isDate(value.end_date) &&
    value.end_date >= value.start_date &&
    Number.isInteger(value.due_day) &&
    Number(value.due_day) >= 1 &&
    Number(value.due_day) <= 31 &&
    value.short_month_rule === 'clamp_to_month_end' &&
    (value.status === 'draft' || value.status === 'active') &&
    Array.isArray(value.manual_review_reasons) &&
    value.manual_review_reasons.every(
      (reason) =>
        reason === 'commencement_not_on_due_date' ||
        reason === 'end_not_on_period_boundary',
    ) &&
    installmentsValid &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  );
}

function isPropertyExpense(value: unknown, organizationId: string): boolean {
  if (!isRecord(value)) return false;
  const hierarchyValid =
    (value.asset_level === 'portfolio' &&
      value.site_id === null &&
      value.building_id === null &&
      value.unit_id === null) ||
    (value.asset_level === 'site' &&
      isUUID(value.site_id) &&
      value.building_id === null &&
      value.unit_id === null) ||
    (value.asset_level === 'building' &&
      isUUID(value.site_id) &&
      isUUID(value.building_id) &&
      value.unit_id === null) ||
    (value.asset_level === 'unit' &&
      isUUID(value.site_id) &&
      isUUID(value.building_id) &&
      isUUID(value.unit_id));
  return (
    hierarchyValid &&
    isUUID(value.id) &&
    isUUID(value.organization_id) &&
    value.organization_id.toLowerCase() === organizationId.toLowerCase() &&
    ['portfolio', 'site', 'building', 'unit'].includes(String(value.asset_level)) &&
    isUUID(value.portfolio_id) &&
    (value.site_id === null || isUUID(value.site_id)) &&
    (value.building_id === null || isUUID(value.building_id)) &&
    (value.unit_id === null || isUUID(value.unit_id)) &&
    EXPENSE_CATEGORIES.has(String(value.category)) &&
    typeof value.description === 'string' &&
    value.description.trim().length > 0 &&
    typeof value.amount === 'string' &&
    /^\d{1,12}\.\d{2}$/.test(value.amount) &&
    CURRENCIES.has(String(value.currency)) &&
    isDate(value.expense_date) &&
    (value.recoverability === 'recoverable' ||
      value.recoverability === 'non_recoverable') &&
    Array.isArray(value.manual_review_reasons) &&
    value.manual_review_reasons.every(
      (reason) =>
        reason === 'allocation_not_configured' ||
        reason === 'recovery_terms_not_verified',
    ) &&
    Array.isArray(value.audit_events) &&
    value.audit_events.every(
      (event) =>
        isRecord(event) &&
        isUUID(event.actor_id) &&
        (event.event_type === 'created' || event.event_type === 'updated') &&
        Array.isArray(event.changed_fields) &&
        event.changed_fields.every((field) => typeof field === 'string') &&
        isTimestamp(event.occurred_at),
    ) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  );
}

function loadLeaseServiceConfiguration(): LeaseServiceConfiguration {
  const rawUrl = process.env.LEASE_MANAGEMENT_URL?.trim();
  const insecureLocalHttp =
    process.env.LEASE_MANAGEMENT_ALLOW_INSECURE_LOCAL_HTTP === 'true';
  const rawAllow = process.env.LEASE_MANAGEMENT_ALLOW_INSECURE_LOCAL_HTTP;
  if (rawAllow !== undefined && rawAllow !== 'true' && rawAllow !== 'false') {
    throw new Error('Invalid Lease Management configuration.');
  }
  let baseUrl: URL;
  try {
    if (!rawUrl) throw new TypeError();
    baseUrl = new URL(rawUrl);
  } catch {
    throw new Error('Invalid Lease Management configuration.');
  }
  const localHttp =
    baseUrl.protocol === 'http:' &&
    process.env.NODE_ENV !== 'production' &&
    insecureLocalHttp &&
    (baseUrl.hostname === 'localhost' ||
      baseUrl.hostname === '127.0.0.1' ||
      baseUrl.hostname === '[::1]' ||
      baseUrl.hostname === 'lease-management');
  if (
    (baseUrl.protocol !== 'https:' && !localHttp) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error('Invalid Lease Management configuration.');
  }
  const timeoutMs =
    process.env.LEASE_MANAGEMENT_TIMEOUT_MS === undefined
      ? DEFAULT_TIMEOUT_MS
      : Number(process.env.LEASE_MANAGEMENT_TIMEOUT_MS);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error('Invalid Lease Management configuration.');
  }
  return { baseUrl, timeoutMs };
}

async function readAccessToken(
  request: Request,
  sessions: () => SessionManager,
  now: () => number,
): Promise<string | null> {
  const sessionId = readSessionCookie(request.headers.get('cookie'));
  if (!sessionId) return null;
  const session = await sessions().retrieve(sessionId);
  if (!session) return null;
  const token = session.data.accessToken;
  const expiry = session.data.accessTokenExpiresAt;
  if (
    typeof token !== 'string' ||
    !JWT_PATTERN.test(token) ||
    typeof expiry !== 'string' ||
    !/^[1-9]\d*$/.test(expiry)
  ) {
    return null;
  }
  const expiresAt = Number(expiry);
  return Number.isSafeInteger(expiresAt) && expiresAt > now() ? token : null;
}

function readOrganizationId(url: URL): string | null {
  const values = url.searchParams.getAll('organizationId');
  return values.length === 1 && isUUID(values[0]) ? values[0] : null;
}

function isSameOriginWriteRequest(request: Request, appOrigin: URL): boolean {
  return (
    request.headers.get('origin') === appOrigin.origin &&
    (request.headers.get('sec-fetch-site') === null ||
      request.headers.get('sec-fetch-site') === 'same-origin')
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
      throw new Error('Invalid request body.');
    }
  }
  if (!request.body) throw new Error('Invalid request body.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('Invalid request body.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!isRecord(parsed)) throw new Error('Invalid request body.');
  return parsed;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new Error('Invalid response.');
    }
  }
  if (!response.body) throw new Error('Invalid response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Invalid response.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function statusError(
  status: number,
  detail:
    | 'list'
    | 'detail'
    | 'write'
    | 'schedule'
    | 'expense'
    | 'invoice'
    | 'payment',
): Response {
  if (status === 401) return errorResponse(401, 'Authentication required.');
  if (status === 403) return errorResponse(403, 'Organisation access denied.');
  if (status === 404) {
    return errorResponse(
      404,
      detail === 'schedule'
        ? 'Rent schedule not found.'
        : detail === 'expense'
          ? 'Property expense not found.'
          : detail === 'invoice'
            ? 'Invoice not found.'
            : detail === 'payment'
              ? 'Payment not found.'
          : 'Lease not found.',
    );
  }
  if (status === 409) {
    return errorResponse(
      409,
      detail === 'expense'
        ? 'Property expense conflicts with existing data.'
        : detail === 'invoice' || detail === 'payment'
          ? 'Financial record conflicts with existing data.'
        : 'Lease conflicts with existing data.',
    );
  }
  if (status === 422) {
    return errorResponse(
      400,
      detail === 'expense'
        ? 'Property expense information is invalid.'
        : detail === 'invoice' || detail === 'payment'
          ? 'Financial record information is invalid.'
          : 'Lease information is invalid.',
    );
  }
  return errorResponse(
    503,
    detail === 'write'
      ? 'Lease could not be saved.'
      : detail === 'expense'
        ? 'Property Expense service unavailable.'
        : detail === 'invoice' || detail === 'payment'
          ? 'Financial service unavailable.'
        : 'Lease service unavailable.',
  );
}

export function createLeaseHandlers(dependencies: LeaseHandlerDependencies) {
  const configuration =
    dependencies.configuration ?? loadLeaseServiceConfiguration;
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;

  async function perform(
    request: Request,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    organizationId: string,
    expectedStatus: number,
    body?: unknown,
    detail:
      | 'list'
      | 'detail'
      | 'write'
      | 'schedule'
      | 'expense'
      | 'invoice'
      | 'payment' = 'detail',
  ): Promise<Response> {
    try {
      const token = await readAccessToken(request, dependencies.sessions, now);
      if (!token) return errorResponse(401, 'Authentication required.');
      const config = configuration();
      const url = new URL(path, config.baseUrl);
      const upstream = await fetcher(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (upstream.status !== expectedStatus || upstream.redirected) {
        return statusError(upstream.status, detail);
      }
      if (!upstream.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        return errorResponse(502, 'Invalid Lease Management response.');
      }
      const payload = await readJsonResponse(upstream);
      if (!isRecord(payload) && !Array.isArray(payload)) {
        return errorResponse(502, 'Invalid Lease Management response.');
      }
      return Response.json(payload, {
        status: expectedStatus,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    } catch {
      return errorResponse(503, 'Lease service unavailable.');
    }
  }

  async function getPermissions(request: Request): Promise<Response> {
    const organizationId = readOrganizationId(new URL(request.url));
    if (!organizationId) return errorResponse(400, 'Invalid lease request.');
    const response = await perform(
      request,
      'GET',
      `${API_PREFIX}/${organizationId}/lease-permissions`,
      organizationId,
      200,
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (
      !isRecord(payload) ||
      typeof payload.can_read !== 'boolean' ||
      typeof payload.can_create !== 'boolean' ||
      typeof payload.can_update !== 'boolean' ||
      Object.keys(payload).length !== 3
    ) {
      return errorResponse(502, 'Invalid Lease Management response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function list(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const organizationId = readOrganizationId(url);
    const allowedKeys = new Set([
      'organizationId',
      'search',
      'status',
      'limit',
      'offset',
      'sort_by',
      'sort_direction',
    ]);
    if (!organizationId || [...url.searchParams.keys()].some((key) => !allowedKeys.has(key))) {
      return errorResponse(400, 'Invalid lease request.');
    }
    for (const key of [
      'search',
      'status',
      'limit',
      'offset',
      'sort_by',
      'sort_direction',
    ]) {
      if (url.searchParams.getAll(key).length > 1) {
        return errorResponse(400, 'Invalid lease request.');
      }
    }
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('search');
    const limitValue = url.searchParams.get('limit') ?? '20';
    const offsetValue = url.searchParams.get('offset') ?? '0';
    const sortBy = url.searchParams.get('sort_by') ?? 'updated_at';
    const sortDirection = url.searchParams.get('sort_direction') ?? 'desc';
    const limit = Number(limitValue);
    const offset = Number(offsetValue);
    if (
      (status !== null && !STATUSES.has(status)) ||
      (search !== null && (!search.trim() || search.length > 100)) ||
      !/^\d+$/.test(limitValue) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !/^\d+$/.test(offsetValue) ||
      !Number.isSafeInteger(offset) ||
      offset > 10_000 ||
      !['lease_reference', 'status', 'start_date', 'expiry_date', 'rent_amount', 'updated_at'].includes(sortBy) ||
      !['asc', 'desc'].includes(sortDirection)
    ) {
      return errorResponse(400, 'Invalid lease request.');
    }
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      sort_by: sortBy,
      sort_direction: sortDirection,
    });
    if (status) query.set('status', status);
    if (search) query.set('search', search.trim());
    const response = await perform(
      request,
      'GET',
      `${API_PREFIX}/${organizationId}/leases?${query}`,
      organizationId,
      200,
      undefined,
      'list',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.items) ||
      payload.items.length > limit ||
      !Number.isSafeInteger(payload.total) ||
      !Number.isSafeInteger(payload.limit) ||
      payload.limit !== limit ||
      !Number.isSafeInteger(payload.offset) ||
      payload.offset !== offset ||
      payload.items.some((item) => !isLeaseSummary(item, organizationId))
    ) {
      return errorResponse(502, 'Invalid Lease Management response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  function scheduleContext(
    request: Request,
    leaseId: string,
  ): { organizationId: string; path: string } | Response {
    const url = new URL(request.url);
    const organizationId = readOrganizationId(url);
    if (
      !organizationId ||
      !isUUID(leaseId) ||
      [...url.searchParams.keys()].some((key) => key !== 'organizationId') ||
      url.searchParams.getAll('organizationId').length !== 1
    ) {
      return errorResponse(400, 'Invalid rent schedule request.');
    }
    return {
      organizationId,
      path: `${API_PREFIX}/${organizationId}/leases/${leaseId}/rent-schedules`,
    };
  }

  async function listRentSchedules(
    request: Request,
    leaseId: string,
  ): Promise<Response> {
    const context = scheduleContext(request, leaseId);
    if (context instanceof Response) return context;
    const response = await perform(
      request,
      'GET',
      context.path,
      context.organizationId,
      200,
      undefined,
      'schedule',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (
      !Array.isArray(payload) ||
      payload.some(
        (schedule) =>
          !isRentSchedule(schedule, context.organizationId, leaseId),
      )
    ) {
      return errorResponse(502, 'Invalid Rent Management response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function writeRentSchedule(
    request: Request,
    leaseId: string,
    scheduleId: string | undefined,
    operation: 'create' | 'update' | 'generate',
  ): Promise<Response> {
    const context = scheduleContext(request, leaseId);
    if (context instanceof Response) return context;
    if (scheduleId !== undefined && !isUUID(scheduleId)) {
      return errorResponse(400, 'Invalid rent schedule request.');
    }
    try {
      if (!isSameOriginWriteRequest(request, (dependencies.appOrigin ?? loadAppOrigin)())) {
        return errorResponse(403, 'Request origin is not allowed.');
      }
      const body =
        operation === 'generate' ? undefined : await readJsonBody(request);
      const expectedStatus = operation === 'create' ? 201 : 200;
      const method =
        operation === 'update' ? 'PATCH' : 'POST';
      const path =
        operation === 'create'
          ? context.path
          : `${context.path}/${scheduleId}${operation === 'generate' ? '/generate' : ''}`;
      const response = await perform(
        request,
        method,
        path,
        context.organizationId,
        expectedStatus,
        body,
        'schedule',
      );
      if (response.status !== expectedStatus) return response;
      const payload: unknown = await response.json();
      if (!isRentSchedule(payload, context.organizationId, leaseId)) {
        return errorResponse(502, 'Invalid Rent Management response.');
      }
      return Response.json(payload, {
        status: expectedStatus,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    } catch {
      return errorResponse(400, 'Invalid rent schedule request.');
    }
  }

  function expenseContext(
    request: Request,
    expenseId?: string,
  ): { organizationId: string; path: string } | Response {
    const url = new URL(request.url);
    const organizationId = readOrganizationId(url);
    if (
      !organizationId ||
      (expenseId !== undefined && !isUUID(expenseId)) ||
      [...url.searchParams.keys()].some(
        (key) => !['organizationId', 'limit', 'offset', 'asset_level'].includes(key),
      ) ||
      url.searchParams.getAll('organizationId').length !== 1
    ) {
      return errorResponse(400, 'Invalid property expense request.');
    }
    return {
      organizationId,
      path: `${API_PREFIX}/${organizationId}/property-expenses${
        expenseId ? `/${expenseId}` : ''
      }`,
    };
  }

  function isPropertyExpenseCreateBody(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const allowed = new Set([
      'idempotency_key',
      'asset_level',
      'portfolio_id',
      'site_id',
      'building_id',
      'unit_id',
      'category',
      'description',
      'amount',
      'currency',
      'expense_date',
      'recoverability',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    const required = [
      'idempotency_key',
      'asset_level',
      'portfolio_id',
      'category',
      'description',
      'amount',
      'currency',
      'expense_date',
      'recoverability',
    ];
    if (required.some((key) => !(key in value))) return false;
    const hierarchyValid =
      (value.asset_level === 'portfolio' &&
        !('site_id' in value) &&
        !('building_id' in value) &&
        !('unit_id' in value)) ||
      (value.asset_level === 'site' &&
        isUUID(value.site_id) &&
        !('building_id' in value) &&
        !('unit_id' in value)) ||
      (value.asset_level === 'building' &&
        isUUID(value.site_id) &&
        isUUID(value.building_id) &&
        !('unit_id' in value)) ||
      (value.asset_level === 'unit' &&
        isUUID(value.site_id) &&
        isUUID(value.building_id) &&
        isUUID(value.unit_id));
    return (
      hierarchyValid &&
      isUUID(value.idempotency_key) &&
      isUUID(value.portfolio_id) &&
      EXPENSE_CATEGORIES.has(String(value.category)) &&
      typeof value.description === 'string' &&
      value.description.trim().length > 0 &&
      value.description.length <= 250 &&
      typeof value.amount === 'string' &&
      /^\d{1,12}\.\d{2}$/.test(value.amount) &&
      CURRENCIES.has(String(value.currency)) &&
      isDate(value.expense_date) &&
      (value.recoverability === 'recoverable' ||
        value.recoverability === 'non_recoverable')
    );
  }

  function isPropertyExpenseUpdateBody(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const keys = Object.keys(value);
    if (keys.length === 0) return false;
    if (
      keys.some(
        (key) =>
          ![
            'category',
            'description',
            'amount',
            'currency',
            'expense_date',
            'recoverability',
          ].includes(key),
      )
    ) {
      return false;
    }
    if (value.category !== undefined && !EXPENSE_CATEGORIES.has(String(value.category))) {
      return false;
    }
    if (
      value.description !== undefined &&
      (typeof value.description !== 'string' ||
        value.description.trim().length === 0 ||
        value.description.length > 250)
    ) {
      return false;
    }
    if (
      value.amount !== undefined &&
      (typeof value.amount !== 'string' ||
        !/^\d{1,12}\.\d{2}$/.test(value.amount))
    ) {
      return false;
    }
    if (value.currency !== undefined && !CURRENCIES.has(String(value.currency))) {
      return false;
    }
    if (value.expense_date !== undefined && !isDate(value.expense_date)) {
      return false;
    }
    if (
      value.recoverability !== undefined &&
      value.recoverability !== 'recoverable' &&
      value.recoverability !== 'non_recoverable'
    ) {
      return false;
    }
    return true;
  }

  async function listPropertyExpenses(request: Request): Promise<Response> {
    const context = expenseContext(request);
    if (context instanceof Response) return context;
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get('limit') ?? '50';
    const offsetRaw = url.searchParams.get('offset') ?? '0';
    const limit = Number(limitRaw);
    const offset = Number(offsetRaw);
    const assetLevel = url.searchParams.get('asset_level');
    if (
      !/^(?:[1-9]\d?|100)$/.test(limitRaw) ||
      !/^(?:0|[1-9]\d{0,4})$/.test(offsetRaw) ||
      !Number.isSafeInteger(limit) ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset > 10_000 ||
      (assetLevel !== null &&
        !['portfolio', 'site', 'building', 'unit'].includes(assetLevel))
    ) {
      return errorResponse(400, 'Invalid property expense request.');
    }
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (assetLevel) query.set('asset_level', assetLevel);
    const response = await perform(
      request,
      'GET',
      `${context.path}?${query}`,
      context.organizationId,
      200,
      undefined,
      'expense',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (
      !Array.isArray(payload) ||
      payload.length > limit ||
      payload.some((expense) => !isPropertyExpense(expense, context.organizationId))
    ) {
      return errorResponse(502, 'Invalid Property Expense response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function writePropertyExpense(
    request: Request,
    expenseId?: string,
  ): Promise<Response> {
    const context = expenseContext(request, expenseId);
    if (context instanceof Response) return context;
    try {
      if (!isSameOriginWriteRequest(request, (dependencies.appOrigin ?? loadAppOrigin)())) {
        return errorResponse(403, 'Request origin is not allowed.');
      }
      const body = await readJsonBody(request);
      if (
        expenseId === undefined
          ? !isPropertyExpenseCreateBody(body)
          : !isPropertyExpenseUpdateBody(body)
      ) {
        return errorResponse(400, 'Invalid property expense request.');
      }
      const expectedStatus = expenseId === undefined ? 201 : 200;
      const response = await perform(
        request,
        expenseId === undefined ? 'POST' : 'PATCH',
        context.path,
        context.organizationId,
        expectedStatus,
        body,
        'expense',
      );
      if (response.status !== expectedStatus) return response;
      const payload: unknown = await response.json();
      if (!isPropertyExpense(payload, context.organizationId)) {
        return errorResponse(502, 'Invalid Property Expense response.');
      }
      return Response.json(payload, {
        status: expectedStatus,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    } catch {
      return errorResponse(400, 'Invalid property expense request.');
    }
  }

  async function getPropertyExpense(request: Request, expenseId: string): Promise<Response> {
    const context = expenseContext(request, expenseId);
    if (context instanceof Response) return context;
    const response = await perform(
      request,
      'GET',
      context.path,
      context.organizationId,
      200,
      undefined,
      'expense',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (!isPropertyExpense(payload, context.organizationId)) {
      return errorResponse(502, 'Invalid Property Expense response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function detail(
    request: Request,
    leaseId: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const organizationId = readOrganizationId(url);
    if (
      !organizationId ||
      [...url.searchParams.keys()].some((key) => key !== 'organizationId') ||
      url.searchParams.getAll('organizationId').length !== 1 ||
      !isUUID(leaseId)
    ) {
      return errorResponse(400, 'Invalid lease request.');
    }
    const response = await perform(
      request,
      'GET',
      `${API_PREFIX}/${organizationId}/leases/${leaseId}`,
      organizationId,
      200,
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (!isLeaseRecord(payload, organizationId, true)) {
      return errorResponse(502, 'Invalid Lease Management response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function write(
    request: Request,
    organizationId: string,
    leaseId?: string,
  ): Promise<Response> {
    if (!isUUID(organizationId) || (leaseId !== undefined && !isUUID(leaseId))) {
      return errorResponse(400, 'Invalid lease request.');
    }
    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some((key) => key !== 'organizationId') ||
      url.searchParams.getAll('organizationId').length !== 1 ||
      readOrganizationId(url) !== organizationId
    ) {
      return errorResponse(400, 'Invalid lease request.');
    }
    try {
      if (!isSameOriginWriteRequest(request, (dependencies.appOrigin ?? loadAppOrigin)())) {
        return errorResponse(403, 'Request origin is not allowed.');
      }
      const body = await readJsonBody(request);
      const expectedStatus = leaseId === undefined ? 201 : 200;
      const path =
        leaseId === undefined
          ? `${API_PREFIX}/${organizationId}/leases`
          : `${API_PREFIX}/${organizationId}/leases/${leaseId}`;
      const response = await perform(
        request,
        leaseId === undefined ? 'POST' : 'PATCH',
        path,
        organizationId,
        expectedStatus,
        body,
        'write',
      );
      if (response.status !== expectedStatus) return response;
      const payload: unknown = await response.json();
      if (!isLeaseRecord(payload, organizationId, true)) {
        return errorResponse(502, 'Invalid Lease Management response.');
      }
      return Response.json(payload, {
        status: expectedStatus,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    } catch {
      return errorResponse(400, 'Invalid lease request.');
    }
  }

  function financialContext(
    request: Request,
    recordId?: string,
  ): { organizationId: string; path: string } | Response {
    const url = new URL(request.url);
    const organizationId = readOrganizationId(url);
    if (
      !organizationId ||
      (recordId !== undefined && !isUUID(recordId)) ||
      url.searchParams.getAll('organizationId').length !== 1
    ) {
      return errorResponse(400, 'Invalid financial request.');
    }
    return { organizationId, path: `${API_PREFIX}/${organizationId}` };
  }

  function isInvoiceBody(value: unknown, create: boolean): boolean {
    if (!isRecord(value)) return false;
    const allowed = create
      ? ['lease_id', 'invoice_number', 'issue_date', 'due_date', 'currency', 'lines']
      : ['invoice_number', 'issue_date', 'due_date', 'lines'];
    const required = create ? allowed : [];
    const keys = Object.keys(value);
    if (
      keys.length === 0 ||
      keys.some((key) => !allowed.includes(key)) ||
      required.some((key) => !(key in value))
    ) {
      return false;
    }
    if (create && !isUUID(value.lease_id)) return false;
    if (
      value.invoice_number !== undefined &&
      (typeof value.invoice_number !== 'string' ||
        value.invoice_number.trim().length === 0 ||
        value.invoice_number.length > 100)
    ) {
      return false;
    }
    if (value.issue_date !== undefined && !isDate(value.issue_date)) return false;
    if (value.due_date !== undefined && !isDate(value.due_date)) return false;
    if (
      create &&
      typeof value.issue_date === 'string' &&
      typeof value.due_date === 'string' &&
      value.due_date < value.issue_date
    ) {
      return false;
    }
    if (value.currency !== undefined && !CURRENCIES.has(String(value.currency))) {
      return false;
    }
    if (value.lines !== undefined) {
      if (!Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > 100) {
        return false;
      }
      const sourceIds = new Set<string>();
      for (const line of value.lines) {
        if (
          !isInvoiceLineInput(line) ||
          Object.keys(line).some(
            (key) =>
              ![
                'description',
                'quantity',
                'unit_amount',
                'source_installment_id',
              ].includes(key),
          )
        ) {
          return false;
        }
        if (
          typeof line.source_installment_id === 'string' &&
          sourceIds.has(line.source_installment_id)
        ) {
          return false;
        }
        if (typeof line.source_installment_id === 'string') {
          sourceIds.add(line.source_installment_id);
        }
      }
    }
    return true;
  }

  function isPaymentBody(value: unknown): boolean {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            'idempotency_key',
            'reference',
            'received_on',
            'currency',
            'amount',
            'method_description',
            'allocations',
          ].includes(key),
      ) ||
      !isUUID(value.idempotency_key) ||
      typeof value.reference !== 'string' ||
      !value.reference.trim() ||
      value.reference.length > 100 ||
      !isDate(value.received_on) ||
      !CURRENCIES.has(String(value.currency)) ||
      typeof value.amount !== 'string' ||
      !MONEY_PATTERN.test(value.amount) ||
      moneyCents(value.amount) <= BigInt(0) ||
      typeof value.method_description !== 'string' ||
      !value.method_description.trim() ||
      value.method_description.length > 100 ||
      !Array.isArray(value.allocations) ||
      value.allocations.length < 1 ||
      value.allocations.length > 50
    ) {
      return false;
    }
    const invoices = new Set<string>();
    let allocated = BigInt(0);
    for (const item of value.allocations) {
      if (
        !isRecord(item) ||
        Object.keys(item).some((key) => !['invoice_id', 'amount'].includes(key)) ||
        !isUUID(item.invoice_id) ||
        typeof item.amount !== 'string' ||
        !MONEY_PATTERN.test(item.amount) ||
        moneyCents(item.amount) <= BigInt(0) ||
        invoices.has(item.invoice_id)
      ) {
        return false;
      }
      invoices.add(item.invoice_id);
      allocated += moneyCents(item.amount);
    }
    return allocated <= moneyCents(value.amount);
  }

  async function listInvoices(request: Request): Promise<Response> {
    const context = financialContext(request);
    if (context instanceof Response) return context;
    const url = new URL(request.url);
    const allowedKeys = new Set([
      'organizationId',
      'status',
      'receivable_status',
      'limit',
      'offset',
    ]);
    if ([...url.searchParams.keys()].some((key) => !allowedKeys.has(key))) {
      return errorResponse(400, 'Invalid invoice request.');
    }
    for (const key of ['organizationId', 'status', 'receivable_status', 'limit', 'offset']) {
      if (url.searchParams.getAll(key).length > 1) {
        return errorResponse(400, 'Invalid invoice request.');
      }
    }
    const statusValue = url.searchParams.get('status');
    const receivableStatus = url.searchParams.get('receivable_status');
    const limit = url.searchParams.get('limit') ?? '100';
    const offset = url.searchParams.get('offset') ?? '0';
    if (
      (statusValue !== null && !['draft', 'issued'].includes(statusValue)) ||
      (receivableStatus !== null &&
        !INVOICE_RECEIVABLE_STATUSES.has(receivableStatus)) ||
      !/^(?:[1-9]\d?|100)$/.test(limit) ||
      !/^(?:0|[1-9]\d{0,4})$/.test(offset) ||
      Number(offset) > 10_000
    ) {
      return errorResponse(400, 'Invalid invoice request.');
    }
    const query = new URLSearchParams({ limit, offset });
    if (statusValue) query.set('status', statusValue);
    if (receivableStatus) query.set('receivable_status', receivableStatus);
    const response = await perform(
      request,
      'GET',
      `${context.path}/invoices?${query}`,
      context.organizationId,
      200,
      undefined,
      'invoice',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (
      !Array.isArray(payload) ||
      payload.length > Number(limit) ||
      payload.some((item) => !isInvoice(item, context.organizationId))
    ) {
      return errorResponse(502, 'Invalid invoice response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function getInvoice(request: Request, invoiceId: string): Promise<Response> {
    const context = financialContext(request, invoiceId);
    if (context instanceof Response) return context;
    const response = await perform(
      request,
      'GET',
      `${context.path}/invoices/${invoiceId}`,
      context.organizationId,
      200,
      undefined,
      'invoice',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (!isInvoice(payload, context.organizationId)) {
      return errorResponse(502, 'Invalid invoice response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function writeInvoice(
    request: Request,
    invoiceId?: string,
    issue = false,
  ): Promise<Response> {
    const context = financialContext(request, invoiceId);
    if (context instanceof Response) return context;
    try {
      if (!isSameOriginWriteRequest(request, (dependencies.appOrigin ?? loadAppOrigin)())) {
        return errorResponse(403, 'Request origin is not allowed.');
      }
      const body = await readJsonBody(request);
      if (
        (issue && (!isRecord(body) || Object.keys(body).length !== 0)) ||
        (!issue && !isInvoiceBody(body, invoiceId === undefined))
      ) {
        return errorResponse(400, 'Invalid invoice request.');
      }
      const expectedStatus = invoiceId === undefined ? 201 : 200;
      const method = invoiceId === undefined ? 'POST' : issue ? 'POST' : 'PATCH';
      const path = issue
        ? `${context.path}/invoices/${invoiceId}/issue`
        : invoiceId === undefined
          ? `${context.path}/invoices`
          : `${context.path}/invoices/${invoiceId}`;
      const response = await perform(
        request,
        method,
        path,
        context.organizationId,
        expectedStatus,
        body,
        'invoice',
      );
      if (response.status !== expectedStatus) return response;
      const payload: unknown = await response.json();
      if (!isInvoice(payload, context.organizationId)) {
        return errorResponse(502, 'Invalid invoice response.');
      }
      return Response.json(payload, {
        status: expectedStatus,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    } catch {
      return errorResponse(400, 'Invalid invoice request.');
    }
  }

  async function eligibleInstallments(
    request: Request,
    leaseId: string,
  ): Promise<Response> {
    const context = financialContext(request);
    if (context instanceof Response) return context;
    const url = new URL(request.url);
    if (
      !isUUID(leaseId) ||
      [...url.searchParams.keys()].some((key) => key !== 'organizationId')
    ) {
      return errorResponse(400, 'Invalid scheduled charge request.');
    }
    const response = await perform(
      request,
      'GET',
      `${context.path}/leases/${leaseId}/eligible-installments`,
      context.organizationId,
      200,
      undefined,
      'invoice',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (
      !Array.isArray(payload) ||
      payload.length > 500 ||
      payload.some((item) => !isEligibleInstallment(item, leaseId))
    ) {
      return errorResponse(502, 'Invalid scheduled charge response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function leaseReceivables(
    request: Request,
    leaseId: string,
  ): Promise<Response> {
    const context = financialContext(request);
    if (context instanceof Response) return context;
    const url = new URL(request.url);
    if (
      !isUUID(leaseId) ||
      [...url.searchParams.keys()].some((key) => key !== 'organizationId')
    ) {
      return errorResponse(400, 'Invalid receivables request.');
    }
    const response = await perform(
      request,
      'GET',
      `${context.path}/leases/${leaseId}/receivables`,
      context.organizationId,
      200,
      undefined,
      'invoice',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (
      !isRecord(payload) ||
      !isUUID(payload.lease_id) ||
      payload.lease_id.toLowerCase() !== leaseId.toLowerCase() ||
      typeof payload.lease_reference !== 'string' ||
      !CURRENCIES.has(String(payload.currency)) ||
      !['issued_total', 'allocated_total', 'outstanding_total', 'overdue_total'].every(
        (key) =>
          typeof payload[key] === 'string' &&
          MONEY_PATTERN.test(payload[key] as string),
      ) ||
      !Array.isArray(payload.invoices) ||
      payload.invoices.some((invoice) => !isInvoice(invoice, context.organizationId))
    ) {
      return errorResponse(502, 'Invalid receivables response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function listPayments(request: Request): Promise<Response> {
    const context = financialContext(request);
    if (context instanceof Response) return context;
    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some(
        (key) => !['organizationId', 'limit', 'offset'].includes(key),
      )
    ) {
      return errorResponse(400, 'Invalid payment request.');
    }
    const limit = url.searchParams.get('limit') ?? '100';
    const offset = url.searchParams.get('offset') ?? '0';
    if (
      !/^(?:[1-9]\d?|100)$/.test(limit) ||
      !/^(?:0|[1-9]\d{0,4})$/.test(offset) ||
      Number(offset) > 10_000
    ) {
      return errorResponse(400, 'Invalid payment request.');
    }
    const response = await perform(
      request,
      'GET',
      `${context.path}/payments?limit=${limit}&offset=${offset}`,
      context.organizationId,
      200,
      undefined,
      'payment',
    );
    if (response.status !== 200) return response;
    const payload: unknown = await response.json();
    if (
      !Array.isArray(payload) ||
      payload.length > Number(limit) ||
      payload.some((item) => !isPayment(item, context.organizationId))
    ) {
      return errorResponse(502, 'Invalid payment response.');
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  }

  async function createPayment(request: Request): Promise<Response> {
    const context = financialContext(request);
    if (context instanceof Response) return context;
    try {
      if (!isSameOriginWriteRequest(request, (dependencies.appOrigin ?? loadAppOrigin)())) {
        return errorResponse(403, 'Request origin is not allowed.');
      }
      const body = await readJsonBody(request);
      if (!isPaymentBody(body)) return errorResponse(400, 'Invalid payment request.');
      const response = await perform(
        request,
        'POST',
        `${context.path}/payments`,
        context.organizationId,
        201,
        body,
        'payment',
      );
      if (response.status !== 201) return response;
      const payload: unknown = await response.json();
      if (!isPayment(payload, context.organizationId)) {
        return errorResponse(502, 'Invalid payment response.');
      }
      return Response.json(payload, {
        status: 201,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    } catch {
      return errorResponse(400, 'Invalid payment request.');
    }
  }

  return {
    getPermissions,
    list,
    listRentSchedules,
    createRentSchedule: (request: Request, leaseId: string) =>
      writeRentSchedule(request, leaseId, undefined, 'create'),
    updateRentSchedule: (
      request: Request,
      leaseId: string,
      scheduleId: string,
    ) => writeRentSchedule(request, leaseId, scheduleId, 'update'),
    generateRentSchedule: (
      request: Request,
      leaseId: string,
      scheduleId: string,
    ) => writeRentSchedule(request, leaseId, scheduleId, 'generate'),
    listPropertyExpenses,
    createPropertyExpense: (request: Request) => writePropertyExpense(request),
    getPropertyExpense,
    updatePropertyExpense: (request: Request, expenseId: string) =>
      writePropertyExpense(request, expenseId),
    listInvoices,
    createInvoice: (request: Request) => writeInvoice(request),
    getInvoice,
    updateInvoice: (request: Request, invoiceId: string) =>
      writeInvoice(request, invoiceId),
    issueInvoice: (request: Request, invoiceId: string) =>
      writeInvoice(request, invoiceId, true),
    eligibleInstallments,
    leaseReceivables,
    listPayments,
    createPayment,
    detail,
    create: (request: Request, organizationId: string) =>
      write(request, organizationId),
    update: (request: Request, organizationId: string, leaseId: string) =>
      write(request, organizationId, leaseId),
  };
}
