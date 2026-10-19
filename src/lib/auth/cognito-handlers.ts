import 'server-only';

import * as oidc from 'openid-client';
import {
  CognitoConfigurationError,
  getCognitoOidcClient,
  loadAppOrigin,
  loadCognitoConfiguration,
  type CognitoConfiguration,
} from './cognito';
import {
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  type Session,
} from './session';
import { getAuthSessionManagers } from './auth-runtime';

const LOGIN_TRANSACTION_COOKIE_BASE = 'propertyos_oidc_tx';
const LOGIN_TRANSACTION_TTL_SECONDS = 10 * 60;
const CALLBACK_CLOCK_SKEW_MS = 60_000;
const MAX_RETURN_TO_LENGTH = 2_048;
const MAX_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

type SessionManager = {
  create(data?: Record<string, string>): Promise<Session>;
  retrieve(id: string): Promise<Session | null>;
  rotate(id: string, data?: Record<string, string>): Promise<Session | null>;
  revoke(id: string): Promise<boolean>;
};

type OidcTokens = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  claims(): {
    iss?: string;
    aud?: string | string[];
    azp?: string;
    sub?: string;
    nonce?: string;
  } | undefined;
};

type OidcClient = {
  authorizeUrl(parameters: Record<string, string>): URL;
  exchange(
    currentUrl: URL,
    checks: {
      pkceCodeVerifier: string;
      expectedState: string;
      expectedNonce: string;
    },
    redirectUri: string,
  ): Promise<OidcTokens>;
};

type HandlerDependencies = {
  configuration?: () => CognitoConfiguration;
  appOrigin?: () => URL;
  oidcClient: (configuration: CognitoConfiguration) => Promise<OidcClient>;
  sessions: () => { authenticated: SessionManager; transactions: SessionManager };
  now?: () => number;
  randomState?: () => string;
  randomNonce?: () => string;
  randomVerifier?: () => string;
  challenge?: (verifier: string) => Promise<string>;
};

function secureCookies(): boolean {
  const setting = process.env.SESSION_COOKIE_SECURE;
  if (setting !== undefined && setting !== 'true' && setting !== 'false') {
    throw new CognitoConfigurationError();
  }
  if (process.env.NODE_ENV === 'production' && setting === 'false') {
    throw new CognitoConfigurationError();
  }
  return process.env.NODE_ENV === 'production' || setting === 'true';
}

function transactionCookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? `__Host-${LOGIN_TRANSACTION_COOKIE_BASE}`
    : LOGIN_TRANSACTION_COOKIE_BASE;
}

