import 'server-only';

import { loadAppOrigin } from './cognito';
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
const MAX_ASSETS = 1_000;
const MAX_WRITE_BODY_BYTES = 8 * 1024;

export type Portfolio = {
  id: string;
  organization_id: string;
  name: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

export type PortfolioWritePermissions = {
  can_create: boolean;
  can_update: boolean;
};

export type Site = {
  id: string;
  organization_id: string;
  portfolio_id: string;
  name: string;
  address: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

export type Building = {
  id: string;
  organization_id: string;
  site_id: string;
  name: string;
  building_code: string | null;
  address: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

export type Unit = {
  id: string;
  organization_id: string;
  building_id: string;
  name: string;
  unit_code: string | null;
  floor: string | null;
  area_sqm: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

type HierarchyKind = 'site' | 'building' | 'unit';
type HierarchyAsset = Site | Building | Unit;
type HierarchyParents = {
  portfolioId: string;
  siteId?: string;
  buildingId?: string;
  resourceId?: string;
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
  appOrigin?: () => URL;
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

function requestedSiteIdentifiers(
  requestUrl: URL,
): { organizationId: string; portfolioId: string } | null {
  const keys = [...requestUrl.searchParams.keys()].sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'organizationId' ||
    keys[1] !== 'portfolioId'
  ) {
    return null;
  }
  const organizationIds = requestUrl.searchParams.getAll('organizationId');
  const portfolioIds = requestUrl.searchParams.getAll('portfolioId');
  if (
    organizationIds.length !== 1 ||
    portfolioIds.length !== 1 ||
    !UUID_PATTERN.test(organizationIds[0]) ||
    !UUID_PATTERN.test(portfolioIds[0])
  ) {
    return null;
  }
  return {
    organizationId: organizationIds[0],
    portfolioId: portfolioIds[0],
  };
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

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseHierarchyAsset(
  value: unknown,
  kind: HierarchyKind,
  organizationId: string,
  parents: HierarchyParents,
): HierarchyAsset | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const asset = value as Record<string, unknown>;
  const commonValid =
    typeof asset.id === 'string' &&
    UUID_PATTERN.test(asset.id) &&
    (parents.resourceId === undefined ||
      asset.id.toLowerCase() === parents.resourceId.toLowerCase()) &&
    typeof asset.organization_id === 'string' &&
    asset.organization_id.toLowerCase() === organizationId.toLowerCase() &&
    typeof asset.name === 'string' &&
    asset.name.trim().length > 0 &&
    asset.name.length <= 200 &&
    typeof asset.status === 'string' &&
    PORTFOLIO_STATUSES.has(asset.status) &&
    typeof asset.created_at === 'string' &&
    isValidTimestamp(asset.created_at) &&
    typeof asset.updated_at === 'string' &&
    isValidTimestamp(asset.updated_at);
  if (!commonValid) return null;

  if (kind === 'site') {
    const keys = [
      'id',
      'organization_id',
      'portfolio_id',
      'name',
      'address',
      'status',
      'created_at',
      'updated_at',
    ];
    if (
      Object.keys(asset).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(asset, key)) ||
      typeof asset.portfolio_id !== 'string' ||
      asset.portfolio_id.toLowerCase() !== parents.portfolioId.toLowerCase() ||
      !isNullableString(asset.address)
    ) {
      return null;
    }
    return {
      id: asset.id as string,
      organization_id: asset.organization_id as string,
      portfolio_id: asset.portfolio_id,
      name: asset.name as string,
      address: asset.address,
      status: asset.status as Site['status'],
      created_at: asset.created_at as string,
      updated_at: asset.updated_at as string,
    };
  }

  if (kind === 'building') {
    const keys = [
      'id',
      'organization_id',
      'site_id',
      'name',
      'building_code',
      'address',
      'status',
      'created_at',
      'updated_at',
    ];
    if (
      Object.keys(asset).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(asset, key)) ||
      typeof asset.site_id !== 'string' ||
      asset.site_id.toLowerCase() !== parents.siteId?.toLowerCase() ||
      !isNullableString(asset.building_code) ||
      !isNullableString(asset.address)
    ) {
      return null;
    }
    return {
      id: asset.id as string,
      organization_id: asset.organization_id as string,
      site_id: asset.site_id,
      name: asset.name as string,
      building_code: asset.building_code,
      address: asset.address,
      status: asset.status as Building['status'],
      created_at: asset.created_at as string,
      updated_at: asset.updated_at as string,
    };
  }

  const keys = [
    'id',
    'organization_id',
    'building_id',
    'name',
    'unit_code',
    'floor',
    'area_sqm',
    'status',
    'created_at',
    'updated_at',
  ];
  const area = asset.area_sqm;
  const areaValid =
    area === null ||
    (typeof area === 'number' && Number.isFinite(area) && area > 0) ||
    (typeof area === 'string' &&
      /^\d+(?:\.\d+)?$/.test(area) &&
      Number.isFinite(Number(area)) &&
      Number(area) > 0);
  if (
    Object.keys(asset).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(asset, key)) ||
    typeof asset.building_id !== 'string' ||
    asset.building_id.toLowerCase() !== parents.buildingId?.toLowerCase() ||
    !isNullableString(asset.unit_code) ||
    !isNullableString(asset.floor) ||
    !areaValid
  ) {
    return null;
  }
  return {
    id: asset.id as string,
    organization_id: asset.organization_id as string,
    building_id: asset.building_id,
    name: asset.name as string,
    unit_code: asset.unit_code,
    floor: asset.floor,
    area_sqm: area === null ? null : String(area),
    status: asset.status as Unit['status'],
    created_at: asset.created_at as string,
    updated_at: asset.updated_at as string,
  };
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

function parseEditablePortfolioPayload(
  value: unknown,
  patch: boolean,
): { name?: string; status?: 'active' | 'inactive' } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== 'name' && key !== 'status') ||
    (!patch && !Object.hasOwn(payload, 'name')) ||
    (patch && keys.length === 0)
  ) {
    return null;
  }
  const parsed: { name?: string; status?: 'active' | 'inactive' } = {};
  if (Object.hasOwn(payload, 'name')) {
    if (
      typeof payload.name !== 'string' ||
      payload.name.trim().length === 0 ||
      payload.name.trim().length > 200
    ) {
      return null;
    }
    parsed.name = payload.name.trim();
  }
  if (Object.hasOwn(payload, 'status')) {
    if (payload.status !== 'active' && payload.status !== 'inactive') {
      return null;
    }
    parsed.status = payload.status;
  }
  return parsed;
}

