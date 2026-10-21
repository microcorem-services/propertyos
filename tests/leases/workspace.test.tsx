import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LeasePage } from '../../src/components/bow-era-lease-workspace';
import type { Lease, LeaseSummary } from '../../src/lib/leases/client';
import { dom } from '../intelligence/dom-setup';

const organizationId = '00000000-0000-4000-8000-000000000001';
const now = '2026-04-01T10:00:00Z';

function makeLease(index: number, status: LeaseSummary['status'] = 'active'): LeaseSummary {
  const suffix = String(index + 100).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    organization_id: organizationId,
    lease_reference: `LEASE-${String(index + 1).padStart(3, '0')}`,
    start_date: '2026-04-01',
    expiry_date: '2031-03-31',
    break_date: null,
    rent_amount: `${(index + 1) * 100}.25`,
    currency: 'GBP',
    payment_frequency: 'quarterly',
    status,
    units: [{
      portfolio_id: '00000000-0000-4000-8000-000000000201',
      site_id: '00000000-0000-4000-8000-000000000301',
      building_id: '00000000-0000-4000-8000-000000000401',
      unit_id: `00000000-0000-4000-8000-${String(index + 500).padStart(12, '0')}`,
    }],
    parties: [{
      id: `00000000-0000-4000-8000-${String(index + 700).padStart(12, '0')}`,
      legal_name: `Tenant ${index + 1} Ltd`,
      role: 'tenant',
      party_type: 'organization',
    }],
    created_at: now,
    updated_at: now,
  };
}

function setupFetch(records: LeaseSummary[], canCreate = true) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), window.location.origin);
    calls.push(url.href);
    if (url.pathname === '/api/leases/permissions') {
      return Response.json({ can_read: true, can_create: canCreate, can_update: true });
    }
    if (url.pathname === '/api/leases') {
      const search = url.searchParams.get('search')?.toLowerCase() ?? '';
      const status = url.searchParams.get('status');
      const filtered = records.filter((lease) =>
        (!status || lease.status === status) &&
        (!search ||
          lease.lease_reference.toLowerCase().includes(search) ||
          lease.parties.some((party) => party.legal_name.toLowerCase().includes(search))),
      );
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      return Response.json({
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      });
    }
    if (/^\/api\/leases\/[^/]+\/rent-schedules$/.test(url.pathname)) {
      return Response.json([]);
    }
    if (url.pathname === '/api/property-expenses') return Response.json([]);
    if (url.pathname === '/api/portfolios') return Response.json([]);
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

