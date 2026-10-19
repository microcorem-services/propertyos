import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCognitoAuthHandlers,
} from '../../src/lib/auth/cognito-handlers';
import {
  CognitoConfigurationError,
  loadAppOrigin,
  loadCognitoConfiguration,
  type CognitoConfiguration,
} from '../../src/lib/auth/cognito';
import type { Session } from '../../src/lib/auth/session';

const transactionCookieId = 't'.repeat(43);
const config: CognitoConfiguration = {
  issuer: new URL('https://issuer.example/'),
  clientId: 'web-client-id',
  clientSecret: 'server-client-secret',
  scopes: ['openid', 'propertyos/read'],
  callbackUrl: new URL('https://app.example/api/auth/callback'),
  appOrigin: new URL('https://app.example/'),
};

function session(
  id: string,
  data: Record<string, string>,
  createdAt = 1_000_000,
): Session {
  return {
    id,
    data,
    createdAt,
    lastSeenAt: createdAt,
    absoluteExpiresAt: createdAt + 600_000,
    idleExpiresAt: createdAt + 600_000,
    cookieMaxAgeSeconds: 600,
  };
}

class FakeSessions {
  readonly records = new Map<string, Session>();
  created: Record<string, string> | undefined;
  revoked: string[] = [];
  sequence = 0;

  async create(data: Record<string, string> = {}): Promise<Session> {
    this.created = { ...data };
    const result = session('s'.repeat(42) + String(++this.sequence), data);
    this.records.set(result.id, result);
    return result;
  }

  async retrieve(id: string): Promise<Session | null> {
    return this.records.get(id) ?? null;
  }

  async rotate(id: string, data?: Record<string, string>): Promise<Session | null> {
    const current = this.records.get(id);
    if (!current) return null;
    this.records.delete(id);
    this.created = { ...(data ?? current.data) };
    const result = session(
      'r'.repeat(42) + String(++this.sequence),
      this.created,
      current.createdAt,
    );
    this.records.set(result.id, result);
    return result;
  }

  async revoke(id: string): Promise<boolean> {
    const existed = this.records.has(id);
    if (!existed) return false;
    this.revoked.push(id);
    this.records.delete(id);
    return true;
  }
}

function makeTokens(overrides: Record<string, unknown> = {}) {
  const claims = {
    iss: config.issuer.href,
    aud: config.clientId,
    sub: 'verified-subject',
    nonce: 'expected-nonce',
    ...((overrides.claims as Record<string, unknown> | undefined) ?? {}),
  };
  return {
    access_token: 'access-secret-token',
    id_token: 'id-secret-token',
    refresh_token: 'refresh-secret-token',
    token_type: 'Bearer',
    expires_in: 3600,
    ...overrides,
    claims: () => claims,
  };
}

function setup(options: {
  transaction?: Session;
  tokens?: ReturnType<typeof makeTokens>;
  exchangeError?: Error;
  configurationError?: Error;
  callback?: (checks: unknown, redirectUri: string, url: URL) => void;
} = {}) {
  const transactions = new FakeSessions();
  const authenticated = new FakeSessions();
  const pending = options.transaction ?? session(transactionCookieId, {
    state: 'expected-state',
    nonce: 'expected-nonce',
    verifier: 'private-pkce-verifier',
    returnTo: '/properties',
  });
  transactions.records.set(transactionCookieId, pending);
  let exchangeCount = 0;
  const handlers = createCognitoAuthHandlers({
    configuration: () => {
      if (options.configurationError) throw options.configurationError;
      return config;
    },
    oidcClient: async () => ({
      authorizeUrl: (parameters) => {
        const url = new URL('https://issuer.example/authorize');
        for (const [key, value] of Object.entries(parameters)) {
          url.searchParams.set(key, value);
        }
        return url;
      },
      exchange: async (url, checks, redirectUri) => {
        exchangeCount += 1;
        options.callback?.(checks, redirectUri, url);
        if (options.exchangeError) throw options.exchangeError;
        return options.tokens ?? makeTokens();
      },
    }),
    sessions: () => ({ transactions, authenticated }),
    now: () => 1_000_000,
    randomState: () => 'expected-state',
    randomNonce: () => 'expected-nonce',
    randomVerifier: () => 'private-pkce-verifier',
    challenge: async () => 's256-challenge',
  });
  return {
    handlers,
    transactions,
    authenticated,
    get exchangeCount() {
      return exchangeCount;
    },
  };
}