function parseEditableSitePayload(
  value: unknown,
  patch: boolean,
): { name?: string; address?: string | null; status?: 'active' | 'inactive' } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (
    keys.length === 0 ||
    keys.some((key) => !['name', 'address', 'status'].includes(key)) ||
    (!patch && !Object.hasOwn(payload, 'name'))
  ) {
    return null;
  }
  const parsed: {
    name?: string;
    address?: string | null;
    status?: 'active' | 'inactive';
  } = {};
  if (Object.hasOwn(payload, 'name')) {
    if (
      typeof payload.name !== 'string' ||
      payload.name.trim().length === 0 ||
      payload.name.trim().length > 200
    ) {
      return null;
    }
    parsed.name = payload.name.trim();
  }
  if (Object.hasOwn(payload, 'address')) {
    if (
      payload.address !== null &&
      (typeof payload.address !== 'string' || payload.address.length > 1000)
    ) {
      return null;
    }
    parsed.address =
      typeof payload.address === 'string' ? payload.address.trim() : null;
  }
  if (Object.hasOwn(payload, 'status')) {
    if (payload.status !== 'active' && payload.status !== 'inactive') {
      return null;
    }
    parsed.status = payload.status;
  }
  return parsed;
}

async function readWriteRequestBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.toLowerCase();
  if (!contentType || !/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new TypeError('Invalid portfolio request.');
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_WRITE_BODY_BYTES
    ) {
      throw new TypeError('Invalid portfolio request.');
    }
  }
  if (!request.body) throw new TypeError('Invalid portfolio request.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_WRITE_BODY_BYTES) {
        await reader.cancel();
        throw new TypeError('Invalid portfolio request.');
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

function isSameOriginWriteRequest(request: Request, appOrigin: URL): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  return (
    origin === appOrigin.origin &&
    (fetchSite === null || fetchSite === 'same-origin')
  );
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

  async function getHierarchy(
    request: Request,
    path: string,
    kind: HierarchyKind,
    collection: boolean,
    parents: HierarchyParents,
  ): Promise<Response> {
    const organizationId = requestedOrganizationId(new URL(request.url));
    if (
      !organizationId ||
      !UUID_PATTERN.test(parents.portfolioId) ||
      (parents.siteId !== undefined && !UUID_PATTERN.test(parents.siteId)) ||
      (parents.buildingId !== undefined && !UUID_PATTERN.test(parents.buildingId)) ||
      (parents.resourceId !== undefined && !UUID_PATTERN.test(parents.resourceId))
    ) {
      return errorResponse(400, 'Invalid asset request.');
    }

    try {
      const accessToken = await readAccessToken(
        request,
        dependencies.sessions,
        now,
      );
      if (!accessToken) return errorResponse(401, 'Authentication required.');

      const config = configuration();
      const upstreamUrl = new URL(path, config.baseUrl);
      upstreamUrl.searchParams.set('organization_id', organizationId);
      const upstream = await fetcher(upstreamUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + accessToken,
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
        return errorResponse(404, 'Asset not found.');
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

      if (collection) {
        if (!Array.isArray(payload) || payload.length > MAX_ASSETS) {
          return errorResponse(502, 'Invalid Property & Asset Registry response.');
        }
        const assets = payload.map((item) =>
          parseHierarchyAsset(item, kind, organizationId, parents),
        );
        if (assets.some((asset) => asset === null)) {
          return errorResponse(502, 'Invalid Property & Asset Registry response.');
        }
        return Response.json(assets, {
          headers: {
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
          },
        });
      }

      const asset = parseHierarchyAsset(payload, kind, organizationId, parents);
      if (!asset) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      return Response.json(asset, {
        headers: {
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      });
    } catch {
      return errorResponse(503, 'Property service unavailable.');
    }
  }

  async function getWritePermissions(request: Request): Promise<Response> {
    const organizationId = requestedOrganizationId(new URL(request.url));
    if (!organizationId) {
      return errorResponse(400, 'Invalid portfolio permissions request.');
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
        '/api/v1/portfolio-write-permissions',
        config.baseUrl,
      );
      upstreamUrl.searchParams.set('organization_id', organizationId);
      const upstream = await fetcher(upstreamUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + accessToken,
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
      if (
        !upstream.headers
          .get('content-type')
          ?.toLowerCase()
          .includes('application/json')
      ) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      let payload: unknown;
      try {
        payload = await readPortfolioPayload(upstream);
      } catch {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        Object.keys(payload).length !== 2 ||
        typeof (payload as Record<string, unknown>).can_create !== 'boolean' ||
        typeof (payload as Record<string, unknown>).can_update !== 'boolean'
      ) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      return Response.json(
        {
          can_create: (payload as Record<string, boolean>).can_create,
          can_update: (payload as Record<string, boolean>).can_update,
        },
        { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
      );
    } catch {
      return errorResponse(503, 'Property service unavailable.');
    }
  }

  async function getSiteWritePermissions(request: Request): Promise<Response> {
    const organizationId = requestedOrganizationId(new URL(request.url));
    if (!organizationId) {
      return errorResponse(400, 'Invalid site permissions request.');
    }
    try {
      const accessToken = await readAccessToken(
        request,
        dependencies.sessions,
        now,
      );
      if (!accessToken) return errorResponse(401, 'Authentication required.');

      const config = configuration();
      const upstreamUrl = new URL('/api/v1/site-write-permissions', config.baseUrl);
      upstreamUrl.searchParams.set('organization_id', organizationId);
      const upstream = await fetcher(upstreamUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + accessToken,
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
      if (
        !upstream.headers
          .get('content-type')
          ?.toLowerCase()
          .includes('application/json')
      ) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      let payload: unknown;
      try {
        payload = await readPortfolioPayload(upstream);
      } catch {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        Object.keys(payload).length !== 2 ||
        typeof (payload as Record<string, unknown>).can_create !== 'boolean' ||
        typeof (payload as Record<string, unknown>).can_update !== 'boolean'
      ) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      return Response.json(
        {
          can_create: (payload as Record<string, boolean>).can_create,
          can_update: (payload as Record<string, boolean>).can_update,
        },
        { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
      );
    } catch {
      return errorResponse(503, 'Property service unavailable.');
    }
  }

  async function writeSite(
    request: Request,
    method: 'POST' | 'PATCH',
    siteId?: string,
  ): Promise<Response> {
    const identifiers = requestedSiteIdentifiers(new URL(request.url));
    if (
      !identifiers ||
      (method === 'POST' && siteId !== undefined) ||
      (method === 'PATCH' &&
        (siteId === undefined || !UUID_PATTERN.test(siteId)))
    ) {
      return errorResponse(400, 'Invalid site request.');
    }

    try {
      const appOrigin = (dependencies.appOrigin ?? loadAppOrigin)();
      if (!isSameOriginWriteRequest(request, appOrigin)) {
        return errorResponse(403, 'Request origin is not allowed.');
      }
      let rawPayload: unknown;
      try {
        rawPayload = await readWriteRequestBody(request);
      } catch {
        return errorResponse(400, 'Invalid site request.');
      }
      const payload = parseEditableSitePayload(rawPayload, method === 'PATCH');
      if (!payload) return errorResponse(400, 'Invalid site request.');

      const accessToken = await readAccessToken(
        request,
        dependencies.sessions,
        now,
      );
      if (!accessToken) return errorResponse(401, 'Authentication required.');

      const config = configuration();
      const upstreamUrl = new URL(
        siteId === undefined
          ? '/api/v1/sites'
          : `/api/v1/sites/${encodeURIComponent(siteId)}`,
        config.baseUrl,
      );
      upstreamUrl.searchParams.set(
        'organization_id',
        identifiers.organizationId,
      );
      const upstreamPayload =
        method === 'POST'
          ? { ...payload, portfolio_id: identifiers.portfolioId }
          : payload;
      const upstream = await fetcher(upstreamUrl, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + accessToken,
        },
        body: JSON.stringify(upstreamPayload),
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (upstream.status === 401) {
        return errorResponse(401, 'Authentication required.');
      }
      if (upstream.status === 403) {
        return errorResponse(403, 'Site write access denied.');
      }
      if (upstream.status === 404) {
        return errorResponse(404, 'Site or parent portfolio not found.');
      }
      if (upstream.status === 422) {
        return errorResponse(400, 'Invalid site request.');
      }
      const expectedStatus = method === 'POST' ? 201 : 200;
      if (upstream.status !== expectedStatus || upstream.redirected) {
        return errorResponse(503, 'Property service unavailable.');
      }
      if (
        !upstream.headers
          .get('content-type')
          ?.toLowerCase()
          .includes('application/json')
      ) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      let responsePayload: unknown;
      try {
        responsePayload = await readPortfolioPayload(upstream);
      } catch {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      const site = parseHierarchyAsset(
        responsePayload,
        'site',
        identifiers.organizationId,
        {
          portfolioId: identifiers.portfolioId,
          ...(siteId === undefined ? {} : { resourceId: siteId }),
        },
      );
      if (!site || !('portfolio_id' in site)) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      return Response.json(site, {
        status: expectedStatus,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    } catch {
      return errorResponse(503, 'Property service unavailable.');
    }
  }

  async function writePortfolio(
    request: Request,
    method: 'POST' | 'PATCH',
    portfolioId?: string,
  ): Promise<Response> {
    const organizationId = requestedOrganizationId(new URL(request.url));
    if (
      !organizationId ||
      (method === 'POST' && portfolioId !== undefined) ||
      (method === 'PATCH' && portfolioId === undefined) ||
      (portfolioId !== undefined && !UUID_PATTERN.test(portfolioId))
    ) {
      return errorResponse(400, 'Invalid portfolio request.');
    }

    try {
      const appOrigin = (dependencies.appOrigin ?? loadAppOrigin)();
      if (!isSameOriginWriteRequest(request, appOrigin)) {
        return errorResponse(403, 'Request origin is not allowed.');
      }
      let rawPayload: unknown;
      try {
        rawPayload = await readWriteRequestBody(request);
      } catch {
        return errorResponse(400, 'Invalid portfolio request.');
      }
      const payload = parseEditablePortfolioPayload(
        rawPayload,
        method === 'PATCH',
      );
      if (!payload) return errorResponse(400, 'Invalid portfolio request.');

      const accessToken = await readAccessToken(
        request,
        dependencies.sessions,
        now,
      );
      if (!accessToken) return errorResponse(401, 'Authentication required.');

      const config = configuration();
      const path =
        portfolioId === undefined
          ? PORTFOLIOS_PATH
          : `${PORTFOLIOS_PATH}/${encodeURIComponent(portfolioId)}`;
      const upstreamUrl = new URL(path, config.baseUrl);
      upstreamUrl.searchParams.set('organization_id', organizationId);
      const upstream = await fetcher(upstreamUrl, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + accessToken,
        },
        body: JSON.stringify(payload),
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (upstream.status === 401) {
        return errorResponse(401, 'Authentication required.');
      }
      if (upstream.status === 403) {
        return errorResponse(403, 'Portfolio write access denied.');
      }
      if (upstream.status === 404) {
        return errorResponse(404, 'Portfolio not found.');
      }
      if (upstream.status === 422) {
        return errorResponse(400, 'Invalid portfolio request.');
      }
      const expectedStatus = method === 'POST' ? 201 : 200;
      if (upstream.status !== expectedStatus || upstream.redirected) {
        return errorResponse(503, 'Property service unavailable.');
      }
      if (
        !upstream.headers
          .get('content-type')
          ?.toLowerCase()
          .includes('application/json')
      ) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      let responsePayload: unknown;
      try {
        responsePayload = await readPortfolioPayload(upstream);
      } catch {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      const portfolios = parsePortfolios([responsePayload], organizationId);
      if (
        !portfolios ||
        (portfolioId !== undefined &&
          portfolios[0].id.toLowerCase() !== portfolioId.toLowerCase())
      ) {
        return errorResponse(502, 'Invalid Property & Asset Registry response.');
      }
      return Response.json(portfolios[0], {
        status: expectedStatus,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    } catch {
      return errorResponse(503, 'Property service unavailable.');
    }
  }

  return {
    getPortfolioWritePermissions(request: Request): Promise<Response> {
      return getWritePermissions(request);
    },
    getSiteWritePermissions(request: Request): Promise<Response> {
      return getSiteWritePermissions(request);
    },
    createPortfolio(request: Request): Promise<Response> {
      return writePortfolio(request, 'POST');
    },
    updatePortfolio(request: Request, portfolioId: string): Promise<Response> {
      return writePortfolio(request, 'PATCH', portfolioId);
    },
    createSite(request: Request): Promise<Response> {
      return writeSite(request, 'POST');
    },
    updateSite(request: Request, siteId: string): Promise<Response> {
      return writeSite(request, 'PATCH', siteId);
    },
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
            Authorization: 'Bearer ' + accessToken,
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
            Authorization: 'Bearer ' + accessToken,
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
    getSites(request: Request, portfolioId: string): Promise<Response> {
      return getHierarchy(
        request,
        `${PORTFOLIOS_PATH}/${encodeURIComponent(portfolioId)}/sites`,
        'site',
        true,
        { portfolioId },
      );
    },
    getSite(
      request: Request,
      portfolioId: string,
      siteId: string,
    ): Promise<Response> {
      return getHierarchy(
        request,
        `${PORTFOLIOS_PATH}/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}`,
        'site',
        false,
        { portfolioId, resourceId: siteId },
      );
    },
    getBuildings(
      request: Request,
      portfolioId: string,
      siteId: string,
    ): Promise<Response> {
      return getHierarchy(
        request,
        `${PORTFOLIOS_PATH}/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings`,
        'building',
        true,
        { portfolioId, siteId },
      );
    },
    getBuilding(
      request: Request,
      portfolioId: string,
      siteId: string,
      buildingId: string,
    ): Promise<Response> {
      return getHierarchy(
        request,
        `${PORTFOLIOS_PATH}/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}`,
        'building',
        false,
        { portfolioId, siteId, resourceId: buildingId },
      );
    },
    getUnits(
      request: Request,
      portfolioId: string,
      siteId: string,
      buildingId: string,
    ): Promise<Response> {
      return getHierarchy(
        request,
        `${PORTFOLIOS_PATH}/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}/units`,
        'unit',
        true,
        { portfolioId, siteId, buildingId },
      );
    },
    getUnit(
      request: Request,
      portfolioId: string,
      siteId: string,
      buildingId: string,
      unitId: string,
    ): Promise<Response> {
      return getHierarchy(
        request,
        `${PORTFOLIOS_PATH}/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}/units/${encodeURIComponent(unitId)}`,
        'unit',
        false,
        { portfolioId, siteId, buildingId, resourceId: unitId },
      );
    },
  };
}
