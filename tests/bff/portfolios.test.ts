import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPortfolioHandlers,
  loadPropertyAssetRegistryConfiguration,
  type Portfolio,
} from '../../src/lib/auth/portfolio-handlers';
import { serializeSessionCookie } from '../../src/lib/auth/session';

const sessionId = 's'.repeat(43);
const accessToken = 'header.payload.signature';
const registryUrl = new URL('https://property-assets.example.test/');
const organizationId = '00000000-0000-4000-8000-000000000001';
const portfolioId = '00000000-0000-4000-8000-000000000101';
const now = 1_800_000_000_000;

const portfolio: Portfolio = {
  id: portfolioId,
  organization_id: organizationId,
  name: 'North Estate',
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
  sessionError?: Error;
  response?: Response;
  fetchError?: Error;
  configurationError?: Error;
} = {}) {
  let calls = 0;
  let requestedUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const retrieved: string[] = [];
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
    configuration: () => {
      if (options.configurationError) throw options.configurationError;
      return { baseUrl: registryUrl, timeoutMs: 2_500 };
    },
    sessions: () => ({
      retrieve: async (id) => {
        retrieved.push(id);
        if (options.sessionError) throw options.sessionError;
        return session;
      },
    }),
    fetch: async (input, init) => {
      calls += 1;
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
      requestInit = init;
      if (options.fetchError) throw options.fetchError;
      return options.response ?? makeResponse(200, [portfolio]);
    },
    now: () => now,
  });

  const cookie = serializeSessionCookie(sessionId, 60).split(';', 1)[0];
  const request = (
    url = `https://app.example/api/portfolios?organizationId=${organizationId}`,
    headers: HeadersInit = {},
  ) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Cookie', cookie);
    return new Request(url, { headers: requestHeaders });
  };

  return {
    handlers,
    request,
    calls: () => calls,
    requestedUrl: () => requestedUrl,
    requestInit: () => requestInit,
    retrieved,
  };
}

test('lists only allowlisted portfolios after forwarding the server session token', async () => {
  const context = setup();
  const response = await context.handlers.getPortfolios(
    context.request(
      `https://app.example/api/portfolios?organizationId=${organizationId}`,
      {
        Authorization: 'Bearer browser-controlled-token',
        'X-Internal-Service': 'browser-controlled-value',
      },
    ),
  );

  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.deepEqual(responseBody, [portfolio]);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/portfolios?organization_id=${organizationId}`,
  );
  const init = context.requestInit();
  assert.equal(init?.method, 'GET');
  assert.equal(init?.cache, 'no-store');
  assert.equal(init?.redirect, 'manual');
  assert.equal((init?.signal as AbortSignal).aborted, false);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${accessToken}`);
  assert.equal(headers.get('Accept'), 'application/json');
  assert.deepEqual([...headers.keys()].sort(), ['accept', 'authorization']);
  assert.notEqual(headers.get('Authorization'), 'Bearer browser-controlled-token');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.doesNotMatch(JSON.stringify(responseBody), /subject|accessToken|signature|property-assets\.example/);
});

test('rejects missing, malformed, unavailable and expired sessions before upstream access', async () => {
  const missingCookie = setup();
  const unauthenticated = await missingCookie.handlers.getPortfolios(
    new Request(`https://app.example/api/portfolios?organizationId=${organizationId}`),
  );
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: 'Authentication required.' });
  assert.equal(missingCookie.calls(), 0);

  const malformedCookie = await missingCookie.handlers.getPortfolios(
    new Request(`https://app.example/api/portfolios?organizationId=${organizationId}`, {
      headers: { Cookie: `propertyos_session=${'x'.repeat(42)}` },
    }),
  );
  assert.equal(malformedCookie.status, 401);
  assert.equal(missingCookie.calls(), 0);

  const missingSession = setup({ session: null });
  const missing = await missingSession.handlers.getPortfolios(
    missingSession.request(),
  );
  assert.equal(missing.status, 401);
  assert.deepEqual(missingSession.retrieved, [sessionId]);

  for (const data of [
    { accessToken: 'not-a-jwt', accessTokenExpiresAt: String(now + 1_000) },
    { accessToken, accessTokenExpiresAt: String(now) },
    { accessToken, accessTokenExpiresAt: 'not-a-time' },
  ]) {
    const expired = setup({ session: { data } });
    const response = await expired.handlers.getPortfolios(expired.request());
    assert.equal(response.status, 401);
    assert.equal(expired.calls(), 0);
  }
});

test('rejects invalid, duplicate and unexpected query parameters before session access', async () => {
  for (const query of [
    '',
    '?organizationId=not-a-uuid',
    `?organizationId=${organizationId}&organizationId=${organizationId}`,
    `?organizationId=${organizationId}&organization_id=${organizationId}`,
    `?organizationId=${organizationId}&subject=another-user`,
  ]) {
    const context = setup();
    const response = await context.handlers.getPortfolios(
      context.request(`https://app.example/api/portfolios${query}`),
    );
    assert.equal(response.status, 400, query);
    assert.equal(context.retrieved.length, 0, query);
    assert.equal(context.calls(), 0, query);
  }
});

