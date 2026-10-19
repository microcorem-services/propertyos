export type Portfolio = {
  id: string;
  organization_id: string;
  name: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
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

export class PortfoliosRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PortfoliosRequestError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PORTFOLIOS = 1_000;
const MAX_ASSETS = 1_000;
const ACTIVE_STATUSES = new Set(['active', 'inactive']);
const SITE_FIELDS = [
  'id',
  'organization_id',
  'portfolio_id',
  'name',
  'address',
  'status',
  'created_at',
  'updated_at',
];
const BUILDING_FIELDS = [
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
const UNIT_FIELDS = [
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

type AssetKind = 'site' | 'building' | 'unit';
type CommonAssetRecord = Record<string, unknown> & {
  id: string;
  organization_id: string;
  name: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function hasCommonAssetFields(
  value: Record<string, unknown>,
  organizationId: string,
): value is CommonAssetRecord {
  return (
    typeof value.id === 'string' &&
    UUID_PATTERN.test(value.id) &&
    typeof value.organization_id === 'string' &&
    value.organization_id.toLowerCase() === organizationId.toLowerCase() &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= 200 &&
    typeof value.status === 'string' &&
    ACTIVE_STATUSES.has(value.status) &&
    typeof value.created_at === 'string' &&
    TIMESTAMP_PATTERN.test(value.created_at) &&
    Number.isFinite(Date.parse(value.created_at)) &&
    typeof value.updated_at === 'string' &&
    TIMESTAMP_PATTERN.test(value.updated_at) &&
    Number.isFinite(Date.parse(value.updated_at))
  );
}

function parseAsset(
  value: unknown,
  kind: AssetKind,
  organizationId: string,
  parents: { portfolioId: string; siteId?: string; buildingId?: string },
  expectedId?: string,
): Site | Building | Unit {
  if (!isRecord(value) || !hasCommonAssetFields(value, organizationId)) {
    throw new TypeError('Invalid asset response.');
  }
  if (expectedId && value.id.toLowerCase() !== expectedId.toLowerCase()) {
    throw new TypeError('Invalid asset response.');
  }

  if (kind === 'site') {
    if (
      !hasExactFields(value, SITE_FIELDS) ||
      typeof value.portfolio_id !== 'string' ||
      value.portfolio_id.toLowerCase() !== parents.portfolioId.toLowerCase() ||
      !(value.address === null || typeof value.address === 'string')
    ) {
      throw new TypeError('Invalid site response.');
    }
    return {
      id: value.id,
      organization_id: value.organization_id,
      portfolio_id: value.portfolio_id,
      name: value.name,
      address: value.address,
      status: value.status,
      created_at: value.created_at,
      updated_at: value.updated_at,
    };
  }
  if (kind === 'building') {
    if (
      !hasExactFields(value, BUILDING_FIELDS) ||
      typeof value.site_id !== 'string' ||
      value.site_id.toLowerCase() !== parents.siteId?.toLowerCase() ||
      !(value.building_code === null || typeof value.building_code === 'string') ||
      !(value.address === null || typeof value.address === 'string')
    ) {
      throw new TypeError('Invalid building response.');
    }
    return {
      id: value.id,
      organization_id: value.organization_id,
      site_id: value.site_id,
      name: value.name,
      building_code: value.building_code,
      address: value.address,
      status: value.status,
      created_at: value.created_at,
      updated_at: value.updated_at,
    };
  }

  const area = value.area_sqm;
  const validArea =
    area === null ||
    (typeof area === 'number' && Number.isFinite(area) && area > 0) ||
    (typeof area === 'string' &&
      /^\d+(?:\.\d+)?$/.test(area) &&
      Number.isFinite(Number(area)) &&
      Number(area) > 0);
  if (
    !hasExactFields(value, UNIT_FIELDS) ||
    typeof value.building_id !== 'string' ||
    value.building_id.toLowerCase() !== parents.buildingId?.toLowerCase() ||
    !(value.unit_code === null || typeof value.unit_code === 'string') ||
    !(value.floor === null || typeof value.floor === 'string') ||
    !validArea
  ) {
    throw new TypeError('Invalid unit response.');
  }
  return {
    id: value.id,
    organization_id: value.organization_id,
    building_id: value.building_id,
    name: value.name,
    unit_code: value.unit_code,
    floor: value.floor,
    status: value.status,
    created_at: value.created_at,
    updated_at: value.updated_at,
    area_sqm: area === null ? null : String(area),
  };
}

export function siteHref(
  portfolioId: string,
  siteId: string,
  organizationId: string,
): string {
  if (![portfolioId, siteId, organizationId].every((id) => UUID_PATTERN.test(id))) {
    throw new TypeError('Invalid site URL.');
  }
  return `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}?organizationId=${encodeURIComponent(organizationId)}`;
}

export function buildingHref(
  portfolioId: string,
  siteId: string,
  buildingId: string,
  organizationId: string,
): string {
  if (![portfolioId, siteId, buildingId, organizationId].every((id) => UUID_PATTERN.test(id))) {
    throw new TypeError('Invalid building URL.');
  }
  return `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}?organizationId=${encodeURIComponent(organizationId)}`;
}

export function unitHref(
  portfolioId: string,
  siteId: string,
  buildingId: string,
  unitId: string,
  organizationId: string,
): string {
  if (![portfolioId, siteId, buildingId, unitId, organizationId].every((id) => UUID_PATTERN.test(id))) {
    throw new TypeError('Invalid unit URL.');
  }
  return `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}/units/${encodeURIComponent(unitId)}?organizationId=${encodeURIComponent(organizationId)}`;
}

async function fetchAssetResponse<T>(
  path: string,
  parse: (payload: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new PortfoliosRequestError(
      'Property details could not be reached. Please try again.',
      0,
    );
  }

  if (response.status === 401) {
    throw new PortfoliosRequestError('Your session has expired.', 401);
  }
  if (response.status === 403) {
    throw new PortfoliosRequestError(
      'You do not have access to this organisation.',
      403,
    );
  }
  if (response.status === 404) {
    throw new PortfoliosRequestError('Asset not found.', 404);
  }
  if (!response.ok) {
    throw new PortfoliosRequestError(
      response.status === 503
        ? 'The property service is temporarily unavailable. Please try again.'
        : 'Property details could not be loaded. Please try again.',
      response.status,
    );
  }

  try {
    return parse(await response.json());
  } catch {
    throw new PortfoliosRequestError(
      'The property response could not be verified.',
      502,
    );
  }
}

function assetPath(
  portfolioId: string,
  suffix: string,
  organizationId: string,
): string {
  if (!UUID_PATTERN.test(portfolioId) || !UUID_PATTERN.test(organizationId)) {
    throw new PortfoliosRequestError('Choose a valid organisation first.', 400);
  }
  const query = new URLSearchParams({ organizationId });
  return `/api/portfolios/${encodeURIComponent(portfolioId)}/sites${suffix}?${query}`;
}

function parseAssetCollection<T extends Site | Building | Unit>(
  payload: unknown,
  kind: AssetKind,
  organizationId: string,
  parents: { portfolioId: string; siteId?: string; buildingId?: string },
): T[] {
  if (!Array.isArray(payload) || payload.length > MAX_ASSETS) {
    throw new TypeError('Invalid asset collection response.');
  }
  const seen = new Set<string>();
  return payload.map((item) => {
    const asset = parseAsset(item, kind, organizationId, parents);
    if (seen.has(asset.id)) throw new TypeError('Duplicate asset response.');
    seen.add(asset.id);
    return asset as T;
  });
}

export function parsePortfolioOrganizationId(search: string): string | null {
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== 'organizationId') return null;
  const values = params.getAll('organizationId');
  return values.length === 1 && UUID_PATTERN.test(values[0])
    ? values[0]
    : null;
}

export function portfolioDetailHref(
  portfolioId: string,
  organizationId: string,
): string {
  if (!UUID_PATTERN.test(portfolioId) || !UUID_PATTERN.test(organizationId)) {
    throw new TypeError('Invalid portfolio detail URL.');
  }
  return `/portfolio/${encodeURIComponent(portfolioId)}?organizationId=${encodeURIComponent(organizationId)}`;
}

export function parsePortfolio(
  payload: unknown,
  organizationId: string,
  portfolioId: string,
): Portfolio {
  const portfolios = parsePortfolios([payload], organizationId);
  const portfolio = portfolios[0];
  if (!portfolio || portfolio.id.toLowerCase() !== portfolioId.toLowerCase()) {
    throw new TypeError('Invalid portfolio response.');
  }
  return portfolio;
}

function parsePortfolios(payload: unknown, organizationId: string): Portfolio[] {
  if (!Array.isArray(payload) || payload.length > MAX_PORTFOLIOS) {
    throw new TypeError('Invalid portfolios response.');
  }

  const portfolios: Portfolio[] = [];
  const seenIds = new Set<string>();
  for (const value of payload) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Invalid portfolios response.');
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
      (portfolio.status !== 'active' && portfolio.status !== 'inactive') ||
      typeof portfolio.created_at !== 'string' ||
      !TIMESTAMP_PATTERN.test(portfolio.created_at) ||
      !Number.isFinite(Date.parse(portfolio.created_at)) ||
      typeof portfolio.updated_at !== 'string' ||
      !TIMESTAMP_PATTERN.test(portfolio.updated_at) ||
      !Number.isFinite(Date.parse(portfolio.updated_at))
    ) {
      throw new TypeError('Invalid portfolios response.');
    }

    seenIds.add(portfolio.id);
    portfolios.push({
      id: portfolio.id,
      organization_id: portfolio.organization_id,
      name: portfolio.name,
      status: portfolio.status,
      created_at: portfolio.created_at,
      updated_at: portfolio.updated_at,
    });
  }
  return portfolios;
}

export async function fetchPortfolios(
  organizationId: string,
  signal?: AbortSignal,
): Promise<Portfolio[]> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new PortfoliosRequestError('Choose a valid organisation first.', 400);
  }

  let response: Response;
  try {
    const params = new URLSearchParams({ organizationId });
    response = await fetch(`/api/portfolios?${params.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new PortfoliosRequestError(
      'Portfolios could not be reached. Please try again.',
      0,
    );
  }

  if (response.status === 401) {
    throw new PortfoliosRequestError('Your session has expired.', 401);
  }
  if (response.status === 403) {
    throw new PortfoliosRequestError(
      'You do not have access to this organisation.',
      403,
    );
  }
  if (!response.ok) {
    throw new PortfoliosRequestError(
      response.status === 503
        ? 'The portfolio service is temporarily unavailable. Please try again.'
        : 'Portfolios could not be loaded. Please try again.',
      response.status,
    );
  }

  try {
    return parsePortfolios(await response.json(), organizationId);
  } catch {
    throw new PortfoliosRequestError(
      'The portfolio response could not be verified.',
      502,
    );
  }
}

export async function fetchPortfolio(
  portfolioId: string,
  organizationId: string,
  signal?: AbortSignal,
): Promise<Portfolio> {
  if (!UUID_PATTERN.test(portfolioId) || !UUID_PATTERN.test(organizationId)) {
    throw new PortfoliosRequestError('Choose a valid portfolio first.', 400);
  }

  let response: Response;
  try {
    const params = new URLSearchParams({ organizationId });
    response = await fetch(
      `/api/portfolios/${encodeURIComponent(portfolioId)}?${params.toString()}`,
      {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal,
      },
    );
  } catch {
    throw new PortfoliosRequestError(
      'Portfolio details could not be reached. Please try again.',
      0,
    );
  }

  if (response.status === 401) {
    throw new PortfoliosRequestError('Your session has expired.', 401);
  }
  if (response.status === 403) {
    throw new PortfoliosRequestError(
      'You do not have access to this organisation.',
      403,
    );
  }
  if (response.status === 404) {
    throw new PortfoliosRequestError('Portfolio not found.', 404);
  }
  if (!response.ok) {
    throw new PortfoliosRequestError(
      response.status === 503
        ? 'The portfolio service is temporarily unavailable. Please try again.'
        : 'Portfolio details could not be loaded. Please try again.',
      response.status,
    );
  }

  try {
    return parsePortfolio(await response.json(), organizationId, portfolioId);
  } catch {
    throw new PortfoliosRequestError(
      'The portfolio response could not be verified.',
      502,
    );
  }
}

export function fetchSites(
  portfolioId: string,
  organizationId: string,
): Promise<Site[]> {
  const path = assetPath(portfolioId, '', organizationId);
  return fetchAssetResponse(path, (payload) =>
    parseAssetCollection<Site>(payload, 'site', organizationId, { portfolioId }),
  );
}

export function fetchSite(
  portfolioId: string,
  siteId: string,
  organizationId: string,
): Promise<Site> {
  if (!UUID_PATTERN.test(siteId)) {
    throw new PortfoliosRequestError('Choose a valid site first.', 400);
  }
  const path = assetPath(
    portfolioId,
    `/${encodeURIComponent(siteId)}`,
    organizationId,
  );
  return fetchAssetResponse(path, (payload) =>
    parseAsset(payload, 'site', organizationId, { portfolioId }, siteId) as Site,
  );
}

export function fetchBuildings(
  portfolioId: string,
  siteId: string,
  organizationId: string,
): Promise<Building[]> {
  if (!UUID_PATTERN.test(siteId)) {
    throw new PortfoliosRequestError('Choose a valid site first.', 400);
  }
  const path = assetPath(
    portfolioId,
    `/${encodeURIComponent(siteId)}/buildings`,
    organizationId,
  );
  return fetchAssetResponse(path, (payload) =>
    parseAssetCollection<Building>(payload, 'building', organizationId, {
      portfolioId,
      siteId,
    }),
  );
}

export function fetchBuilding(
  portfolioId: string,
  siteId: string,
  buildingId: string,
  organizationId: string,
): Promise<Building> {
  if (!UUID_PATTERN.test(siteId) || !UUID_PATTERN.test(buildingId)) {
    throw new PortfoliosRequestError('Choose a valid building first.', 400);
  }
  const path = assetPath(
    portfolioId,
    `/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}`,
    organizationId,
  );
  return fetchAssetResponse(path, (payload) =>
    parseAsset(
      payload,
      'building',
      organizationId,
      { portfolioId, siteId },
      buildingId,
    ) as Building,
  );
}

export function fetchUnits(
  portfolioId: string,
  siteId: string,
  buildingId: string,
  organizationId: string,
): Promise<Unit[]> {
  if (!UUID_PATTERN.test(siteId) || !UUID_PATTERN.test(buildingId)) {
    throw new PortfoliosRequestError('Choose a valid building first.', 400);
  }
  const path = assetPath(
    portfolioId,
    `/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}/units`,
    organizationId,
  );
  return fetchAssetResponse(path, (payload) =>
    parseAssetCollection<Unit>(payload, 'unit', organizationId, {
      portfolioId,
      siteId,
      buildingId,
    }),
  );
}

export function fetchUnit(
  portfolioId: string,
  siteId: string,
  buildingId: string,
  unitId: string,
  organizationId: string,
): Promise<Unit> {
  if (
    !UUID_PATTERN.test(siteId) ||
    !UUID_PATTERN.test(buildingId) ||
    !UUID_PATTERN.test(unitId)
  ) {
    throw new PortfoliosRequestError('Choose a valid unit first.', 400);
  }
  const path = assetPath(
    portfolioId,
    `/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}/units/${encodeURIComponent(unitId)}`,
    organizationId,
  );
  return fetchAssetResponse(path, (payload) =>
    parseAsset(
      payload,
      'unit',
      organizationId,
      { portfolioId, siteId, buildingId },
      unitId,
    ) as Unit,
  );
}
