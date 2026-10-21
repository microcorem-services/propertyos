import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLeaseHandlers } from '../../src/lib/auth/lease-handlers';
import { serializeSessionCookie } from '../../src/lib/auth/session';

const now = 1_800_000_000_000;
const sessionId = 'l'.repeat(43);
const token = 'header.payload.signature';
const organizationId = '00000000-0000-4000-8000-000000000001';
const leaseId = '00000000-0000-4000-8000-000000000101';
const unit = {
  portfolio_id: '00000000-0000-4000-8000-000000000201',
  site_id: '00000000-0000-4000-8000-000000000301',
  building_id: '00000000-0000-4000-8000-000000000401',
  unit_id: '00000000-0000-4000-8000-000000000501',
  verified_status: 'active',
};
const party = {
  id: '00000000-0000-4000-8000-000000000601',
  legal_name: 'Example Tenant Ltd',
  role: 'tenant',
  party_type: 'organization',
};
const lease = {
  id: leaseId,
  organization_id: organizationId,
  lease_reference: 'LEASE-2026-001',
  start_date: '2026-04-01',
  expiry_date: '2031-03-31',
  break_date: null,
  rent_amount: '12500.50',
  currency: 'GBP',
  payment_frequency: 'quarterly',
  status: 'active',
  units: [unit],
  parties: [party],
  audit_events: [
    {
      actor_id: '00000000-0000-4000-8000-000000000701',
      event_type: 'created',
      changed_fields: ['lease_reference'],
      occurred_at: '2026-04-01T10:00:00Z',
    },
  ],
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-01T10:00:00Z',
};
const rentSchedule = {
  id: '00000000-0000-4000-8000-000000000801',
  organization_id: organizationId,
  lease_id: leaseId,
  charge_category: 'base_rent',
  amount_per_period: '12500.50',
  currency: 'GBP',
  payment_frequency: 'monthly',
  start_date: '2026-04-01',
  end_date: '2026-06-29',
  due_day: 31,
  short_month_rule: 'clamp_to_month_end',
  status: 'draft',
  manual_review_reasons: ['commencement_not_on_due_date'],
  installments: [
    {
      id: '00000000-0000-4000-8000-000000000901',
      due_date: '2026-04-30',
      amount: '12500.50',
      currency: 'GBP',
      status: 'expected',
    },
    {
      id: '00000000-0000-4000-8000-000000000902',
      due_date: '2026-05-31',
      amount: '12500.50',
      currency: 'GBP',
      status: 'expected',
    },
  ],
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-01T10:00:00Z',
};

function jsonResponse(status: number, payload: unknown): Response {
  return Response.json(payload, { status });
}

