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
const now = 1_800_000_000_000;
const building = {
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

function makeResponse(
  status: number,
  payload?: unknown,
  headers: HeadersInit = { 'Content-Type': 'application/json' },
): Response {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers,
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
  const session = options.session === undefined
    ? {
        data: {
          accessToken,
          accessTokenExpiresAt: String(now + 60_000),
          subject: 'verified-subject',
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
      return options.response ?? makeResponse(201, building);
    },
    now: () => now,
  });
  const cookie = serializeSessionCookie(sessionId, 60).split(';', 1)[0];
  const request = (
    url: string,
    method: 'POST' | 'PATCH' = 'POST',
    body: unknown = { name: 'North House' },
    headers: HeadersInit = {},
  ) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Cookie', cookie);
    requestHeaders.set('Origin', 'https://app.example');
    requestHeaders.set('Sec-Fetch-Site', 'same-origin');
    requestHeaders.set('Content-Type', 'application/json');
    return new Request(url, {
      method,
      headers: requestHeaders,
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

const createUrl = `https://app.example/api/buildings?organizationId=${organizationId}&portfolioId=${portfolioId}&siteId=${siteId}`;
const updateUrl = `https://app.example/api/buildings/${buildingId}?organizationId=${organizationId}&portfolioId=${portfolioId}&siteId=${siteId}`;

test('creates buildings through the configured Registry with validated parent IDs', async () => {
  const context = setup();
  const response = await context.handlers.createBuilding(
    context.request(createUrl, 'POST', {
      name: ' North House ',
      building_code: ' NH-1 ',
      address: 'Fictional Lane',
      status: 'active',
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), building);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/buildings?organization_id=${organizationId}`,
  );
  const init = context.requestInit();
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'manual');
  assert.equal(init?.cache, 'no-store');
  assert.equal(
    new Headers(init?.headers).get('Authorization'),
    `Bearer ${accessToken}`,
  );
  assert.deepEqual(JSON.parse(String(init?.body)), {
    name: 'North House',
    building_code: 'NH-1',
    address: 'Fictional Lane',
    status: 'active',
    portfolio_id: portfolioId,
    site_id: siteId,
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('patches buildings with parent selectors and rejects malformed responses', async () => {
  const context = setup({ response: makeResponse(200, building) });
  const response = await context.handlers.updateBuilding(
    context.request(updateUrl, 'PATCH', { address: null }),
    buildingId,
  );
  assert.equal(response.status, 200);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/buildings/${buildingId}?organization_id=${organizationId}&portfolio_id=${portfolioId}&site_id=${siteId}`,
  );

  const invalid = setup({
    response: makeResponse(200, { ...building, site_id: portfolioId }),
  });
  const rejected = await invalid.handlers.updateBuilding(
    invalid.request(updateUrl, 'PATCH', { name: 'Updated' }),
    buildingId,
  );
  assert.equal(rejected.status, 502);
});

test('rejects unauthorized origin, query selectors and protected fields before upstream access', async () => {
  const foreignOrigin = setup();
  const request = foreignOrigin.request(createUrl);
  request.headers.set('Origin', 'https://attacker.example');
  assert.equal(
    (await foreignOrigin.handlers.createBuilding(request)).status,
    403,
  );
  assert.equal(foreignOrigin.calls(), 0);

  const malformed = setup();
  assert.equal(
    (
      await malformed.handlers.createBuilding(
        malformed.request(`${createUrl}&siteId=${siteId}`),
      )
    ).status,
    400,
  );
  assert.equal(malformed.calls(), 0);

  const protectedField = setup();
  assert.equal(
    (
      await protectedField.handlers.createBuilding(
        protectedField.request(createUrl, 'POST', {
          name: 'North House',
          organization_id: organizationId,
        }),
      )
    ).status,
    400,
  );
  assert.equal(protectedField.calls(), 0);
});

test('rejects expired sessions, redirects and upstream failures without leaking details', async () => {
  const expired = setup({
    session: { data: { accessToken, accessTokenExpiresAt: String(now) } },
  });
  assert.equal(
    (
      await expired.handlers.createBuilding(
        expired.request(createUrl),
      )
    ).status,
    401,
  );
  assert.equal(expired.calls(), 0);

  const redirect = setup({
    response: new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example/' },
    }),
  });
  assert.equal(
    (
      await redirect.handlers.createBuilding(
        redirect.request(createUrl),
      )
    ).status,
    503,
  );
  const unavailable = setup({
    fetchError: new Error('private upstream detail'),
  });
  const failed = await unavailable.handlers.createBuilding(
    unavailable.request(createUrl),
  );
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private upstream detail|signature/);
});
