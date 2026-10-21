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
        (event.event_type === 'created' || event.event_type === 'updated') &&
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

function statusError(status: number, detail: 'list' | 'detail' | 'write'): Response {
  if (status === 401) return errorResponse(401, 'Authentication required.');
  if (status === 403) return errorResponse(403, 'Organisation access denied.');
  if (status === 404) return errorResponse(404, 'Lease not found.');
  if (status === 409) return errorResponse(409, 'Lease conflicts with existing data.');
  if (status === 422) return errorResponse(400, 'Lease information is invalid.');
  return errorResponse(
    503,
    detail === 'write' ? 'Lease could not be saved.' : 'Lease service unavailable.',
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
    detail: 'list' | 'detail' | 'write' = 'detail',
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
      if (!isRecord(payload)) return errorResponse(502, 'Invalid Lease Management response.');
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

  return {
    getPermissions,
    list,
    detail,
    create: (request: Request, organizationId: string) =>
      write(request, organizationId),
    update: (request: Request, organizationId: string, leaseId: string) =>
      write(request, organizationId, leaseId),
  };
}