function setup(options: {
  status?: number;
  payload?: unknown;
  session?: { data: Record<string, string> } | null;
} = {}) {
  let calls = 0;
  let requestedUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const session =
    options.session === undefined
      ? {
          data: {
            accessToken: token,
            accessTokenExpiresAt: String(now + 60_000),
          },
        }
      : options.session;
  const handlers = createLeaseHandlers({
    configuration: () => ({
      baseUrl: new URL('https://lease-service.example.test/'),
      timeoutMs: 2_500,
    }),
    appOrigin: () => new URL('https://bowera.example.test/'),
    sessions: () => ({ retrieve: async () => session }),
    fetch: async (input, init) => {
      calls += 1;
      requestedUrl = new URL(input instanceof Request ? input.url : String(input));
      requestInit = init;
      return jsonResponse(options.status ?? 200, options.payload ?? lease);
    },
    now: () => now,
  });
  const cookie = serializeSessionCookie(sessionId, 60).split(';', 1)[0];
  const request = (
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: unknown,
    origin = 'https://bowera.example.test',
  ) =>
    new Request(`https://bowera.example.test${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    handlers,
    request,
    calls: () => calls,
    requestedUrl: () => requestedUrl,
    requestInit: () => requestInit,
  };
}

test('lease register BFF forwards the session identity and validates org-scoped page data', async () => {
  const summary = {
    ...lease,
    units: lease.units.map(({ verified_status: _verifiedStatus, ...reference }) => reference),
  };
  delete (summary as Partial<typeof lease>).audit_events;
  const context = setup({
    payload: { items: [summary], total: 1, limit: 20, offset: 0 },
  });
  const response = await context.handlers.list(
    context.request(
      `/api/leases?organizationId=${organizationId}&limit=20&offset=0`,
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [summary],
    total: 1,
    limit: 20,
    offset: 0,
  });
  assert.equal(
    context.requestedUrl()?.href,
    `https://lease-service.example.test/api/v1/organizations/${organizationId}/leases?limit=20&offset=0&sort_by=updated_at&sort_direction=desc`,
  );
  assert.equal(
    new Headers(context.requestInit()?.headers).get('authorization'),
    `Bearer ${token}`,
  );
  assert.equal(context.requestInit()?.cache, 'no-store');
  assert.equal(context.requestInit()?.redirect, 'manual');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('lease register rejects malformed selectors and cross-organization responses', async () => {
  const malformedRequest = setup();
  assert.equal(
    (
      await malformedRequest.handlers.list(
        malformedRequest.request('/api/leases?organizationId=not-a-uuid'),
      )
    ).status,
    400,
  );
  assert.equal(malformedRequest.calls(), 0);

  const wrongOrganization = setup({
    payload: {
      items: [{ ...lease, organization_id: '00000000-0000-4000-8000-000000000002' }],
      total: 1,
      limit: 20,
      offset: 0,
    },
  });
  assert.equal(
    (
      await wrongOrganization.handlers.list(
        wrongOrganization.request(`/api/leases?organizationId=${organizationId}`),
      )
    ).status,
    502,
  );
});

test('create requires same-origin, authenticated requests and preserves decimal text', async () => {
  const fields = {
    lease_reference: 'LEASE-2026-001',
    start_date: '2026-04-01',
    expiry_date: '2031-03-31',
    break_date: null,
    rent_amount: '12500.50',
    currency: 'GBP',
    payment_frequency: 'quarterly',
    status: 'draft',
    units: [unit],
    parties: [{ legal_name: 'Example Tenant Ltd', role: 'tenant', party_type: 'organization' }],
  };
  const context = setup({ status: 201 });
  const response = await context.handlers.create(
    context.request(
      `/api/leases?organizationId=${organizationId}`,
      'POST',
      fields,
    ),
    organizationId,
  );
  assert.equal(response.status, 201);
  assert.equal(
    JSON.parse(String(context.requestInit()?.body)).rent_amount,
    '12500.50',
  );

  const foreignOrigin = setup();
  assert.equal(
    (
      await foreignOrigin.handlers.create(
        foreignOrigin.request(
          `/api/leases?organizationId=${organizationId}`,
          'POST',
          fields,
          'https://attacker.example',
        ),
        organizationId,
      )
    ).status,
    403,
  );
  assert.equal(foreignOrigin.calls(), 0);
});

test('detail and update validate identifiers and map upstream errors safely', async () => {
  const context = setup();
  const invalidId = await context.handlers.detail(
    context.request(`/api/leases/not-a-uuid?organizationId=${organizationId}`),
    'not-a-uuid',
  );
  assert.equal(invalidId.status, 400);
  assert.equal(context.calls(), 0);

  const forbidden = setup({ status: 403, payload: { detail: 'sensitive upstream data' } });
  const denied = await forbidden.handlers.update(
    forbidden.request(
      `/api/leases/${leaseId}?organizationId=${organizationId}`,
      'PATCH',
      { status: 'active' },
    ),
    organizationId,
    leaseId,
  );
  assert.equal(denied.status, 403);
  assert.doesNotMatch(await denied.text(), /sensitive upstream data/);
});

test('permission endpoint validates exact boolean decisions', async () => {
  const context = setup({
    payload: { can_read: true, can_create: false, can_update: true },
  });
  const response = await context.handlers.getPermissions(
    context.request(`/api/leases/permissions?organizationId=${organizationId}`),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    can_read: true,
    can_create: false,
    can_update: true,
  });

  const malformed = setup({ payload: { can_read: true, can_create: true, can_update: 'yes' } });
  assert.equal(
    (
      await malformed.handlers.getPermissions(
        malformed.request(`/api/leases/permissions?organizationId=${organizationId}`),
      )
    ).status,
    502,
  );
});

