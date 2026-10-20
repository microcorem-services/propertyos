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
const now = 1_800_000_000_000;
const site = {
  id: siteId,
  organization_id: organizationId,
  portfolio_id: portfolioId,
  name: 'North Grounds',
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
    sessions: () => ({
      retrieve: async () => session,
    }),
    fetch: async (input, init) => {
      calls += 1;
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
      requestInit = init;
      if (options.fetchError) throw options.fetchError;
      return options.response ?? makeResponse(201, site);
    },
    now: () => now,
  });
  const cookie = serializeSessionCookie(sessionId, 60).split(';', 1)[0];
  const request = (
    url: string,
    method: 'POST' | 'PATCH' = 'POST',
    body: unknown = { name: 'North Grounds' },
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

test('creates a site through the configured Registry with parent and no-store protections', async () => {
  const context = setup();
  const response = await context.handlers.createSite(
    context.request(
      `https://app.example/api/sites?organizationId=${organizationId}&portfolioId=${portfolioId}`,
      'POST',
      { name: 'North Grounds', address: 'Fictional Lane', status: 'active' },
    ),
  );

  assert.equal(response.status, 201);
  const responseBody = await response.json();
  assert.deepEqual(responseBody, site);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/sites?organization_id=${organizationId}`,
  );
  const init = context.requestInit();
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'manual');
  assert.equal(init?.cache, 'no-store');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${accessToken}`);
  assert.deepEqual(JSON.parse(String(init?.body)), {
    name: 'North Grounds',
    address: 'Fictional Lane',
    status: 'active',
    portfolio_id: portfolioId,
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(responseBody), /accessToken|signature/);
});

test('updates only editable fields and verifies the Registry parent and site IDs', async () => {
  const context = setup({ response: makeResponse(200, site) });
  const response = await context.handlers.updateSite(
    context.request(
      `https://app.example/api/sites/${siteId}?organizationId=${organizationId}&portfolioId=${portfolioId}`,
      'PATCH',
      { address: null },
    ),
    siteId,
  );

  assert.equal(response.status, 200);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/sites/${siteId}?organization_id=${organizationId}`,
  );
  assert.deepEqual(JSON.parse(String(context.requestInit()?.body)), {
    address: null,
  });

  const mismatchedResponse = setup({
    response: makeResponse(200, { ...site, portfolio_id: organizationId }),
  });
  const rejected = await mismatchedResponse.handlers.updateSite(
    mismatchedResponse.request(
      `https://app.example/api/sites/${siteId}?organizationId=${organizationId}&portfolioId=${portfolioId}`,
      'PATCH',
      { name: 'Attempted change' },
    ),
    siteId,
  );
  assert.equal(rejected.status, 502);
});

test('rejects malformed query, protected fields and foreign origins before upstream access', async () => {
  const invalidQuery = setup();
  const invalid = await invalidQuery.handlers.createSite(
    invalidQuery.request(
      `https://app.example/api/sites?organizationId=${organizationId}&portfolioId=not-a-uuid`,
    ),
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalidQuery.calls(), 0);

  const protectedField = setup();
  const rejectedField = await protectedField.handlers.createSite(
    protectedField.request(
      `https://app.example/api/sites?organizationId=${organizationId}&portfolioId=${portfolioId}`,
      'POST',
      { name: 'North Grounds', organization_id: organizationId },
    ),
  );
  assert.equal(rejectedField.status, 400);
  assert.equal(protectedField.calls(), 0);

  const foreignOrigin = setup();
  const request = foreignOrigin.request(
    `https://app.example/api/sites?organizationId=${organizationId}&portfolioId=${portfolioId}`,
  );
  request.headers.set('Origin', 'https://attacker.example');
  const denied = await foreignOrigin.handlers.createSite(request);
  assert.equal(denied.status, 403);
  assert.equal(foreignOrigin.calls(), 0);
});

test('rejects expired sessions, upstream redirects and sanitized upstream errors', async () => {
  const expired = setup({
    session: { data: { accessToken, accessTokenExpiresAt: String(now) } },
  });
  const authResponse = await expired.handlers.createSite(
    expired.request(
      `https://app.example/api/sites?organizationId=${organizationId}&portfolioId=${portfolioId}`,
    ),
  );
  assert.equal(authResponse.status, 401);
  assert.equal(expired.calls(), 0);

  const redirect = setup({
    response: new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example/' },
    }),
  });
  const redirected = await redirect.handlers.createSite(
    redirect.request(
      `https://app.example/api/sites?organizationId=${organizationId}&portfolioId=${portfolioId}`,
    ),
  );
  assert.equal(redirected.status, 503);
  assert.equal((await redirected.json()).error, 'Property service unavailable.');

  const unavailable = setup({ fetchError: new Error('private upstream detail') });
  const failed = await unavailable.handlers.createSite(
    unavailable.request(
      `https://app.example/api/sites?organizationId=${organizationId}&portfolioId=${portfolioId}`,
    ),
  );
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private upstream detail|signature/);
});

test('returns site write permissions only from a strictly validated response', async () => {
  const context = setup({
    response: makeResponse(200, { can_create: true, can_update: false }),
  });
  const response = await context.handlers.getSiteWritePermissions(
    new Request(
      `https://app.example/api/site-write-permissions?organizationId=${organizationId}`,
      {
        headers: {
          Cookie: serializeSessionCookie(sessionId, 60).split(';', 1)[0],
        },
      },
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { can_create: true, can_update: false });
  assert.equal(
    context.requestedUrl()?.pathname,
    '/api/v1/site-write-permissions',
  );
});
