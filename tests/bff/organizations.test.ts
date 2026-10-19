import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOrganizationHandlers,
  loadOrganizationAccessConfiguration,
  type OrganizationsPage,
} from '../../src/lib/auth/organization-handlers';
import { serializeSessionCookie } from '../../src/lib/auth/session';

const sessionId = 's'.repeat(43);
const accessToken = 'header.payload.signature';
const serviceUrl = new URL('https://organization-access.example.test/');
const now = 1_800_000_000_000;
const orgA = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Alpha Organization',
};
const orgB = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Beta Organization',
};

type SessionResult = {
  data: Record<string, string>;
};

function makePage(
  organizations: OrganizationsPage['organizations'] = [orgA],
  next_cursor: string | null = null,
): OrganizationsPage {
  return { organizations, next_cursor };
}

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
  session?: SessionResult | null;
  sessionError?: Error;
  response?: Response;
  fetchError?: Error;
  configurationError?: Error;
  fetcher?: typeof fetch;
} = {}) {
  const retrieved: string[] = [];
  let calls = 0;
  let requestedUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const sessionResult = options.session === undefined
    ? {
        data: {
          accessToken,
          accessTokenExpiresAt: String(now + 60_000),
          subject: 'verified-subject',
        },
      }
    : options.session;

  const fetcher: typeof fetch = options.fetcher ?? (async (input, init) => {
    calls += 1;
    requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
    requestInit = init;
    if (options.fetchError) throw options.fetchError;
    return options.response ?? makeResponse(200, makePage());
  });
  const handlers = createOrganizationHandlers({
    configuration: () => {
      if (options.configurationError) throw options.configurationError;
      return { baseUrl: serviceUrl, timeoutMs: 2_500 };
    },
    sessions: () => ({
      retrieve: async (id) => {
        retrieved.push(id);
        if (options.sessionError) throw options.sessionError;
        return sessionResult;
      },
    }),
    fetch: fetcher,
    now: () => now,
  });

  const cookie = serializeSessionCookie(sessionId, 60).split(';', 1)[0];
  const request = (
    url = 'https://app.example/api/organizations',
    additionalHeaders: HeadersInit = {},
  ) => {
    const headers = new Headers(additionalHeaders);
    headers.set('Cookie', cookie);
    return new Request(url, { headers });
  };

  return {
    handlers,
    request,
    getCalls: () => calls,
    getRequestedUrl: () => requestedUrl,
    getRequestInit: () => requestInit,
    retrieved,
  };
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json();
}

test('requires a valid opaque session cookie and active server session', async () => {
  const context = setup();
  const missing = await context.handlers.getOrganizations(
    new Request('https://app.example/api/organizations'),
  );
  assert.equal(missing.status, 401);
  assert.deepEqual(await responseBody(missing), { error: 'Authentication required.' });
  assert.equal(context.getCalls(), 0);

  const malformed = await context.handlers.getOrganizations(
    new Request('https://app.example/api/organizations', {
      headers: { Cookie: `propertyos_session=${'x'.repeat(42)}` },
    }),
  );
  assert.equal(malformed.status, 401);
  assert.equal(context.getCalls(), 0);

  const missingSession = setup({ session: null });
  const missingResponse = await missingSession.handlers.getOrganizations(
    missingSession.request(),
  );
  assert.equal(missingResponse.status, 401);
  assert.deepEqual(missingSession.retrieved, [sessionId]);
});

test('rejects malformed session token data and expired Cognito access tokens', async () => {
  for (const data of [
    { accessToken: 'not-a-jwt', accessTokenExpiresAt: String(now + 1_000) },
    { accessToken, accessTokenExpiresAt: 'not-a-time' },
    { accessToken, accessTokenExpiresAt: String(now) },
    { accessToken, accessTokenExpiresAt: String(Number.MAX_SAFE_INTEGER + 1) },
  ]) {
    const context = setup({ session: { data } });
    const response = await context.handlers.getOrganizations(context.request());
    assert.equal(response.status, 401);
    assert.equal(context.getCalls(), 0);
  }
});

test('forwards only the server-held bearer token and validated pagination', async () => {
  const context = setup({
    response: makeResponse(200, makePage([orgA, orgB])),
  });
  const response = await context.handlers.getOrganizations(
    context.request(
      'https://app.example/api/organizations?limit=2',
      {
        Authorization: 'Bearer browser-controlled-token',
        'X-Internal-Service': 'attacker-value',
      },
    ),
  );

  assert.equal(response.status, 200);
  const responsePayload = await responseBody(response);
  assert.deepEqual(responsePayload, makePage([orgA, orgB]));
  assert.equal(
    context.getRequestedUrl()?.href,
    'https://organization-access.example.test/api/v1/users/me/organizations?limit=2',
  );
  const init = context.getRequestInit();
  assert.equal(init?.method, 'GET');
  assert.equal(init?.cache, 'no-store');
  assert.equal(init?.redirect, 'manual');
  assert.equal((init?.signal as AbortSignal).aborted, false);
  assert.equal(context.getCalls(), 1);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${accessToken}`);
  assert.equal(headers.get('Accept'), 'application/json');
  assert.deepEqual([...headers.keys()].sort(), ['accept', 'authorization']);
  assert.notEqual(headers.get('Authorization'), 'Bearer browser-controlled-token');
  assert.equal(headers.has('X-Internal-Service'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  const body = JSON.stringify(responsePayload);
  assert.doesNotMatch(body, /signature|verified-subject|sessionId|organization-access\.example/);
});

test('forwards a validated pagination cursor without accepting unrelated query data', async () => {
  const cursor = 'eyJuYW1lIjoiQWxwaGEiLCJpZCI6IjAwMCJ9';
  const context = setup({
    response: makeResponse(200, makePage([orgB])),
  });
  const response = await context.handlers.getOrganizations(
    context.request(
      `https://app.example/api/organizations?limit=1&cursor=${cursor}`,
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(
    context.getRequestedUrl()?.search,
    `?limit=1&cursor=${cursor}`,
  );

  for (const query of [
    '?limit=0',
    '?limit=101',
    '?limit=1&limit=2',
    '?cursor=invalid.cursor',
    '?organization_id=attacker-controlled',
    '?subject=another-user',
    '?role=admin',
  ]) {
    const invalid = setup();
    const invalidResponse = await invalid.handlers.getOrganizations(
      invalid.request(`https://app.example/api/organizations${query}`),
    );
    assert.equal(invalidResponse.status, 400, query);
    assert.equal(invalid.getCalls(), 0, query);
  }
});