test('rent schedule BFF scopes responses to the authenticated organization and lease', async () => {
  const context = setup({ payload: [rentSchedule] });
  const path = `/api/leases/${leaseId}/rent-schedules?organizationId=${organizationId}`;
  const response = await context.handlers.listRentSchedules(
    context.request(path),
    leaseId,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [rentSchedule]);
  assert.equal(
    context.requestedUrl()?.href,
    `https://lease-service.example.test/api/v1/organizations/${organizationId}/leases/${leaseId}/rent-schedules`,
  );
  assert.equal(context.requestInit()?.cache, 'no-store');

  const crossOrganization = setup({
    payload: [{ ...rentSchedule, organization_id: '00000000-0000-4000-8000-000000000002' }],
  });
  assert.equal(
    (
      await crossOrganization.handlers.listRentSchedules(
        crossOrganization.request(path),
        leaseId,
      )
    ).status,
    502,
  );

  const wrongLease = setup({
    payload: [{ ...rentSchedule, lease_id: '00000000-0000-4000-8000-000000000102' }],
  });
  assert.equal(
    (
      await wrongLease.handlers.listRentSchedules(
        wrongLease.request(path),
        leaseId,
      )
    ).status,
    502,
  );
});

test('rent schedule writes require same-origin session and validate decimal responses', async () => {
  const fields = {
    amount_per_period: '12500.50',
    payment_frequency: 'monthly',
    start_date: '2026-04-01',
    end_date: '2026-06-29',
    due_day: 31,
    short_month_rule: 'clamp_to_month_end',
  };
  const path = `/api/leases/${leaseId}/rent-schedules?organizationId=${organizationId}`;
  const create = setup({ status: 201, payload: rentSchedule });
  const response = await create.handlers.createRentSchedule(
    create.request(path, 'POST', fields),
    leaseId,
  );
  assert.equal(response.status, 201);
  assert.equal(
    JSON.parse(String(create.requestInit()?.body)).amount_per_period,
    '12500.50',
  );

  const foreignOrigin = setup({ status: 201, payload: rentSchedule });
  assert.equal(
    (
      await foreignOrigin.handlers.createRentSchedule(
        foreignOrigin.request(path, 'POST', fields, 'https://attacker.example'),
        leaseId,
      )
    ).status,
    403,
  );
  assert.equal(foreignOrigin.calls(), 0);

  const malformed = setup({
    status: 201,
    payload: {
      ...rentSchedule,
      installments: [
        ...rentSchedule.installments,
        { ...rentSchedule.installments[0] },
      ],
    },
  });
  assert.equal(
    (
      await malformed.handlers.createRentSchedule(
        malformed.request(path, 'POST', fields),
        leaseId,
      )
    ).status,
    502,
  );
});

test('rent schedule generation requests are session authenticated and idempotency is forwarded', async () => {
  const path = `/api/leases/${leaseId}/rent-schedules/${rentSchedule.id}/generate?organizationId=${organizationId}`;
  const context = setup({ payload: rentSchedule });
  const generated = await context.handlers.generateRentSchedule(
    context.request(path, 'POST'),
    leaseId,
    rentSchedule.id,
  );
  assert.equal(generated.status, 200);
  assert.equal(
    context.requestedUrl()?.pathname,
    `/api/v1/organizations/${organizationId}/leases/${leaseId}/rent-schedules/${rentSchedule.id}/generate`,
  );
  assert.equal(
    new Headers(context.requestInit()?.headers).get('authorization'),
    `Bearer ${token}`,
  );

  const noSession = setup({ session: null });
  assert.equal(
    (
      await noSession.handlers.generateRentSchedule(
        noSession.request(path, 'POST'),
        leaseId,
        rentSchedule.id,
      )
    ).status,
    401,
  );
  assert.equal(noSession.calls(), 0);
});