function callbackRequest(
  query = 'code=authorization-code&state=expected-state',
  cookie = `propertyos_oidc_tx=${transactionCookieId}`,
): Request {
  return new Request(
    `https://app.example/api/auth/callback?${query}`,
    { headers: { cookie } },
  );
}

test('login creates server-side PKCE transaction and redirects with S256, state and nonce', async () => {
  const testContext = setup();
  const response = await testContext.handlers.login(
    new Request('https://app.example/api/auth/login?returnTo=%2Fproperties'),
  );

  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('location') ?? '');
  assert.equal(location.searchParams.get('state'), 'expected-state');
  assert.equal(location.searchParams.get('nonce'), 'expected-nonce');
  assert.equal(location.searchParams.get('code_challenge'), 's256-challenge');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), config.callbackUrl.href);
  assert.equal(location.searchParams.get('scope'), config.scopes.join(' '));
  assert.equal(location.searchParams.has('code_verifier'), false);
  assert.equal(testContext.transactions.created?.verifier, 'private-pkce-verifier');
  const cookie = response.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test('login falls back to a same-origin root path for an external return URL', async () => {
  const testContext = setup();
  const response = await testContext.handlers.login(
    new Request('https://app.example/api/auth/login?returnTo=https%3A%2F%2Fevil.example'),
  );
  assert.equal(response.status, 303);
  assert.equal(testContext.transactions.created?.returnTo, '/');
});

test('callback verifies state, nonce, issuer, audience and token response before creating session', async () => {
  let observedChecks: unknown;
  let observedRedirectUri: string | undefined;
  let observedCallbackUrl: URL | undefined;
  const testContext = setup({
    callback(checks, redirectUri, url) {
      observedChecks = checks;
      observedRedirectUri = redirectUri;
      observedCallbackUrl = url;
    },
  });
  const response = await testContext.handlers.callback(callbackRequest());

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://app.example/properties');
  assert.deepEqual(observedChecks, {
    pkceCodeVerifier: 'private-pkce-verifier',
    expectedState: 'expected-state',
    expectedNonce: 'expected-nonce',
  });
  assert.equal(observedRedirectUri, config.callbackUrl.href);
  assert.equal(observedCallbackUrl?.origin, config.callbackUrl.origin);
  assert.equal(testContext.authenticated.created?.subject, 'verified-subject');
  assert.equal(testContext.authenticated.created?.accessToken, 'access-secret-token');
  assert.equal(testContext.authenticated.created?.refreshToken, 'refresh-secret-token');
  const headers = response.headers.getSetCookie().join(';');
  assert.match(headers, /propertyos_session=.*HttpOnly.*SameSite=Lax/);
  assert.match(headers, /propertyos_oidc_tx=.*Max-Age=0/);
  assert.doesNotMatch(headers, /access-secret-token|id-secret-token|refresh-secret-token/);
  assert.doesNotMatch(response.headers.get('location') ?? '', /secret-token|authorization-code/);
});

test('callback consumes transaction once and rejects replay', async () => {
  const testContext = setup();
  const first = await testContext.handlers.callback(callbackRequest());
  assert.equal(first.status, 303);
  const replay = await testContext.handlers.callback(callbackRequest());

  assert.equal(replay.status, 400);
  assert.equal(testContext.exchangeCount, 1);
});

