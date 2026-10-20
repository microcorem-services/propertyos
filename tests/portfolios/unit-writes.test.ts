import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createUnit,
  fetchUnitWritePermissions,
  PortfoliosRequestError,
  updateUnit,
  type Unit,
} from '../../src/lib/portfolios/client';

const organizationId = '00000000-0000-4000-8000-000000000001';
const portfolioId = '00000000-0000-4000-8000-000000000101';
const siteId = '00000000-0000-4000-8000-000000000201';
const buildingId = '00000000-0000-4000-8000-000000000301';
const unitId = '00000000-0000-4000-8000-000000000401';
const unit: Unit = {
  id: unitId,
  organization_id: organizationId,
  building_id: buildingId,
  name: 'Suite 4',
  unit_code: 'S-4',
  floor: '4',
  area_sqm: '75.50',
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};

test('creates and updates units through the same-origin BFF with only editable fields', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return Response.json(unit, { status: options?.method === 'POST' ? 201 : 200 });
  };
  try {
    assert.deepEqual(
      await createUnit(portfolioId, siteId, buildingId, organizationId, {
        name: 'Suite 4',
        unit_code: 'S-4',
        floor: '4',
        area_sqm: '75.50',
        status: 'active',
      }),
      unit,
    );
    assert.deepEqual(
      await updateUnit(
        unitId,
        portfolioId,
        siteId,
        buildingId,
        organizationId,
        { area_sqm: null },
      ),
      unit,
    );
    assert.equal(
      calls[0].url,
      `/api/portfolios/${portfolioId}/sites/${siteId}/buildings/${buildingId}/units?organizationId=${organizationId}&portfolioId=${portfolioId}&siteId=${siteId}&buildingId=${buildingId}`,
    );
    assert.equal(calls[0].options?.method, 'POST');
    assert.equal(calls[0].options?.credentials, 'same-origin');
    assert.equal(calls[0].options?.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(calls[0].options?.body)), {
      name: 'Suite 4',
      unit_code: 'S-4',
      floor: '4',
      area_sqm: '75.50',
      status: 'active',
    });
    assert.equal(
      calls[1].url,
      `/api/portfolios/${portfolioId}/sites/${siteId}/buildings/${buildingId}/units/${unitId}?organizationId=${organizationId}&portfolioId=${portfolioId}&siteId=${siteId}&buildingId=${buildingId}`,
    );
    assert.deepEqual(JSON.parse(String(calls[1].options?.body)), {
      area_sqm: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects invalid fields and mismatched parent responses before accepting data', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ ...unit, building_id: siteId }, { status: 201 });
  };
  try {
    await assert.rejects(
      createUnit(portfolioId, siteId, buildingId, organizationId, {
        name: ' ',
        status: 'active',
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 400,
    );
    await assert.rejects(
      updateUnit(unitId, portfolioId, siteId, buildingId, organizationId, {
        area_sqm: '0.001',
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 400,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      createUnit(portfolioId, siteId, buildingId, organizationId, {
        name: 'Suite 4',
        status: 'active',
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates unit write permission response shape', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ can_create: true, can_update: false });
  try {
    assert.deepEqual(await fetchUnitWritePermissions(organizationId), {
      can_create: true,
      can_update: false,
    });
    globalThis.fetch = async () =>
      Response.json({ can_create: true, can_update: false, extra: true });
    await assert.rejects(
      fetchUnitWritePermissions(organizationId),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
