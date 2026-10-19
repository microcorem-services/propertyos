import 'server-only';

import { readSessionCookie } from './session';

const PORTFOLIOS_PATH = '/api/v1/portfolios';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;
const MAX_PORTFOLIOS = 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const PORTFOLIO_STATUSES = new Set(['active', 'inactive']);

export type Portfolio = {
  id: string;
  organization_id: string;
  name: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

type RetrievedSession = {
  data: Record<string, string>;
};

type PortfolioSessionManager = {
  retrieve(id: string): Promise<RetrievedSession | null>;
};

type PropertyAssetRegistryConfiguration = {
  baseUrl: URL;
  timeoutMs: number;
};

type PortfolioHandlerDependencies = {
  configuration?: () => PropertyAssetRegistryConfiguration;
  sessions: () => PortfolioSessionManager;
  fetch?: typeof fetch;
  now?: () => number;
};

function errorResponse(status: number, error: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    },
  );
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function loadPropertyAssetRegistryConfiguration():
  PropertyAssetRegistryConfiguration {
  const configuredUrl = process.env.PROPERTY_ASSET_REGISTRY_URL;
  const allowLocalHttp =
    process.env.PROPERTY_ASSET_REGISTRY_ALLOW_INSECURE_LOCAL_HTTP === 'true';
  const rawLocalHttp =
    process.env.PROPERTY_ASSET_REGISTRY_ALLOW_INSECURE_LOCAL_HTTP;
  if (rawLocalHttp !== undefined && rawLocalHttp !== 'true' && rawLocalHttp !== 'false') {
    throw new Error('Invalid Property & Asset Registry configuration.');
  }

  let baseUrl: URL;
  try {
    if (!configuredUrl) throw new TypeError();
    baseUrl = new URL(configuredUrl);
  } catch {
    throw new Error('Invalid Property & Asset Registry configuration.');
  }

  const secure = baseUrl.protocol === 'https:';
  const localHttp =
    baseUrl.protocol === 'http:' &&
    process.env.NODE_ENV !== 'production' &&
    allowLocalHttp &&
    isLoopback(baseUrl.hostname);
  if (
    (!secure && !localHttp) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error('Invalid Property & Asset Registry configuration.');
  }

  const rawTimeout = process.env.PROPERTY_ASSET_REGISTRY_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error('Invalid Property & Asset Registry configuration.');
  }

  return { baseUrl, timeoutMs };
}

function requestedOrganizationId(requestUrl: URL): string | null {
  const keys = [...requestUrl.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'organizationId') return null;
  const values = requestUrl.searchParams.getAll('organizationId');
  if (values.length !== 1 || !UUID_PATTERN.test(values[0])) return null;
  return values[0];
}

async function readAccessToken(
  request: Request,
  sessions: () => PortfolioSessionManager,
  now: () => number,
): Promise<string | null> {
  const sessionId = readSessionCookie(request.headers.get('cookie'));
  if (!sessionId) return null;

  const session = await sessions().retrieve(sessionId);
  if (!session) return null;

  const accessToken = session.data.accessToken;
  const expiresAtValue = session.data.accessTokenExpiresAt;
  if (
    typeof accessToken !== 'string' ||
    !JWT_PATTERN.test(accessToken) ||
    typeof expiresAtValue !== 'string' ||
    !/^[1-9]\d*$/.test(expiresAtValue)
  ) {
    return null;
  }
  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return null;
  return accessToken;
}

function isValidTimestamp(value: string): boolean {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue, zone, zoneHourValue, zoneMinuteValue] =
    match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  return (
    daysInMonth !== undefined &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (zone === 'Z' ||
      (Number(zoneHourValue) <= 23 && Number(zoneMinuteValue) <= 59)) &&
    Number.isFinite(Date.parse(value))
  );
}

function parsePortfolios(payload: unknown, organizationId: string): Portfolio[] | null {
  if (!Array.isArray(payload) || payload.length > MAX_PORTFOLIOS) return null;

  const portfolios: Portfolio[] = [];
  const seenIds = new Set<string>();
  for (const value of payload) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const portfolio = value as Record<string, unknown>;
    if (
      Object.keys(portfolio).length !== 6 ||
      !Object.hasOwn(portfolio, 'id') ||
      !Object.hasOwn(portfolio, 'organization_id') ||
      !Object.hasOwn(portfolio, 'name') ||
      !Object.hasOwn(portfolio, 'status') ||
      !Object.hasOwn(portfolio, 'created_at') ||
      !Object.hasOwn(portfolio, 'updated_at') ||
      typeof portfolio.id !== 'string' ||
      !UUID_PATTERN.test(portfolio.id) ||
      seenIds.has(portfolio.id) ||
      typeof portfolio.organization_id !== 'string' ||
      !UUID_PATTERN.test(portfolio.organization_id) ||
      portfolio.organization_id.toLowerCase() !== organizationId.toLowerCase() ||
      typeof portfolio.name !== 'string' ||
      portfolio.name.trim().length === 0 ||
      portfolio.name.length > 200 ||
      typeof portfolio.status !== 'string' ||
      !PORTFOLIO_STATUSES.has(portfolio.status) ||
      typeof portfolio.created_at !== 'string' ||
      !isValidTimestamp(portfolio.created_at) ||
      typeof portfolio.updated_at !== 'string' ||
      !isValidTimestamp(portfolio.updated_at)
    ) {
      return null;
    }

    seenIds.add(portfolio.id);
    portfolios.push({
      id: portfolio.id,
      organization_id: portfolio.organization_id,
      name: portfolio.name,
      status: portfolio.status as Portfolio['status'],
      created_at: portfolio.created_at,
      updated_at: portfolio.updated_at,
    });
  }
  return portfolios;
}