test('simultaneous callbacks consume one login transaction only once', async () => {
  const testContext = setup();
  const responses = await Promise.all([
    testContext.handlers.callback(callbackRequest()),
    testContext.handlers.callback(callbackRequest()),
  ]);

  assert.equal(responses.filter((response) => response.status === 303).length, 1);
  assert.equal(testContext.exchangeCount, 1);
  assert.equal(testContext.authenticated.records.size, 1);
});

test('callback rejects state mismatch and does not exchange code', async () => {
  const testContext = setup();
  const response = await testContext.handlers.callback(
    callbackRequest('code=authorization-code&state=wrong-state'),
  );

  assert.equal(response.status, 400);
  assert.equal(testContext.exchangeCount, 0);
  assert.ok(testContext.transactions.revoked.includes(transactionCookieId));
});

test('callback rejects expired transaction before token exchange', async () => {
  const testContext = setup({
    transaction: session(transactionCookieId, {
      state: 'expected-state',
      nonce: 'expected-nonce',
      verifier: 'private-pkce-verifier',
      returnTo: '/',
    }, 1_000_000 - 600_001),
  });
  const response = await testContext.handlers.callback(callbackRequest());

  assert.equal(response.status, 400);
  assert.equal(testContext.exchangeCount, 0);
});

test('callback rejects invalid token claims and token response fields', async (t) => {
  const scenarios = [
    { claims: { iss: 'https://attacker.example' } },
    { claims: { aud: 'other-client' } },
    { claims: { nonce: 'wrong-nonce' } },
    { claims: { sub: '' } },
    { access_token: '' },
    { token_type: 'MAC' },
    { expires_in: 0 },
    { expires_in: 86_401 },
  ];
  for (const invalid of scenarios) {
    await t.test(JSON.stringify(invalid), async () => {
      const testContext = setup({ tokens: makeTokens(invalid) });
      const response = await testContext.handlers.callback(callbackRequest());
      assert.equal(response.status, 401);
      assert.equal(testContext.authenticated.created, undefined);
    });
  }
});

test('callback fails closed on token exchange and session-store failures', async () => {
  const exchangeFailure = setup({ exchangeError: new Error('provider failure') });
  assert.equal(
    (await exchangeFailure.handlers.callback(callbackRequest())).status,
    503,
  );

  const sessionFailure = setup();
  sessionFailure.authenticated.create = async () => {
    throw new Error('DynamoDB unavailable');
  };
  const response = await sessionFailure.handlers.callback(callbackRequest());
  assert.equal(response.status, 503);
  assert.doesNotMatch(response.headers.get('location') ?? '', /secret-token/);
});

test('missing configuration fails closed', async () => {
  const testContext = setup({ configurationError: new Error('missing config') });
  const response = await testContext.handlers.login(
    new Request('https://app.example/api/auth/login'),
  );
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /client_secret|private-pkce-verifier/);
});

test('validates configured issuer, callback URL, app origin and production HTTPS', () => {
  const environment = {
    COGNITO_ISSUER: 'https://cognito-idp.eu-west-2.amazonaws.com/pool-id',
    COGNITO_CLIENT_ID: 'web-client-id',
    COGNITO_CLIENT_SECRET: 'secret-from-server-config',
    COGNITO_SCOPES: 'openid propertyos/read',
    COGNITO_CALLBACK_URL: 'https://property.example/api/auth/callback',
    APP_ORIGIN: 'https://property.example',
    NODE_ENV: 'production',
  };
  assert.equal(
    loadCognitoConfiguration(environment).callbackUrl.href,
    environment.COGNITO_CALLBACK_URL,
  );
  assert.deepEqual(loadCognitoConfiguration(environment).scopes, [
    'openid',
    'propertyos/read',
  ]);
  assert.equal(loadAppOrigin(environment).origin, 'https://property.example');
  assert.throws(
    () => loadCognitoConfiguration({
      ...environment,
      COGNITO_CALLBACK_URL: 'https://evil.example/api/auth/callback',
    }),
    CognitoConfigurationError,
  );
  assert.throws(
    () => loadCognitoConfiguration({
      ...environment,
      COGNITO_ISSUER: 'http://cognito.example/pool-id',
    }),
    CognitoConfigurationError,
  );
  assert.throws(
    () => loadCognitoConfiguration({
      ...environment,
      COGNITO_SCOPES: 'propertyos/read',
    }),
    CognitoConfigurationError,
  );
  assert.throws(
    () => loadAppOrigin({
      ...environment,
      APP_ORIGIN: 'http://property.example',
    }),
    CognitoConfigurationError,
  );
});