test('maps upstream authentication, authorisation, redirects and failures safely', async () => {
  for (const [status, expected] of [
    [401, 401],
    [403, 403],
    [302, 503],
    [500, 503],
  ]) {
    const context = setup({
      response: makeResponse(status, {
        error: 'internal service detail and access token',
      }),
    });
    const response = await context.handlers.getPortfolios(context.request());
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /internal service detail|access token/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  const networkFailure = setup({ fetchError: new Error('sensitive internal detail') });
  const networkResponse = await networkFailure.handlers.getPortfolios(
    networkFailure.request(),
  );
  assert.equal(networkResponse.status, 503);
  assert.doesNotMatch(await networkResponse.text(), /sensitive internal detail/);

  const configurationFailure = setup({
    configurationError: new Error('private registry URL'),
  });
  const configResponse = await configurationFailure.handlers.getPortfolios(
    configurationFailure.request(),
  );
  assert.equal(configResponse.status, 503);
  assert.equal(configurationFailure.calls(), 0);
  assert.doesNotMatch(await configResponse.text(), /private registry URL/);
});

test('rejects malformed, unexpected, oversized and cross-organization responses', async () => {
  const malformed = [
    [{ ...portfolio, internal_id: 'private' }],
    [{ ...portfolio, id: 'not-a-uuid' }],
    [{ ...portfolio, organization_id: '00000000-0000-4000-8000-000000000002' }],
    [{ ...portfolio, name: '' }],
    [{ ...portfolio, status: 'pending' }],
    [{ ...portfolio, created_at: 'not-a-date' }],
    [{ ...portfolio, created_at: '2026-02-30T03:04:05Z' }],
    [portfolio, portfolio],
    { portfolios: [portfolio] },
    Array.from({ length: 1_001 }, (_, index) => ({
      ...portfolio,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    })),
  ];

  for (const payload of malformed) {
    const context = setup({ response: makeResponse(200, payload) });
    const response = await context.handlers.getPortfolios(context.request());
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /private|subject|accessToken/);
  }

  const nonJson = setup({
    response: makeResponse(200, 'private registry response', {
      'Content-Type': 'text/plain',
    }),
  });
  const nonJsonResponse = await nonJson.handlers.getPortfolios(nonJson.request());
  assert.equal(nonJsonResponse.status, 502);

  const oversized = setup({
    response: new Response('[]', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(2 * 1024 * 1024),
      },
    }),
  });
  const oversizedResponse = await oversized.handlers.getPortfolios(
    oversized.request(),
  );
  assert.equal(oversizedResponse.status, 502);
});

test('validates private Registry URL and bounded timeout configuration', () => {
  const names = [
    'PROPERTY_ASSET_REGISTRY_URL',
    'PROPERTY_ASSET_REGISTRY_ALLOW_INSECURE_LOCAL_HTTP',
    'PROPERTY_ASSET_REGISTRY_TIMEOUT_MS',
    'NODE_ENV',
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  const set = (name: typeof names[number], value: string | undefined) => {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else Reflect.set(process.env, name, value);
  };

  try {
    set('NODE_ENV', 'test');
    set('PROPERTY_ASSET_REGISTRY_URL', 'https://property-assets.example.test');
    set('PROPERTY_ASSET_REGISTRY_ALLOW_INSECURE_LOCAL_HTTP', undefined);
    set('PROPERTY_ASSET_REGISTRY_TIMEOUT_MS', undefined);
    assert.deepEqual(loadPropertyAssetRegistryConfiguration(), {
      baseUrl: new URL('https://property-assets.example.test/'),
      timeoutMs: 3_000,
    });

    for (const url of [
      '',
      'http://property-assets.example.test',
      'https://user:password@property-assets.example.test',
      'https://property-assets.example.test/private',
      'https://property-assets.example.test?query=1',
    ]) {
      set('PROPERTY_ASSET_REGISTRY_URL', url);
      assert.throws(loadPropertyAssetRegistryConfiguration);
    }

    set('PROPERTY_ASSET_REGISTRY_URL', 'http://127.0.0.1:8102');
    set('PROPERTY_ASSET_REGISTRY_ALLOW_INSECURE_LOCAL_HTTP', 'true');
    assert.equal(
      loadPropertyAssetRegistryConfiguration().baseUrl.protocol,
      'http:',
    );
    set('NODE_ENV', 'production');
    assert.throws(loadPropertyAssetRegistryConfiguration);

    set('NODE_ENV', 'test');
    set('PROPERTY_ASSET_REGISTRY_URL', 'https://property-assets.example.test');
    set('PROPERTY_ASSET_REGISTRY_TIMEOUT_MS', '10001');
    assert.throws(loadPropertyAssetRegistryConfiguration);
  } finally {
    for (const [name, value] of original) set(name, value);
  }
});
