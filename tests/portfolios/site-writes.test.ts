import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSite,
  fetchSiteWritePermissions,
  PortfoliosRequestError,
  updateSite,
  type Site,
} from '../../src/lib/portfolios/client';

const organizationId = '00000000-0000-4000-8000-000000000001';
const portfolioId = '00000000-0000-4000-8000-000000000101';
const siteId = '00000000-0000-4000-8000-000000000201';
const site: Site = {
  id: siteId,
  organization_id: organizationId,
  portfolio_id: portfolioId,
  name: 'North Grounds',
  address: 'Fictional Lane',
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};

test('creates and updates sites through same-origin BFF routes with editable fields only', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return Response.json(site, { status: options?.method === 'POST' ? 201 : 200 });
  };
  try {
    assert.deepEqual(
      await createSite(portfolioId, organizationId, {
        name: 'North Grounds',
        address: null,
        status: 'active',
      }),
      site,
    );
    assert.deepEqual(
      await updateSite(siteId, portfolioId, organizationId, {
        address: null,
      }),
      site,
    );
    assert.equal(
      calls[0].url,
      `/api/sites?organizationId=${organizationId}&portfolioId=${portfolioId}`,
    );
    assert.equal(calls[0].options?.method, 'POST');
    assert.equal(calls[0].options?.credentials, 'same-origin');
    assert.equal(calls[0].options?.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(calls[0].options?.body)), {
      name: 'North Grounds',
      address: null,
      status: 'active',
    });
    assert.equal(
      calls[1].url,
      `/api/sites/${siteId}?organizationId=${organizationId}&portfolioId=${portfolioId}`,
    );
    assert.deepEqual(JSON.parse(String(calls[1].options?.body)), {
      address: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects invalid site write inputs and mismatched Registry responses', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ ...site, portfolio_id: organizationId });
  };
  try {
    await assert.rejects(
      createSite(portfolioId, organizationId, {
        name: '  ',
        status: 'active',
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 400,
    );
    await assert.rejects(
      updateSite(siteId, portfolioId, organizationId, {
        name: 'x'.repeat(201),
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 400,
    );
    assert.equal(calls, 0);

    await assert.rejects(
      createSite(portfolioId, organizationId, {
        name: 'North Grounds',
        status: 'active',
      }),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates site write permission responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ can_create: true, can_update: false });
  try {
    assert.deepEqual(await fetchSiteWritePermissions(organizationId), {
      can_create: true,
      can_update: false,
    });
    globalThis.fetch = async () =>
      Response.json({ can_create: true, can_update: false, extra: true });
    await assert.rejects(
      fetchSiteWritePermissions(organizationId),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