test('fails closed when session storage or service configuration is unavailable', async () => {
  const storeFailure = setup({ sessionError: new Error('sensitive storage detail') });
  const storeResponse = await storeFailure.handlers.getOrganizations(
    storeFailure.request(),
  );
  assert.equal(storeResponse.status, 503);
  assert.doesNotMatch(await storeResponse.text(), /sensitive storage detail/);

  const configFailure = setup({
    configurationError: new Error('sensitive service URL'),
  });
  const configResponse = await configFailure.handlers.getOrganizations(
    configFailure.request(),
  );
  assert.equal(configResponse.status, 503);
  assert.doesNotMatch(await configResponse.text(), /sensitive service URL/);
  assert.equal(configFailure.getCalls(), 0);

  const networkFailure = setup({ fetchError: new Error('sensitive network detail') });
  const networkResponse = await networkFailure.handlers.getOrganizations(
    networkFailure.request(),
  );
  assert.equal(networkResponse.status, 503);
  assert.doesNotMatch(await networkResponse.text(), /sensitive network detail/);
});

test('validates private upstream URL and bounded timeout configuration', () => {
  const names = [
    'ORGANIZATION_ACCESS_URL',
    'ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP',
    'ORGANIZATION_ACCESS_TIMEOUT_MS',
    'NODE_ENV',
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  const set = (name: typeof names[number], value: string | undefined) => {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else Reflect.set(process.env, name, value);
  };
  try {
    set('NODE_ENV', 'test');
    set('ORGANIZATION_ACCESS_URL', 'https://organization-access.example.test');
    set('ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP', undefined);
    set('ORGANIZATION_ACCESS_TIMEOUT_MS', undefined);
    assert.deepEqual(loadOrganizationAccessConfiguration(), {
      baseUrl: new URL('https://organization-access.example.test/'),
      timeoutMs: 3_000,
    });

    for (const url of [
      '',
      'http://organization-access.example.test',
      'https://user:password@organization-access.example.test',
      'https://organization-access.example.test/private',
      'https://organization-access.example.test?query=1',
    ]) {
      set('ORGANIZATION_ACCESS_URL', url);
      assert.throws(loadOrganizationAccessConfiguration);
    }

    set('ORGANIZATION_ACCESS_URL', 'http://127.0.0.1:8101');
    set('ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP', 'true');
    assert.equal(loadOrganizationAccessConfiguration().baseUrl.protocol, 'http:');
    set('NODE_ENV', 'production');
    assert.throws(loadOrganizationAccessConfiguration);

    set('NODE_ENV', 'test');
    set('ORGANIZATION_ACCESS_URL', 'https://organization-access.example.test');
    set('ORGANIZATION_ACCESS_TIMEOUT_MS', '10001');
    assert.throws(loadOrganizationAccessConfiguration);
  } finally {
    for (const [name, value] of original) set(name, value);
  }
});

test('maps upstream authentication, authorization, redirects, and failures safely', async () => {
  for (const [upstreamStatus, expectedStatus] of [
    [401, 401],
    [403, 403],
    [302, 502],
    [500, 502],
  ]) {
    const context = setup({ response: makeResponse(upstreamStatus) });
    const response = await context.handlers.getOrganizations(context.request());
    assert.equal(response.status, expectedStatus);
    const body = await response.text();
    assert.doesNotMatch(body, /organization-access\.example|access-secret/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('rejects malformed upstream payloads and non-JSON responses', async () => {
  const malformedPayloads = [
    makePage([{ ...orgA, role: 'owner' } as OrganizationsPage['organizations'][number]]),
    makePage([{ ...orgA, id: 'not-a-uuid' }]),
    makePage([{ ...orgA, name: '' }]),
    makePage([orgA, orgA]),
    makePage([orgA], 'not.a.cursor'),
    makePage(Array.from({ length: 51 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `Organization ${index + 1}`,
    }))),
    { organizations: [orgA], next_cursor: null, subject: 'sensitive' },
    { organizations: 'not-an-array', next_cursor: null },
  ];

  for (const payload of malformedPayloads) {
    const context = setup({ response: makeResponse(200, payload) });
    const response = await context.handlers.getOrganizations(context.request());
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /sensitive|access-secret/);
  }

  const nonJson = setup({
    response: makeResponse(200, 'internal detail', { 'Content-Type': 'text/plain' }),
  });
  const response = await nonJson.handlers.getOrganizations(nonJson.request());
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /internal detail/);

  const oversized = setup({
    response: new Response(`"${'x'.repeat(70 * 1024)}"`, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const oversizedResponse = await oversized.handlers.getOrganizations(
    oversized.request(),
  );
  assert.equal(oversizedResponse.status, 502);
});
