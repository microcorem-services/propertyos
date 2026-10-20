import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPortfolioHandlers } from '../../src/lib/auth/portfolio-handlers';
import { serializeSessionCookie } from '../../src/lib/auth/session';

const sessionId = 's'.repeat(43);
const accessToken = 'header.payload.signature';
const registryUrl = new URL('https://property-assets.example.test/');
const organizationId = '00000000-0000-4000-8000-000000000001';
const portfolioId = '00000000-0000-4000-8000-000000000101';
const siteId = '00000000-0000-4000-8000-000000000201';
const buildingId = '00000000-0000-4000-8000-000000000301';
const unitId = '00000000-0000-4000-8000-000000000401';
const now = 1_800_000_000_000;
const unit = {
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

function makeResponse(status: number, payload?: unknown): Response {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(options: {
  session?: { data: Record<string, string> } | null;
  response?: Response;
  fetchError?: Error;
} = {}) {
  let calls = 0;
  let requestedUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const session =
    options.session === undefined
      ? {
          data: {
            accessToken,
            accessTokenExpiresAt: String(now + 60_000),
          },
        }
      : options.session;
  const handlers = createPortfolioHandlers({
    configuration: () => ({ baseUrl: registryUrl, timeoutMs: 2_500 }),
    appOrigin: () => new URL('https://app.example'),
    sessions: () => ({ retrieve: async () => session }),
    fetch: async (input, init) => {
      calls += 1;
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
      requestInit = init;
      if (options.fetchError) throw options.fetchError;
      return options.response ?? makeResponse(201, unit);
    },
    now: () => now,
  });
  const cookie = serializeSessionCookie(sessionId, 60).split(';', 1)[0];
  const request = (
    url: string,
    method: 'POST' | 'PATCH' = 'POST',
    body: unknown = { name: 'Suite 4' },
  ) => {
    const headers = new Headers({
      Cookie: cookie,
      Origin: 'https://app.example',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
    });
    return new Request(url, {
      method,
      headers,
      body: JSON.stringify(body),
    });
  };
  return {
    handlers,
    request,
    calls: () => calls,
    requestedUrl: () => requestedUrl,
    requestInit: () => requestInit,
  };
}

const query = `organizationId=${organizationId}&portfolioId=${portfolioId}&siteId=${siteId}&buildingId=${buildingId}`;
const collectionUrl = `https://app.example/api/portfolios/${portfolioId}/sites/${siteId}/buildings/${buildingId}/units?${query}`;
const detailUrl = `https://app.example/api/portfolios/${portfolioId}/sites/${siteId}/buildings/${buildingId}/units/${unitId}?${query}`;

test('creates units through the configured Registry and validates the parent hierarchy', async () => {
  const context = setup();
  const response = await context.handlers.createUnit(
    context.request(collectionUrl, 'POST', {
      name: ' Suite 4 ',
      unit_code: ' S-4 ',
      floor: '4',
      area_sqm: '75.50',
      status: 'active',
    }),
    portfolioId,
    siteId,
    buildingId,
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), unit);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/units?organization_id=${organizationId}`,
  );
  assert.deepEqual(JSON.parse(String(context.requestInit()?.body)), {
    name: 'Suite 4',
    unit_code: 'S-4',
    floor: '4',
    area_sqm: '75.50',
    status: 'active',
    portfolio_id: portfolioId,
    site_id: siteId,
    building_id: buildingId,
  });
  assert.equal(context.requestInit()?.redirect, 'manual');
  assert.equal(context.requestInit()?.cache, 'no-store');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('updates units with all parent selectors and validates Registry responses', async () => {
  const context = setup({ response: makeResponse(200, unit) });
  const response = await context.handlers.updateUnit(
    context.request(detailUrl, 'PATCH', { area_sqm: null }),
    portfolioId,
    siteId,
    buildingId,
    unitId,
  );
  assert.equal(response.status, 200);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/units/${unitId}?organization_id=${organizationId}&portfolio_id=${portfolioId}&site_id=${siteId}&building_id=${buildingId}`,
  );
  const malformed = setup({
    response: makeResponse(200, { ...unit, building_id: siteId }),
  });
  assert.equal(
    (
      await malformed.handlers.updateUnit(
        malformed.request(detailUrl, 'PATCH', { name: 'Updated' }),
        portfolioId,
        siteId,
        buildingId,
        unitId,
      )
    ).status,
    502,
  );
});

test('rejects cross-site selectors, protected fields, invalid area, and foreign Origin', async () => {
  const mismatch = setup();
  assert.equal(
    (
      await mismatch.handlers.createUnit(
        mismatch.request(collectionUrl),
        portfolioId,
        siteId,
        buildingId + 'x',
      )
    ).status,
    400,
  );
  assert.equal(mismatch.calls(), 0);

  const protectedField = setup();
  assert.equal(
    (
      await protectedField.handlers.createUnit(
        protectedField.request(collectionUrl, 'POST', {
          name: 'Suite 4',
          organization_id: organizationId,
        }),
        portfolioId,
        siteId,
        buildingId,
      )
    ).status,
    400,
  );
  const invalidArea = setup();
  assert.equal(
    (
      await invalidArea.handlers.createUnit(
        invalidArea.request(collectionUrl, 'POST', {
          name: 'Suite 4',
          area_sqm: '0',
        }),
        portfolioId,
        siteId,
        buildingId,
      )
    ).status,
    400,
  );
  const foreignOrigin = setup();
  const request = foreignOrigin.request(collectionUrl);
  request.headers.set('Origin', 'https://attacker.example');
  assert.equal(
    (
      await foreignOrigin.handlers.createUnit(
        request,
        portfolioId,
        siteId,
        buildingId,
      )
    ).status,
    403,
  );
  assert.equal(foreignOrigin.calls(), 0);
});

test('expired sessions, upstream redirects, and errors fail closed', async () => {
  const expired = setup({
    session: { data: { accessToken, accessTokenExpiresAt: String(now) } },
  });
  assert.equal(
    (
      await expired.handlers.createUnit(
        expired.request(collectionUrl),
        portfolioId,
        siteId,
        buildingId,
      )
    ).status,
    401,
  );
  const redirect = setup({
    response: new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example/' },
    }),
  });
  assert.equal(
    (
      await redirect.handlers.createUnit(
        redirect.request(collectionUrl),
        portfolioId,
        siteId,
        buildingId,
      )
    ).status,
    503,
  );
  const unavailable = setup({ fetchError: new Error('private upstream details') });
  const result = await unavailable.handlers.createUnit(
    unavailable.request(collectionUrl),
    portfolioId,
    siteId,
    buildingId,
  );
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /private upstream details|signature/);
});

test('retrieves unit write permissions with the server-held session and no-store response', async () => {
  const context = setup({
    response: makeResponse(200, { can_create: true, can_update: false }),
  });
  const response = await context.handlers.getUnitWritePermissions(
    new Request(
      `https://app.example/api/unit-write-permissions?organizationId=${organizationId}`,
      {
        headers: {
          Cookie: serializeSessionCookie(sessionId, 60).split(';', 1)[0],
        },
      },
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    can_create: true,
    can_update: false,
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    new Headers(context.requestInit()?.headers).get('Authorization'),
    `Bearer ${accessToken}`,
  );
});