async function readPortfolioPayload(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_UPSTREAM_RESPONSE_BYTES
    ) {
      throw new Error('Invalid Property & Asset Registry response.');
    }
  }

  if (!response.body) throw new Error('Invalid Property & Asset Registry response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Invalid Property & Asset Registry response.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function createPortfolioHandlers(
  dependencies: PortfolioHandlerDependencies,
) {
  const configuration =
    dependencies.configuration ?? loadPropertyAssetRegistryConfiguration;
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;

  return {
    async getPortfolios(request: Request): Promise<Response> {
      const organizationId = requestedOrganizationId(new URL(request.url));
      if (!organizationId) {
        return errorResponse(400, 'Invalid portfolio listing request.');
      }

      try {
        const accessToken = await readAccessToken(
          request,
          dependencies.sessions,
          now,
        );
        if (!accessToken) return errorResponse(401, 'Authentication required.');

        const config = configuration();
        const upstreamUrl = new URL(PORTFOLIOS_PATH, config.baseUrl);
        upstreamUrl.searchParams.set('organization_id', organizationId);
        const upstream = await fetcher(upstreamUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          cache: 'no-store',
          redirect: 'manual',
          signal: AbortSignal.timeout(config.timeoutMs),
        });

        if (upstream.status === 401) {
          return errorResponse(401, 'Authentication required.');
        }
        if (upstream.status === 403) {
          return errorResponse(403, 'Organization access denied.');
        }
        if (upstream.status !== 200 || upstream.redirected) {
          return errorResponse(503, 'Property service unavailable.');
        }
        if (!upstream.headers.get('content-type')?.toLowerCase().includes('application/json')) {
          return errorResponse(502, 'Invalid Property & Asset Registry response.');
        }

        let payload: unknown;
        try {
          payload = await readPortfolioPayload(upstream);
        } catch {
          return errorResponse(502, 'Invalid Property & Asset Registry response.');
        }
        const portfolios = parsePortfolios(payload, organizationId);
        if (!portfolios) {
          return errorResponse(502, 'Invalid Property & Asset Registry response.');
        }

        return Response.json(portfolios, {
          headers: {
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
          },
        });
      } catch {
        return errorResponse(503, 'Property service unavailable.');
      }
    },
    async getPortfolio(
      request: Request,
      portfolioId: string,
    ): Promise<Response> {
      const requestUrl = new URL(request.url);
      const organizationId = requestedOrganizationId(requestUrl);
      if (!organizationId || !UUID_PATTERN.test(portfolioId)) {
        return errorResponse(400, 'Invalid portfolio detail request.');
      }

      try {
        const accessToken = await readAccessToken(
          request,
          dependencies.sessions,
          now,
        );
        if (!accessToken) return errorResponse(401, 'Authentication required.');

        const config = configuration();
        const upstreamUrl = new URL(
          `${PORTFOLIOS_PATH}/${encodeURIComponent(portfolioId)}`,
          config.baseUrl,
        );
        upstreamUrl.searchParams.set('organization_id', organizationId);
        const upstream = await fetcher(upstreamUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          cache: 'no-store',
          redirect: 'manual',
          signal: AbortSignal.timeout(config.timeoutMs),
        });

        if (upstream.status === 401) {
          return errorResponse(401, 'Authentication required.');
        }
        if (upstream.status === 403) {
          return errorResponse(403, 'Organization access denied.');
        }
        if (upstream.status === 404) {
          return errorResponse(404, 'Portfolio not found.');
        }
        if (upstream.status !== 200 || upstream.redirected) {
          return errorResponse(503, 'Property service unavailable.');
        }
        if (!upstream.headers.get('content-type')?.toLowerCase().includes('application/json')) {
          return errorResponse(502, 'Invalid Property & Asset Registry response.');
        }

        let payload: unknown;
        try {
          payload = await readPortfolioPayload(upstream);
        } catch {
          return errorResponse(502, 'Invalid Property & Asset Registry response.');
        }
        const portfolios = parsePortfolios([payload], organizationId);
        if (!portfolios || portfolios[0].id.toLowerCase() !== portfolioId.toLowerCase()) {
          return errorResponse(502, 'Invalid Property & Asset Registry response.');
        }

        return Response.json(portfolios[0], {
          headers: {
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
          },
        });
      } catch {
        return errorResponse(503, 'Property service unavailable.');
      }
    },
  };
}
