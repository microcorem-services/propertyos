import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPortfolioHandlers,
  loadPropertyAssetRegistryConfiguration,
  type Building,
  type Portfolio,
  type Site,
  type Unit,
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
const site: Site = {
  id: '00000000-0000-4000-8000-000000000201',
  organization_id: organizationId,
  portfolio_id: portfolioId,
  name: 'North Grounds',
  address: 'Example Road',
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};
const building: Building = {
  id: '00000000-0000-4000-8000-000000000301',
  organization_id: organizationId,
  site_id: site.id,
  name: 'Main House',
  building_code: 'MH',
  address: null,
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};
const unit: Unit = {
  id: '00000000-0000-4000-8000-000000000401',
  organization_id: organizationId,
  building_id: building.id,
  name: 'Suite 4',
  unit_code: 'S4',
  floor: '4',
  area_sqm: '42.50',
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
    appOrigin: () => new URL('https://app.example'),
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
    init: RequestInit = {},
  ) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Cookie', cookie);
    return new Request(url, { ...init, headers: requestHeaders });
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
  assert.equal(
    new Headers(init?.headers).get('Authorization'),
    `Bearer ${accessToken}`,
  );
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

test('retrieves one portfolio using the authenticated organization-scoped Registry route', async () => {
  const context = setup({ response: makeResponse(200, portfolio) });
  const response = await context.handlers.getPortfolio(
    context.request(
      `https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}`,
    ),
    portfolioId,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), portfolio);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/portfolios/${portfolioId}?organization_id=${organizationId}`,
  );
  const init = context.requestInit();
  assert.equal(init?.method, 'GET');
  assert.equal(init?.cache, 'no-store');
  assert.equal(init?.redirect, 'manual');
  const authorization = new Headers(init?.headers).get('Authorization');
  assert.equal(authorization?.startsWith('Bearer '), true);
  assert.equal(authorization?.endsWith(accessToken), true);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('rejects invalid portfolio IDs and organization selectors before session access', async () => {
  for (const [url, portfolioIdValue] of [
    [`https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}`, 'invalid'],
    [`https://app.example/api/portfolios/${portfolioId}`, portfolioId],
    [`https://app.example/api/portfolios/${portfolioId}?organizationId=invalid`, portfolioId],
    [`https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}&extra=1`, portfolioId],
  ]) {
    const context = setup();
    const response = await context.handlers.getPortfolio(
      context.request(url),
      portfolioIdValue,
    );
    assert.equal(response.status, 400, url);
    assert.equal(context.retrieved.length, 0);
    assert.equal(context.calls(), 0);
  }
});

