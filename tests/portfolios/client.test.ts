import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchPortfolios,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  type Portfolio,
} from '../../src/lib/portfolios/client';

const organizationId = '00000000-0000-4000-8000-000000000001';
const portfolio: Portfolio = {
  id: '00000000-0000-4000-8000-000000000101',
  organization_id: organizationId,
  name: 'Test portfolio',
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};

test('accepts only one valid organisation ID in the page URL', () => {
  assert.equal(
    parsePortfolioOrganizationId(`?organizationId=${organizationId}`),
    organizationId,
  );
  for (const query of [
    '',
    '?organizationId=not-a-uuid',
    `?organizationId=${organizationId}&organizationId=${organizationId}`,
    `?organizationId=${organizationId}&subject=private`,
  ]) {
    assert.equal(parsePortfolioOrganizationId(query), null);
  }
});

test('validates portfolio response fields and organisation ownership', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json([portfolio]);
    assert.deepEqual(await fetchPortfolios(organizationId), [portfolio]);

    for (const invalid of [
      [{ ...portfolio, private_field: 'secret' }],
      [{ ...portfolio, organization_id: '00000000-0000-4000-8000-000000000002' }],
      [{ ...portfolio, status: 'pending' }],
      [{ ...portfolio, updated_at: 'not-a-date' }],
      [portfolio, portfolio],
    ]) {
      globalThis.fetch = async () => Response.json(invalid);
      await assert.rejects(
        fetchPortfolios(organizationId),
        (error: unknown) =>
          error instanceof PortfoliosRequestError && error.status === 502,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requests only the same-origin portfolio BFF without caching', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  let options: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    options = init;
    return Response.json([portfolio]);
  };
  try {
    await fetchPortfolios(organizationId);
    assert.equal(url, `/api/portfolios?organizationId=${organizationId}`);
    assert.equal(options?.method, 'GET');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.redirect, 'error');
    assert.deepEqual([...new Headers(options?.headers).keys()], ['accept']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps expired sessions, forbidden access and service failures to safe messages', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, expectedStatus] of [
      [401, 401],
      [403, 403],
      [503, 503],
    ]) {
      globalThis.fetch = async () =>
        Response.json({ error: 'sensitive upstream detail' }, { status });
      await assert.rejects(
        fetchPortfolios(organizationId),
        (error: unknown) =>
          error instanceof PortfoliosRequestError &&
          error.status === expectedStatus &&
          !error.message.includes('sensitive upstream detail'),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