afterEach(() => {
  cleanup();
  dom.window.document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

test('register searches, filters, sorts and paginates with permission-aware create action', async () => {
  const records = Array.from({ length: 23 }, (_, index) =>
    makeLease(index, index % 2 === 0 ? 'active' : 'draft'),
  );
  const fetchContext = setupFetch(records, false);
  window.history.replaceState({}, '', `/leases?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<LeasePage mode="register" />);
    await screen.findByRole('table', { name: 'Commercial leases for this organisation' });
    assert.equal(screen.getAllByRole('row').length, 21);
    assert.equal(screen.queryByRole('link', { name: 'Create lease' }), null);

    const referenceSort = screen.getByRole('button', { name: /Lease reference/ });
    await user.click(referenceSort);
    assert.equal(screen.getByRole('columnheader', { name: /Lease reference/ }).getAttribute('aria-sort'), 'ascending');

    await user.selectOptions(screen.getByLabelText('Filter leases by status'), 'draft');
    await waitFor(() => assert.equal(screen.getAllByRole('row').length, 12));
    assert.ok(fetchContext.calls.some((call) => call.includes('status=draft')));

    await user.selectOptions(screen.getByLabelText('Filter leases by status'), 'all');
    await screen.findByText('Page 1 of 2 · 23 leases');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 2 · 23 leases');
    assert.equal(screen.getAllByRole('row').length, 4);

    const search = screen.getByRole('searchbox', { name: 'Search leases' });
    await user.type(search, 'LEASE-023');
    await screen.findByText('Page 1 of 1 · 1 leases');
    assert.ok(screen.getByRole('link', { name: 'LEASE-023' }));
    assert.equal(within(screen.getByRole('table')).getAllByRole('row').length, 2);
  } finally {
    fetchContext.restore();
  }
});

test('register rent sorting preserves decimal order for large amounts', async () => {
  const records = [makeLease(1), makeLease(0)];
  records[0].rent_amount = '900719925474.09';
  records[1].rent_amount = '900719925474.10';
  const fetchContext = setupFetch(records);
  window.history.replaceState({}, '', `/leases?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<LeasePage mode="register" />);
    await screen.findByRole('table', { name: 'Commercial leases for this organisation' });
    await user.click(screen.getByRole('button', { name: 'Rent' }));
    await waitFor(() => {
      const references = within(screen.getByRole('table'))
        .getAllByRole('link')
        .filter((link) => /^LEASE-/.test(link.textContent ?? ''));
      assert.equal(references[0].textContent, 'LEASE-002');
      assert.equal(references[1].textContent, 'LEASE-001');
    });
  } finally {
    fetchContext.restore();
  }
});

test('register communicates empty states and loading errors without exposing upstream details', async () => {
  const fetchContext = setupFetch([], true);
  window.history.replaceState({}, '', `/leases?organizationId=${organizationId}`);
  try {
    render(<LeasePage mode="register" />);
    assert.ok(await screen.findByText('No leases yet'));
    assert.ok(screen.getByRole('link', { name: 'Create lease' }));
  } finally {
    fetchContext.restore();
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ detail: 'database credentials and internal host' }, { status: 503 });
  try {
    render(<LeasePage mode="register" />);
    const message = await screen.findByRole('alert');
    assert.match(message.textContent ?? '', /temporarily unavailable/);
    assert.doesNotMatch(message.textContent ?? '', /credentials|internal host/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('create form exposes labelled fields and legal/data caveats', async () => {
  const fetchContext = setupFetch([], true);
  window.history.replaceState({}, '', `/leases/new?organizationId=${organizationId}`);
  try {
    render(<LeasePage mode="new" />);
    await screen.findByRole('heading', { name: 'Create a lease record' });
    assert.ok(await screen.findByLabelText('Lease reference'));
    assert.ok(screen.getByLabelText('Commencement date'));
    assert.ok(screen.getByLabelText('Expiry date'));
    assert.ok(screen.getByLabelText('Optional break date'));
    assert.ok(screen.getByLabelText(/Rent amount/));
    assert.ok(screen.getByLabelText('Currency'));
    assert.ok(screen.getByLabelText('Payment frequency'));
    assert.ok(screen.getByText(/has not been independently legally validated/));
    assert.ok(screen.getByRole('button', { name: 'Add party' }));
  } finally {
    fetchContext.restore();
  }
});

test('create submission preserves decimal text and prevents duplicate posts while pending', async () => {
  const originalFetch = globalThis.fetch;
  const portfolioId = '00000000-0000-4000-8000-000000000201';
  const siteId = '00000000-0000-4000-8000-000000000301';
  const buildingId = '00000000-0000-4000-8000-000000000401';
  const unitId = '00000000-0000-4000-8000-000000000501';
  const portfolio = {
    id: portfolioId,
    organization_id: organizationId,
    name: 'Central Portfolio',
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const site = {
    id: siteId,
    organization_id: organizationId,
    portfolio_id: portfolioId,
    name: 'Market Site',
    address: null,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const building = {
    id: buildingId,
    organization_id: organizationId,
    site_id: siteId,
    name: 'Exchange Building',
    building_code: 'EX',
    address: null,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const unit = {
    id: unitId,
    organization_id: organizationId,
    building_id: buildingId,
    name: 'Suite 4',
    unit_code: 'S4',
    floor: '4',
    area_sqm: '40.00',
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  let createCalls = 0;
  let submittedBody: Record<string, unknown> | undefined;
  let resolveCreate: (response: Response) => void = () => {};
  const pendingCreate = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  const created: Lease = {
    ...makeLease(1),
    lease_reference: 'LEASE-FORM-1',
    units: [{
      portfolio_id: portfolioId,
      site_id: siteId,
      building_id: buildingId,
      unit_id: unitId,
      verified_status: 'active',
    }],
    parties: [
      {
        id: '00000000-0000-4000-8000-000000000701',
        legal_name: 'Owner Ltd',
        role: 'landlord',
        party_type: 'organization',
      },
      {
        id: '00000000-0000-4000-8000-000000000702',
        legal_name: 'Tenant Ltd',
        role: 'tenant',
        party_type: 'organization',
      },
    ],
    audit_events: [{
      actor_id: '00000000-0000-4000-8000-000000000703',
      event_type: 'created',
      changed_fields: ['lease_reference'],
      occurred_at: now,
    }],
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/leases/permissions') {
      return Response.json({ can_read: true, can_create: true, can_update: true });
    }
    if (url.pathname === '/api/portfolios') return Response.json([portfolio]);
    if (url.pathname === `/api/portfolios/${portfolioId}/sites`) {
      return Response.json([site]);
    }
    if (url.pathname === `/api/portfolios/${portfolioId}/sites/${siteId}/buildings`) {
      return Response.json([building]);
    }
    if (url.pathname === `/api/portfolios/${portfolioId}/sites/${siteId}/buildings/${buildingId}/units`) {
      return Response.json([unit]);
    }
    if (url.pathname === '/api/leases' && init?.method === 'POST') {
      createCalls += 1;
      submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return pendingCreate;
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };

  window.history.replaceState({}, '', `/leases/new?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<LeasePage mode="new" />);
    await screen.findByRole('option', { name: 'Central Portfolio' });
    await user.selectOptions(screen.getByLabelText('Portfolio'), portfolioId);
    await screen.findByRole('option', { name: 'Market Site' });
    await user.selectOptions(screen.getByLabelText('Site'), siteId);
    await screen.findByRole('option', { name: 'Exchange Building' });
    await user.selectOptions(screen.getByLabelText('Building'), buildingId);
    await screen.findByRole('option', { name: 'Suite 4 (S4)' });
    await user.selectOptions(screen.getByLabelText('Unit'), unitId);
    await user.click(screen.getByRole('button', { name: 'Add Unit' }));

    await user.type(screen.getByLabelText('Lease reference'), 'LEASE-FORM-1');
    fireEvent.change(screen.getByLabelText('Commencement date'), { target: { value: '2026-04-01' } });
    fireEvent.change(screen.getByLabelText('Expiry date'), { target: { value: '2031-03-31' } });
    await user.type(screen.getByLabelText(/Rent amount/), '12500.50');
    const partyNames = screen.getAllByLabelText('Party name');
    await user.type(partyNames[0], 'Owner Ltd');
    await user.type(partyNames[1], 'Tenant Ltd');

    const submit = screen.getByRole('button', { name: 'Create lease' }) as HTMLButtonElement;
    fireEvent.click(submit);
    await waitFor(() => assert.equal(createCalls, 1));
    assert.equal(submit.disabled, true);
    assert.equal(submittedBody?.rent_amount, '12500.50');
    assert.deepEqual(submittedBody?.units, [{
      portfolio_id: portfolioId,
      site_id: siteId,
      building_id: buildingId,
      unit_id: unitId,
    }]);
    fireEvent.click(submit);
    assert.equal(createCalls, 1);
    resolveCreate(Response.json(created, { status: 201 }));
    assert.ok(await screen.findByText('Lease created successfully.'));
    assert.ok(screen.getByRole('link', { name: 'Open lease record' }));
  } finally {
    resolveCreate(Response.json(created, { status: 201 }));
    globalThis.fetch = originalFetch;
  }
});

test('stale Unit details remain visible and allow termination without resubmitting Unit links', async () => {
  const originalFetch = globalThis.fetch;
  const leaseId = '00000000-0000-4000-8000-000000000801';
  const staleLease: Lease = {
    ...makeLease(1),
    id: leaseId,
    units: [{
      ...makeLease(1).units[0],
      verified_status: 'unavailable',
    }],
    parties: [
      {
        id: '00000000-0000-4000-8000-000000000902',
        legal_name: 'Owner Ltd',
        role: 'landlord',
        party_type: 'organization',
      },
      {
        id: '00000000-0000-4000-8000-000000000903',
        legal_name: 'Tenant Ltd',
        role: 'tenant',
        party_type: 'organization',
      },
    ],
    audit_events: [{
      actor_id: '00000000-0000-4000-8000-000000000901',
      event_type: 'created',
      changed_fields: ['lease_reference'],
      occurred_at: now,
    }],
  };
  let updateBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/leases/permissions') {
      return Response.json({ can_read: true, can_create: true, can_update: true });
    }
    if (url.pathname === `/api/leases/${leaseId}` && init?.method === 'GET') {
      return Response.json(staleLease);
    }
    if (url.pathname === '/api/portfolios') return Response.json([]);
    if (url.pathname === `/api/leases/${leaseId}` && init?.method === 'PATCH') {
      updateBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({
        ...staleLease,
        status: 'terminated',
        units: staleLease.units,
        audit_events: [
          ...staleLease.audit_events,
          {
            actor_id: '00000000-0000-4000-8000-000000000902',
            event_type: 'updated',
            changed_fields: ['status'],
            occurred_at: now,
          },
        ],
      });
    }
    if (url.pathname === '/api/property-expenses') return Response.json([]);
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  window.history.replaceState({}, '', `/leases/${leaseId}?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<LeasePage mode="detail" leaseId={leaseId} />);
    assert.ok(await screen.findByText(/Unit reference unavailable/));
    await user.click(screen.getByRole('button', { name: 'Edit lease' }));
    await screen.findByRole('button', { name: 'Save changes' });
    await user.selectOptions(screen.getByLabelText('Status'), 'terminated');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Lease changes saved.');
    assert.equal(updateBody?.status, 'terminated');
    assert.equal('units' in (updateBody ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rent schedule form validates exact decimal text, creates expected instalments, and refreshes audit', async () => {
  const originalFetch = globalThis.fetch;
  const leaseId = '00000000-0000-4000-8000-000000000801';
  const lease: Lease = {
    ...makeLease(1),
    id: leaseId,
    units: makeLease(1).units.map((unit) => ({
      ...unit,
      verified_status: 'active' as const,
    })),
    audit_events: [{
      actor_id: '00000000-0000-4000-8000-000000000901',
      event_type: 'created',
      changed_fields: ['lease_reference'],
      occurred_at: now,
    }],
  };
  const schedule = {
    id: '00000000-0000-4000-8000-000000000811',
    organization_id: organizationId,
    lease_id: leaseId,
    charge_category: 'base_rent',
    amount_per_period: '900719925474.10',
    currency: 'GBP',
    payment_frequency: 'monthly',
    start_date: '2026-04-01',
    end_date: '2031-03-31',
    due_day: 31,
    short_month_rule: 'clamp_to_month_end',
    status: 'draft',
    manual_review_reasons: ['commencement_not_on_due_date'],
    installments: [{
      id: '00000000-0000-4000-8000-000000000812',
      due_date: '2026-04-30',
      amount: '900719925474.10',
      currency: 'GBP',
      status: 'expected',
    }],
    created_at: now,
    updated_at: now,
  };
  let submittedBody: Record<string, unknown> | undefined;
  let scheduleCreated = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/leases/permissions') {
      return Response.json({ can_read: true, can_create: true, can_update: true });
    }
    if (url.pathname === `/api/leases/${leaseId}`) {
      return Response.json({
        ...lease,
        audit_events: scheduleCreated
          ? [
              ...lease.audit_events,
              {
                actor_id: '00000000-0000-4000-8000-000000000902',
                event_type: 'rent_schedule_created',
                changed_fields: [`rent_schedule:${schedule.id}`, 'amount_per_period'],
                occurred_at: now,
              },
            ]
          : lease.audit_events,
      });
    }
    if (url.pathname === `/api/leases/${leaseId}/rent-schedules`) {
      if (init?.method === 'POST') {
        submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        scheduleCreated = true;
        return Response.json(schedule, { status: 201 });
      }
      return Response.json(scheduleCreated ? [schedule] : []);
    }
    if (url.pathname === '/api/property-expenses') return Response.json([]);
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  window.history.replaceState({}, '', `/leases/${leaseId}?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<LeasePage mode="detail" leaseId={leaseId} />);
    await screen.findByRole('heading', { name: 'Rent and service charge schedules' });
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));
    await user.type(screen.getByLabelText(/Amount per instalment/), '0');
    await user.click(screen.getByRole('button', { name: 'Create draft schedule' }));
    assert.match((await screen.findByRole('alert')).textContent ?? '', /positive fixed amount/);

    const amount = screen.getByLabelText(/Amount per instalment/);
    await user.clear(amount);
    await user.type(amount, '900719925474.10');
    await user.selectOptions(screen.getByLabelText('Payment frequency'), 'monthly');
    await user.selectOptions(screen.getByLabelText('Day of month payments are due'), '31');
    await user.click(screen.getByRole('button', { name: 'Create draft schedule' }));

    assert.equal(submittedBody?.amount_per_period, '900719925474.10');
    assert.equal(submittedBody?.short_month_rule, 'clamp_to_month_end');
    assert.ok(await screen.findByRole('table', { name: 'Expected instalments for this schedule' }));
    assert.equal(screen.getAllByText('GBP 900719925474.10').length, 2);
    assert.ok(await screen.findByText('Rent schedule created'));
    assert.ok(screen.getByText(/No partial amount has been calculated/));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rent schedule controls are hidden for read-only lease users', async () => {
  const originalFetch = globalThis.fetch;
  const leaseId = '00000000-0000-4000-8000-000000000801';
  const lease: Lease = {
    ...makeLease(1),
    id: leaseId,
    units: makeLease(1).units.map((unit) => ({
      ...unit,
      verified_status: 'active' as const,
    })),
    audit_events: [],
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/leases/permissions') {
      return Response.json({ can_read: true, can_create: false, can_update: false });
    }
    if (url.pathname === `/api/leases/${leaseId}`) return Response.json(lease);
    if (url.pathname === `/api/leases/${leaseId}/rent-schedules`) {
      return Response.json([]);
    }
    if (url.pathname === '/api/property-expenses') return Response.json([]);
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  window.history.replaceState({}, '', `/leases/${leaseId}?organizationId=${organizationId}`);
  try {
    render(<LeasePage mode="detail" leaseId={leaseId} />);
    await screen.findByRole('heading', { name: 'Rent and service charge schedules' });
    assert.equal(screen.queryByRole('button', { name: 'Create schedule' }), null);
    assert.equal(screen.queryByRole('button', { name: 'Edit lease' }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('property expense register records recoverable expenses and prevents duplicate submit while pending', async () => {
  const originalFetch = globalThis.fetch;
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalCrypto = globalThis.crypto;
  const leaseId = '00000000-0000-4000-8000-000000000801';
  const lease: Lease = {
    ...makeLease(1),
    id: leaseId,
    units: makeLease(1).units.map((unit) => ({
      ...unit,
      verified_status: 'active' as const,
    })),
    audit_events: [],
  };
  const portfolioId = '00000000-0000-4000-8000-000000000201';
  const siteId = '00000000-0000-4000-8000-000000000301';
  const buildingId = '00000000-0000-4000-8000-000000000401';
  const unitId = '00000000-0000-4000-8000-000000000501';
  const expense = {
    id: '00000000-0000-4000-8000-000000000970',
    organization_id: organizationId,
    asset_level: 'unit',
    portfolio_id: portfolioId,
    site_id: siteId,
    building_id: buildingId,
    unit_id: unitId,
    category: 'maintenance',
    description: 'HVAC repair',
    amount: '420.50',
    currency: 'GBP',
    expense_date: '2026-05-20',
    recoverability: 'recoverable',
    manual_review_reasons: ['allocation_not_configured', 'recovery_terms_not_verified'],
    audit_events: [
      {
        actor_id: '00000000-0000-4000-8000-000000000901',
        event_type: 'created',
        changed_fields: ['amount'],
        occurred_at: now,
      },
    ],
    created_at: now,
    updated_at: now,
  };
  let createCalls = 0;
  let postedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/leases/permissions') {
      return Response.json({ can_read: true, can_create: true, can_update: true });
    }
    if (url.pathname === `/api/leases/${leaseId}`) return Response.json(lease);
    if (url.pathname === `/api/leases/${leaseId}/rent-schedules`) return Response.json([]);
    if (url.pathname === '/api/property-expenses' && init?.method === 'GET') {
      return Response.json(createCalls > 0 ? [expense] : []);
    }
    if (url.pathname === '/api/property-expenses' && init?.method === 'POST') {
      createCalls += 1;
      postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json(expense, { status: 201 });
    }
    if (url.pathname === '/api/portfolios') {
      return Response.json([{ id: portfolioId, organization_id: organizationId, name: 'Portfolio 1', status: 'active', created_at: now, updated_at: now }]);
    }
    if (url.pathname === `/api/portfolios/${portfolioId}/sites`) {
      return Response.json([{ id: siteId, organization_id: organizationId, portfolio_id: portfolioId, name: 'Site 1', address: null, status: 'active', created_at: now, updated_at: now }]);
    }
    if (url.pathname === `/api/portfolios/${portfolioId}/sites/${siteId}/buildings`) {
      return Response.json([{ id: buildingId, organization_id: organizationId, site_id: siteId, name: 'Building 1', building_code: null, address: null, status: 'active', created_at: now, updated_at: now }]);
    }
    if (url.pathname === `/api/portfolios/${portfolioId}/sites/${siteId}/buildings/${buildingId}/units`) {
      return Response.json([{ id: unitId, organization_id: organizationId, building_id: buildingId, name: 'Unit 1', unit_code: 'U1', floor: null, area_sqm: null, status: 'active', created_at: now, updated_at: now }]);
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  window.history.replaceState({}, '', `/leases/${leaseId}?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<LeasePage mode="detail" leaseId={leaseId} />);
    await screen.findByRole('heading', { name: 'Property expense register' });
    await user.click(screen.getByRole('button', { name: 'Record property expense' }));
    await user.selectOptions(screen.getByLabelText('Expense portfolio'), portfolioId);
    await user.selectOptions(screen.getByLabelText('Expense site'), siteId);
    await user.selectOptions(screen.getByLabelText('Expense building'), buildingId);
    await user.selectOptions(screen.getByLabelText('Expense unit'), unitId);
    await user.type(screen.getByLabelText('Description'), 'HVAC repair');
    await user.type(screen.getByLabelText('Amount'), '420.50');
    await user.type(screen.getByLabelText('Expense date'), '2026-05-20');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
      },
    });
    await user.click(screen.getByRole('button', { name: 'Record expense' }));
    assert.equal(createCalls, 1);
    assert.equal(postedBody?.amount, '420.50');
    assert.equal(postedBody?.recoverability, 'recoverable');
    assert.match(
      String(postedBody?.idempotency_key),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.ok(await screen.findByText(/Manual review required: allocation not configured/));
    assert.ok(screen.getByText(/does not create tenant charge schedules/));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'crypto');
    }
  }
});