test('portfolio detail requires a live session and maps Registry access outcomes safely', async () => {
  const noCookie = setup();
  const unauthorized = await noCookie.handlers.getPortfolio(
    new Request(
      `https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}`,
    ),
    portfolioId,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(noCookie.calls(), 0);

  for (const [status, expected] of [
    [401, 401],
    [403, 403],
    [404, 404],
    [302, 503],
    [500, 503],
  ]) {
    const context = setup({
      response: makeResponse(status, {
        error: 'private Registry response and access token',
      }),
    });
    const response = await context.handlers.getPortfolio(
      context.request(
        `https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}`,
      ),
      portfolioId,
    );
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /private Registry response|access token/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('rejects portfolio detail responses with mismatched IDs or private fields', async () => {
  for (const payload of [
    { ...portfolio, id: '00000000-0000-4000-8000-000000000102' },
    { ...portfolio, organization_id: '00000000-0000-4000-8000-000000000002' },
    { ...portfolio, private_data: 'sensitive' },
  ]) {
    const context = setup({ response: makeResponse(200, payload) });
    const response = await context.handlers.getPortfolio(
      context.request(
        `https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}`,
      ),
      portfolioId,
    );
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /sensitive|subject|accessToken/);
  }
});

test('lists authorized sites through the Registry and allowlists the site contract', async () => {
  const context = setup({ response: makeResponse(200, [site]) });
  const response = await context.handlers.getSites(
    context.request(
      `https://app.example/api/portfolios/${portfolioId}/sites?organizationId=${organizationId}`,
    ),
    portfolioId,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [site]);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/portfolios/${portfolioId}/sites?organization_id=${organizationId}`,
  );
  assert.equal(context.requestInit()?.redirect, 'manual');
  assert.equal(context.requestInit()?.cache, 'no-store');
});

test('validates all hierarchy selectors and rejects unexpected query parameters', async () => {
  const invalid = setup();
  const response = await invalid.handlers.getUnits(
    invalid.request(
      `https://app.example/api/portfolios/${portfolioId}/sites/${site.id}/buildings/not-a-uuid/units?organizationId=${organizationId}`,
    ),
    portfolioId,
    site.id,
    'not-a-uuid',
  );
  assert.equal(response.status, 400);
  assert.equal(invalid.retrieved.length, 0);
  assert.equal(invalid.calls(), 0);

  const unexpectedQuery = setup();
  const rejected = await unexpectedQuery.handlers.getSite(
    unexpectedQuery.request(
      `https://app.example/api/portfolios/${portfolioId}/sites/${site.id}?organizationId=${organizationId}&extra=1`,
    ),
    portfolioId,
    site.id,
  );
  assert.equal(rejected.status, 400);
  assert.equal(unexpectedQuery.calls(), 0);
});

test('forwards live server session to parent-scoped building and unit endpoints', async () => {
  const buildingContext = setup({ response: makeResponse(200, [building]) });
  const buildingResponse = await buildingContext.handlers.getBuildings(
    buildingContext.request(
      `https://app.example/api/portfolios/${portfolioId}/sites/${site.id}/buildings?organizationId=${organizationId}`,
    ),
    portfolioId,
    site.id,
  );
  assert.equal(buildingResponse.status, 200);
  assert.deepEqual(await buildingResponse.json(), [building]);
  assert.equal(
    buildingContext.requestedUrl()?.pathname,
    `/api/v1/portfolios/${portfolioId}/sites/${site.id}/buildings`,
  );

  const unitContext = setup({ response: makeResponse(200, unit) });
  const unitResponse = await unitContext.handlers.getUnit(
    unitContext.request(
      `https://app.example/api/portfolios/${portfolioId}/sites/${site.id}/buildings/${building.id}/units/${unit.id}?organizationId=${organizationId}`,
    ),
    portfolioId,
    site.id,
    building.id,
    unit.id,
  );
  assert.equal(unitResponse.status, 200);
  assert.deepEqual(await unitResponse.json(), unit);
  assert.equal(
    unitContext.requestedUrl()?.pathname,
    `/api/v1/portfolios/${portfolioId}/sites/${site.id}/buildings/${building.id}/units/${unit.id}`,
  );
  const authorization = new Headers(unitContext.requestInit()?.headers).get('Authorization');
  assert.equal(authorization?.startsWith('Bearer '), true);
  assert.equal(authorization?.endsWith(accessToken), true);
});

test('rejects cross-parent and malformed hierarchy responses and sanitizes errors', async () => {
  for (const payload of [
    { ...site, portfolio_id: '00000000-0000-4000-8000-000000000099' },
    { ...site, organization_id: '00000000-0000-4000-8000-000000000099' },
    { ...site, private_field: 'customer data' },
  ]) {
    const context = setup({ response: makeResponse(200, [payload]) });
    const response = await context.handlers.getSites(
      context.request(
        `https://app.example/api/portfolios/${portfolioId}/sites?organizationId=${organizationId}`,
      ),
      portfolioId,
    );
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /customer data/);
  }

  for (const [status, expected] of [
    [401, 401],
    [403, 403],
    [404, 404],
    [302, 503],
    [500, 503],
  ]) {
    const context = setup({
      response: makeResponse(status, { error: 'internal token and customer data' }),
    });
    const response = await context.handlers.getBuilding(
      context.request(
        `https://app.example/api/portfolios/${portfolioId}/sites/${site.id}/buildings/${building.id}?organizationId=${organizationId}`,
      ),
      portfolioId,
      site.id,
      building.id,
    );
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /internal token|customer data/);
  }

  const expired = setup({
    session: {
      data: {
        accessToken,
        accessTokenExpiresAt: String(now),
      },
    },
  });
  const response = await expired.handlers.getSites(
    expired.request(
      `https://app.example/api/portfolios/${portfolioId}/sites?organizationId=${organizationId}`,
    ),
    portfolioId,
  );
  assert.equal(response.status, 401);
  assert.equal(expired.calls(), 0);
});

test('creates a portfolio through the fixed Registry destination with same-origin CSRF checks', async () => {
  const created = {
    ...portfolio,
    name: 'New estate',
  };
  const context = setup({ response: makeResponse(201, created) });
  const response = await context.handlers.createPortfolio(
    context.request(
      `https://app.example/api/portfolios?organizationId=${organizationId}`,
      {
        Origin: 'https://app.example',
        'Content-Type': 'application/json',
      },
      { method: 'POST', body: JSON.stringify({ name: '  New estate  ' }) },
    ),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), created);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/portfolios?organization_id=${organizationId}`,
  );
  assert.equal(context.requestInit()?.method, 'POST');
  assert.equal(context.requestInit()?.redirect, 'manual');
  assert.equal(context.requestInit()?.cache, 'no-store');
  assert.deepEqual(JSON.parse(String(context.requestInit()?.body)), {
    name: 'New estate',
  });
  assert.equal(
    new Headers(context.requestInit()?.headers).get('Authorization'),
    'Bearer ' + accessToken,
  );
});

test('updates only validated portfolio fields and verifies returned identity', async () => {
  const updated = { ...portfolio, name: 'Renamed estate' };
  const context = setup({ response: makeResponse(200, updated) });
  const response = await context.handlers.updatePortfolio(
    context.request(
      `https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}`,
      {
        Origin: 'https://app.example',
        'Content-Type': 'application/json',
      },
      { method: 'PATCH', body: JSON.stringify({ name: 'Renamed estate' }) },
    ),
    portfolioId,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), updated);
  assert.equal(context.requestInit()?.method, 'PATCH');
  assert.equal(context.requestInit()?.redirect, 'manual');
  assert.equal(context.requestInit()?.cache, 'no-store');
});

test('write requests reject cross-origin, absent-Origin, and unexpected body fields', async () => {
  for (const [headers, body] of [
    [
      { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      { name: 'Estate' },
    ],
    [
      { 'Content-Type': 'application/json' },
      { name: 'Estate' },
    ],
    [
      { Origin: 'https://app.example', 'Content-Type': 'application/json' },
      { name: 'Estate', organization_id: organizationId },
    ],
    [
      { Origin: 'https://app.example', 'Content-Type': 'application/json' },
      { name: '   ' },
    ],
  ] as Array<[HeadersInit, Record<string, unknown>]>) {
    const context = setup();
    const expectedStatus =
      new Headers(headers).get('origin') === 'https://app.example' ? 400 : 403;
    const response = await context.handlers.createPortfolio(
      context.request(
        `https://app.example/api/portfolios?organizationId=${organizationId}`,
        headers,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    );
    assert.equal(response.status, expectedStatus);
    assert.equal(context.calls(), 0);
    assert.equal(context.retrieved.length, 0);
  }
});