function readTransactionCookie(header: string | null): string | null {
  if (!header) return null;
  const name = transactionCookieName();
  const found = header.split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (found.length !== 1) return null;
  const value = found[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function transactionCookie(id: string): string {
  const parts = [
    `${transactionCookieName()}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${LOGIN_TRANSACTION_TTL_SECONDS}`,
  ];
  if (secureCookies()) parts.push('Secure');
  return parts.join('; ');
}

function clearTransactionCookie(): string {
  const parts = [
    `${transactionCookieName()}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secureCookies()) parts.push('Secure');
  return parts.join('; ');
}

function json(status: number, error: string): Response {
  return Response.json({ error }, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function redirect(location: URL, cookies: string[] = []): Response {
  const headers = new Headers({
    Location: location.toString(),
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function appendCookies(response: Response, cookies: string[]): Response {
  for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
  return response;
}

function oneQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function safeReturnPath(value: string | null, origin: URL): string {
  if (
    !value ||
    value.length > MAX_RETURN_TO_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return '/';
  }
  try {
    const resolved = new URL(value, origin);
    if (resolved.origin !== origin.origin || resolved.username || resolved.password) {
      return '/';
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

function hasValidTransaction(session: Session, now: number): boolean {
  return (
    now < session.absoluteExpiresAt &&
    now - session.createdAt < LOGIN_TRANSACTION_TTL_SECONDS * 1000 &&
    now >= session.createdAt - CALLBACK_CLOCK_SKEW_MS &&
    typeof session.data.state === 'string' &&
    typeof session.data.nonce === 'string' &&
    typeof session.data.verifier === 'string' &&
    typeof session.data.returnTo === 'string'
  );
}

function hasValidTokenResponse(
  tokens: OidcTokens,
  configuration: CognitoConfiguration,
  expectedNonce: string,
): tokens is OidcTokens & {
  access_token: string;
  id_token: string;
  token_type: 'Bearer';
  expires_in: number;
} {
  if (
    typeof tokens.access_token !== 'string' ||
    tokens.access_token.length === 0 ||
    typeof tokens.id_token !== 'string' ||
    tokens.id_token.length === 0 ||
    tokens.token_type?.toLowerCase() !== 'bearer' ||
    typeof tokens.expires_in !== 'number' ||
    !Number.isSafeInteger(tokens.expires_in) ||
    tokens.expires_in <= 0 ||
    tokens.expires_in > MAX_ACCESS_TOKEN_TTL_SECONDS
  ) {
    return false;
  }
  const claims = tokens.claims();
  const audiences = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  return (
    claims?.iss === configuration.issuer.href &&
    audiences.includes(configuration.clientId) &&
    (audiences.length <= 1 || claims.azp === configuration.clientId) &&
    claims?.nonce === expectedNonce &&
    typeof claims.sub === 'string' &&
    claims.sub.length > 0
  );
}

export function createCognitoAuthHandlers(dependencies: HandlerDependencies) {
  const configuration = dependencies.configuration ?? loadCognitoConfiguration;
  const appOrigin = dependencies.appOrigin ?? (() => configuration().appOrigin);
  const now = dependencies.now ?? Date.now;
  const randomState = dependencies.randomState ?? oidc.randomState;
  const randomNonce = dependencies.randomNonce ?? oidc.randomNonce;
  const randomVerifier = dependencies.randomVerifier ?? oidc.randomPKCECodeVerifier;
  const challenge = dependencies.challenge ?? oidc.calculatePKCECodeChallenge;

  return {
    async login(request: Request): Promise<Response> {
      let transactionId: string | undefined;
      try {
        const config = configuration();
        const returnTo = safeReturnPath(
          oneQueryValue(new URL(request.url), 'returnTo'),
          config.appOrigin,
        );
        const state = randomState();
        const nonce = randomNonce();
        const verifier = randomVerifier();
        const { transactions } = dependencies.sessions();
        const transaction = await transactions.create({
          state,
          nonce,
          verifier,
          returnTo,
        });
        transactionId = transaction.id;
        const pkceChallenge = await challenge(verifier);
        const oidcClient = await dependencies.oidcClient(config);
        const destination = oidcClient.authorizeUrl({
          client_id: config.clientId,
          redirect_uri: config.callbackUrl.href,
          response_type: 'code',
          scope: config.scopes.join(' '),
          state,
          nonce,
          code_challenge: pkceChallenge,
          code_challenge_method: 'S256',
        });
        return redirect(destination, [transactionCookie(transaction.id)]);
      } catch {
        if (transactionId) {
          try {
            await dependencies.sessions().transactions.revoke(transactionId);
          } catch {
            return json(503, 'Authentication service unavailable.');
          }
        }
        return json(503, 'Authentication service unavailable.');
      }
    },

    async callback(request: Request): Promise<Response> {
      let transactionId: string | null = null;
      let claimedId: string | null = null;
      let authenticatedId: string | undefined;
      const clearTransaction = () => [clearTransactionCookie()];

      try {
        const config = configuration();
        const callbackRequestUrl = new URL(request.url);
        transactionId = readTransactionCookie(request.headers.get('cookie'));
        const state = oneQueryValue(callbackRequestUrl, 'state');
        const code = oneQueryValue(callbackRequestUrl, 'code');
        const oauthError = oneQueryValue(callbackRequestUrl, 'error');
        const { authenticated, transactions } = dependencies.sessions();

        if (!transactionId) {
          return appendCookies(json(400, 'Invalid authentication response.'), clearTransaction());
        }
        const pending = await transactions.retrieve(transactionId);
        if (
          !pending ||
          !hasValidTransaction(pending, now()) ||
          !state ||
          state !== pending.data.state ||
          callbackRequestUrl.searchParams.has('error') ||
          Boolean(oauthError) ||
          !code
        ) {
          await transactions.revoke(transactionId);
          return appendCookies(json(400, 'Invalid authentication response.'), clearTransaction());
        }

        const claimed = await transactions.rotate(transactionId, pending.data);
        if (!claimed) {
          return appendCookies(json(400, 'Authentication response already used.'), clearTransaction());
        }
        claimedId = claimed.id;
        await transactions.revoke(claimed.id);
        claimedId = null;

        const oidcClient = await dependencies.oidcClient(config);
        const currentUrl = new URL(config.callbackUrl.href);
        currentUrl.search = callbackRequestUrl.search;
        const tokens = await oidcClient.exchange(
          currentUrl,
          {
            pkceCodeVerifier: pending.data.verifier,
            expectedState: pending.data.state,
            expectedNonce: pending.data.nonce,
          },
          config.callbackUrl.href,
        );
        if (!hasValidTokenResponse(tokens, config, pending.data.nonce)) {
          return appendCookies(json(401, 'Authentication could not be verified.'), clearTransaction());
        }

        const data: Record<string, string> = {
          subject: tokens.claims()?.sub ?? '',
          accessToken: tokens.access_token,
          idToken: tokens.id_token,
          accessTokenExpiresAt: String(now() + tokens.expires_in * 1000),
        };
        if (tokens.refresh_token) data.refreshToken = tokens.refresh_token;
        const previousSessionId = readSessionCookie(
          request.headers.get('cookie'),
        );
        let authenticatedSession = previousSessionId
          ? await authenticated.rotate(previousSessionId, data)
          : null;
        if (!authenticatedSession) {
          authenticatedSession = await authenticated.create(data);
        }
        authenticatedId = authenticatedSession.id;
        const destination = new URL(
          pending.data.returnTo,
          config.appOrigin,
        );
        const response = redirect(destination, [
          clearTransactionCookie(),
          serializeSessionCookie(
            authenticatedSession.id,
            authenticatedSession.cookieMaxAgeSeconds,
          ),
        ]);
        return response;
      } catch {
        if (claimedId) {
          try {
            await dependencies.sessions().transactions.revoke(claimedId);
          } catch {
            // A failed cleanup leaves only an unreferenced, short-lived transaction.
          }
        }
        if (authenticatedId) {
          try {
            await dependencies.sessions().authenticated.revoke(authenticatedId);
          } catch {
            // The response remains an error; no session cookie is issued.
          }
        }
        return appendCookies(
          json(503, 'Authentication service unavailable.'),
          clearTransaction(),
        );
      }
    },

    async logout(request: Request): Promise<Response> {
      try {
        const origin = appOrigin();
        const requestOrigin = request.headers.get('origin');
        const fetchSite = request.headers.get('sec-fetch-site');
        if (
          request.method !== 'POST' ||
          requestOrigin !== origin.origin ||
          (fetchSite !== null && fetchSite !== 'same-origin')
        ) {
          return json(403, 'Request origin is not allowed.');
        }
        const cookieHeader = request.headers.get('cookie');
        const sessionId = readSessionCookie(cookieHeader);
        if (sessionId) {
          const revoked = await dependencies.sessions().authenticated.revoke(sessionId);
          if (!revoked) {
            return appendCookies(
              json(409, 'Session is no longer active.'),
              [serializeClearedSessionCookie()],
            );
          }
        }
        return appendCookies(
          new Response(null, {
            status: 204,
            headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
          }),
          [serializeClearedSessionCookie()],
        );
      } catch {
        return json(503, 'Authentication service unavailable.');
      }
    },
  };
}

export function createProductionCognitoAuthHandlers() {
  return createCognitoAuthHandlers({
    appOrigin: loadAppOrigin,
    oidcClient: async (configuration) => {
      const client = await getCognitoOidcClient(configuration);
      return {
        authorizeUrl: (parameters) =>
          oidc.buildAuthorizationUrl(client, parameters),
        exchange: (currentUrl, checks, redirectUri) =>
          oidc.authorizationCodeGrant(
            client,
            currentUrl,
            checks,
            { redirect_uri: redirectUri },
          ),
      };
    },
    sessions: getAuthSessionManagers,
  });
}
