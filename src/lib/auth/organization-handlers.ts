import 'server-only';

import { readSessionCookie } from './session';

const ORGANIZATIONS_PATH = '/api/v1/users/me/organizations';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type OrganizationChoice = {
  id: string;
  name: string;
};

export type OrganizationsPage = {
  organizations: OrganizationChoice[];
  next_cursor: string | null;
};

type RetrievedSession = {
  data: Record<string, string>;
};

type OrganizationSessionManager = {
  retrieve(id: string): Promise<RetrievedSession | null>;
};

type OrganizationAccessConfiguration = {
  baseUrl: URL;
  timeoutMs: number;
};

type OrganizationHandlerDependencies = {
  configuration?: () => OrganizationAccessConfiguration;
  sessions: () => OrganizationSessionManager;
  fetch?: typeof fetch;
  now?: () => number;
};

type ApiError = {
  error: string;
};

function errorResponse(status: number, error: string): Response {
  return Response.json(
    { error } satisfies ApiError,
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

export function loadOrganizationAccessConfiguration(): OrganizationAccessConfiguration {
  const configuredUrl = process.env.ORGANIZATION_ACCESS_URL;
  const allowLocalHttp =
    process.env.ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP === 'true';
  if (
    process.env.ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP !== undefined &&
    process.env.ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP !== 'true' &&
    process.env.ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP !== 'false'
  ) {
    throw new Error('Invalid Organization & Access configuration.');
  }

  let baseUrl: URL;
  try {
    if (!configuredUrl) throw new TypeError();
    baseUrl = new URL(configuredUrl);
  } catch {
    throw new Error('Invalid Organization & Access configuration.');
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
    throw new Error('Invalid Organization & Access configuration.');
  }

  const rawTimeout = process.env.ORGANIZATION_ACCESS_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error('Invalid Organization & Access configuration.');
  }

  return { baseUrl, timeoutMs };
}

function parsePagination(requestUrl: URL): {
  limit: number;
  cursor: string | null;
} | null {
  for (const key of requestUrl.searchParams.keys()) {
    if (key !== 'limit' && key !== 'cursor') return null;
  }

  const limitValues = requestUrl.searchParams.getAll('limit');
  const cursorValues = requestUrl.searchParams.getAll('cursor');
  if (limitValues.length > 1 || cursorValues.length > 1) return null;

  const rawLimit = limitValues[0] ?? '50';
  if (!/^(?:[1-9]\d{0,2})$/.test(rawLimit)) return null;
  const limit = Number(rawLimit);
  if (limit > MAX_PAGE_SIZE) return null;

  const cursor = cursorValues[0] ?? null;
  if (cursor !== null && !CURSOR_PATTERN.test(cursor)) return null;
  return { limit, cursor };
}

function parseOrganizationsPage(
  payload: unknown,
  limit: number,
): OrganizationsPage | null {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const page = payload as Record<string, unknown>;
  if (
    Object.keys(page).length !== 2 ||
    !Object.hasOwn(page, 'organizations') ||
    !Object.hasOwn(page, 'next_cursor') ||
    !Array.isArray(page.organizations) ||
    page.organizations.length > limit
  ) {
    return null;
  }

  const organizations: OrganizationChoice[] = [];
  const seenIds = new Set<string>();
  for (const value of page.organizations) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).length !== 2 ||
      !Object.hasOwn(item, 'id') ||
      !Object.hasOwn(item, 'name') ||
      typeof item.id !== 'string' ||
      !UUID_PATTERN.test(item.id) ||
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > 200 ||
      seenIds.has(item.id)
    ) {
      return null;
    }
    seenIds.add(item.id);
    organizations.push({ id: item.id, name: item.name });
  }

  const nextCursor = page.next_cursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== 'string' || !CURSOR_PATTERN.test(nextCursor))
  ) {
    return null;
  }
  if (nextCursor !== null && organizations.length !== limit) {
    return null;
  }

  return { organizations, next_cursor: nextCursor };
}

async function readOrganizationsPayload(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_UPSTREAM_RESPONSE_BYTES) {
      throw new Error('Invalid organization service response.');
    }
  }

  if (!response.body) throw new Error('Invalid organization service response.');
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
        throw new Error('Invalid organization service response.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
}

export function createOrganizationHandlers(
  dependencies: OrganizationHandlerDependencies,
) {
  const configuration =
    dependencies.configuration ?? loadOrganizationAccessConfiguration;
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;

  return {
    async getOrganizations(request: Request): Promise<Response> {
      const pagination = parsePagination(new URL(request.url));
      if (!pagination) {
        return errorResponse(400, 'Invalid organization listing request.');
      }

      const sessionId = readSessionCookie(request.headers.get('cookie'));
      if (!sessionId) {
        return errorResponse(401, 'Authentication required.');
      }

      try {
        const session = await dependencies.sessions().retrieve(sessionId);
        if (!session) return errorResponse(401, 'Authentication required.');

        const accessToken = session.data.accessToken;
        const expiresAtValue = session.data.accessTokenExpiresAt;
        if (
          typeof accessToken !== 'string' ||
          !JWT_PATTERN.test(accessToken) ||
          typeof expiresAtValue !== 'string' ||
          !/^[1-9]\d*$/.test(expiresAtValue)
        ) {
          return errorResponse(401, 'Authentication required.');
        }
        const expiresAt = Number(expiresAtValue);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) {
          return errorResponse(401, 'Authentication required.');
        }

        const config = configuration();
        const upstreamUrl = new URL(ORGANIZATIONS_PATH, config.baseUrl);
        upstreamUrl.searchParams.set('limit', String(pagination.limit));
        if (pagination.cursor !== null) {
          upstreamUrl.searchParams.set('cursor', pagination.cursor);
        }

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
          return errorResponse(502, 'Organization service unavailable.');
        }
        if (!upstream.headers.get('content-type')?.toLowerCase().includes('application/json')) {
          return errorResponse(502, 'Invalid organization service response.');
        }

        let payload: unknown;
        try {
          payload = await readOrganizationsPayload(upstream);
        } catch {
          return errorResponse(502, 'Invalid organization service response.');
        }
        const page = parseOrganizationsPage(payload, pagination.limit);
        if (!page) {
          return errorResponse(502, 'Invalid organization service response.');
        }

        return Response.json(page, {
          status: 200,
          headers: {
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
          },
        });
      } catch {
        return errorResponse(503, 'Organization service unavailable.');
      }
    },
  };
}