test('write endpoints fail closed for invalid IDs, duplicate selectors and expired sessions', async () => {
  const invalidId = setup();
  const invalid = await invalidId.handlers.updatePortfolio(
    invalidId.request(
      `https://app.example/api/portfolios/not-a-uuid?organizationId=${organizationId}`,
      {
        Origin: 'https://app.example',
        'Content-Type': 'application/json',
      },
      { method: 'PATCH', body: JSON.stringify({ name: 'Rename' }) },
    ),
    'not-a-uuid',
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalidId.retrieved.length, 0);

  const duplicateSelector = setup();
  const duplicate = await duplicateSelector.handlers.createPortfolio(
    duplicateSelector.request(
      `https://app.example/api/portfolios?organizationId=${organizationId}&organizationId=${organizationId}`,
      {
        Origin: 'https://app.example',
        'Content-Type': 'application/json',
      },
      { method: 'POST', body: JSON.stringify({ name: 'Estate' }) },
    ),
  );
  assert.equal(duplicate.status, 400);
  assert.equal(duplicateSelector.retrieved.length, 0);

  const expired = setup({
    session: {
      data: {
        accessToken,
        accessTokenExpiresAt: String(now),
      },
    },
  });
  const response = await expired.handlers.createPortfolio(
    expired.request(
      `https://app.example/api/portfolios?organizationId=${organizationId}`,
      {
        Origin: 'https://app.example',
        'Content-Type': 'application/json',
      },
      { method: 'POST', body: JSON.stringify({ name: 'Estate' }) },
    ),
  );
  assert.equal(response.status, 401);
  assert.equal(expired.calls(), 0);
});

test('write responses sanitize authorization failures, redirects, service errors, and malformed payloads', async () => {
  for (const [status, expected] of [
    [401, 401],
    [403, 403],
    [404, 404],
    [302, 503],
    [500, 503],
  ]) {
    const context = setup({
      response: makeResponse(status, { error: 'fictional secret and token' }),
    });
    const response = await context.handlers.updatePortfolio(
      context.request(
        `https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}`,
        {
          Origin: 'https://app.example',
          'Content-Type': 'application/json',
        },
        { method: 'PATCH', body: JSON.stringify({ name: 'Rename' }) },
      ),
      portfolioId,
    );
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /fictional secret|token/);
  }

  const malformed = setup({
    response: makeResponse(200, { ...portfolio, organization_id: 'wrong' }),
  });
  const response = await malformed.handlers.updatePortfolio(
    malformed.request(
      `https://app.example/api/portfolios/${portfolioId}?organizationId=${organizationId}`,
      {
        Origin: 'https://app.example',
        'Content-Type': 'application/json',
      },
      { method: 'PATCH', body: JSON.stringify({ status: 'inactive' }) },
    ),
    portfolioId,
  );
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /fictional/);
});

test('write permissions are allowlisted and never cached', async () => {
  const permissions = { can_create: false, can_update: true };
  const context = setup({ response: makeResponse(200, permissions) });
  const response = await context.handlers.getPortfolioWritePermissions(
    context.request(
      `https://app.example/api/portfolio-write-permissions?organizationId=${organizationId}`,
    ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), permissions);
  assert.equal(
    context.requestedUrl()?.href,
    `https://property-assets.example.test/api/v1/portfolio-write-permissions?organization_id=${organizationId}`,
  );
  assert.equal(context.requestInit()?.redirect, 'manual');
  assert.equal(context.requestInit()?.cache, 'no-store');

  const malformed = setup({
    response: makeResponse(200, { ...permissions, role: 'admin' }),
  });
  const invalid = await malformed.handlers.getPortfolioWritePermissions(
    malformed.request(
      `https://app.example/api/portfolio-write-permissions?organizationId=${organizationId}`,
    ),
  );
  assert.equal(invalid.status, 502);
});
