import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBuilding,
  fetchBuildingWritePermissions,
  PortfoliosRequestError,
  updateBuilding,
  type Building,
} from '../../src/lib/portfolios/client';

const organizationId = '00000000-0000-4000-8000-000000000001';
const portfolioId = '00000000-0000-4000-8000-000000000101';
const siteId = '00000000-0000-4000-8000-000000000201';
const buildingId = '00000000-0000-4000-8000-000000000301';
const building: Building = {
  id: buildingId,
  organization_id: organizationId,
  site_id: siteId,
  name: 'North House',
  building_code: 'NH-1',
  address: 'Fictional Lane',
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};

test('creates and updates buildings through the same-origin BFF with editable fields only', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return Response.json(building, {
      status: options?.method === 'POST' ? 201 : 200,
    });
  };
  try {
    assert.deepEqual(
      await createBuilding(portfolioId, siteId, organizationId, {
        name: 'North House',
        building_code: 'NH-1',
        address: 'Fictional Lane',
        status: 'active',
      }),
      building,
    );
    assert.deepEqual(
      await updateBuilding(buildingId, portfolioId, siteId, organizationId, {
        address: null,
      }),
      building,
    );
    assert.equal(
      calls[0].url,
      `/api/buildings?organizationId=${organizationId}&portfolioId=${portfolioId}&siteId=${siteId}`,
    );
    assert.equal(calls[0].options?.method, 'POST');
    assert.equal(calls[0].options?.credentials, 'same-origin');
    assert.equal(calls[0].options?.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(calls[0].options?.body)), {
      name: 'North House',
      building_code: 'NH-1',
      address: 'Fictional Lane',
      status: 'active',
    });
    assert.equal(
      calls[1].url,
      `/api/buildings/${buildingId}?organizationId=${organizationId}&portfolioId=${portfolioId}&siteId=${siteId}`,
    );
    assert.deepEqual(JSON.parse(String(calls[1].options?.body)), {
      address: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates building fields and refuses mismatched Registry response parents', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ ...building, site_id: portfolioId });
  };
  try {
    await assert.rejects(
      createBuilding(portfolioId, siteId, organizationId, {
        name: '  ',
        status: 'active',
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 400,
    );
    await assert.rejects(
      updateBuilding(buildingId, portfolioId, siteId, organizationId, {
        building_code: 'x'.repeat(101),
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 400,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      createBuilding(portfolioId, siteId, organizationId, {
        name: 'North House',
        status: 'active',
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates building write permission response shape', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ can_create: true, can_update: false });
  try {
    assert.deepEqual(await fetchBuildingWritePermissions(organizationId), {
      can_create: true,
      can_update: false,
    });
    globalThis.fetch = async () =>
      Response.json({ can_create: true, can_update: false, extra: true });
    await assert.rejects(
      fetchBuildingWritePermissions(organizationId),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