test('authentication rotates an existing local session identifier', async () => {
  const testContext = setup();
  const oldId = 'o'.repeat(43);
  testContext.authenticated.records.set(oldId, session(oldId, { previous: 'data' }));
  const response = await testContext.handlers.callback(
    callbackRequest(
      'code=authorization-code&state=expected-state',
      `propertyos_oidc_tx=${transactionCookieId}; propertyos_session=${oldId}`,
    ),
  );

  assert.equal(response.status, 303);
  assert.equal(testContext.authenticated.records.has(oldId), false);
  assert.equal(testContext.authenticated.records.size, 1);
  assert.equal(testContext.authenticated.created?.accessToken, 'access-secret-token');
});

test('stale callback cleanup does not revoke a newer valid session', async () => {
  const testContext = setup();
  const oldId = 'o'.repeat(43);
  const descendantId = 'd'.repeat(43);
  testContext.authenticated.records.set(
    descendantId,
    session(descendantId, { accessToken: 'newer-token' }),
  );
  const response = await testContext.handlers.callback(
    callbackRequest(
      'code=authorization-code&state=expected-state',
      `propertyos_oidc_tx=${transactionCookieId}; propertyos_session=${oldId}`,
    ),
  );

  assert.equal(response.status, 303);
  assert.equal(testContext.authenticated.records.get(descendantId)?.data.accessToken, 'newer-token');
  assert.equal(testContext.authenticated.revoked.includes(oldId), false);
});

test('logout validates same-origin request, revokes session and clears cookie', async () => {
  const testContext = setup();
  const cookieId = 'l'.repeat(43);
  testContext.authenticated.records.set(cookieId, session(cookieId, {}));
  const allowed = await testContext.handlers.logout(new Request(
    'https://app.example/api/auth/logout',
    {
      method: 'POST',
      headers: {
        origin: config.appOrigin.origin,
        'sec-fetch-site': 'same-origin',
        cookie: `propertyos_session=${cookieId}`,
      },
    },
  ));

  assert.equal(allowed.status, 204);
  assert.ok(testContext.authenticated.revoked.includes(cookieId));
  assert.match(allowed.headers.get('set-cookie') ?? '', /HttpOnly.*SameSite=Lax.*Max-Age=0/);

  const denied = await testContext.handlers.logout(new Request(
    'https://app.example/api/auth/logout',
    { method: 'POST', headers: { origin: 'https://evil.example' } },
  ));
  assert.equal(denied.status, 403);
});

test('logout does not report success for a stale or failed revocation', async () => {
  const testContext = setup();
  const staleId = 'x'.repeat(43);
  const request = () => new Request('https://app.example/api/auth/logout', {
    method: 'POST',
    headers: {
      origin: config.appOrigin.origin,
      cookie: `propertyos_session=${staleId}`,
    },
  });

  const staleResponse = await testContext.handlers.logout(request());
  assert.equal(staleResponse.status, 409);
  assert.match(staleResponse.headers.get('set-cookie') ?? '', /Max-Age=0/);

  testContext.authenticated.revoke = async () => {
    throw new Error('DynamoDB unavailable');
  };
  const failedResponse = await testContext.handlers.logout(request());
  assert.equal(failedResponse.status, 503);
});
