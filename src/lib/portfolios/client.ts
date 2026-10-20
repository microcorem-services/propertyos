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

export type PortfolioWritePermissions = {
  can_create: boolean;
  can_update: boolean;
};

export type SiteWritePermissions = {
  can_create: boolean;
  can_update: boolean;
};

export type BuildingWritePermissions = {
  can_create: boolean;
  can_update: boolean;
};

export type UnitWritePermissions = {
  can_create: boolean;
  can_update: boolean;
};

export type PortfolioEditableFields = {
  name: string;
  status: 'active' | 'inactive';
};

export type SiteEditableFields = {
  name: string;
  address?: string | null;
  status: 'active' | 'inactive';
};

export type SiteUpdateFields = {
  name?: string;
  address?: string | null;
  status?: 'active' | 'inactive';
};

export type BuildingEditableFields = {
  name: string;
  building_code?: string | null;
  address?: string | null;
  status: 'active' | 'inactive';
};

export type BuildingUpdateFields = {
  name?: string;
  building_code?: string | null;
  address?: string | null;
  status?: 'active' | 'inactive';
};

export type UnitEditableFields = {
  name: string;
  unit_code?: string | null;
  floor?: string | null;
  area_sqm?: string | null;
  status: 'active' | 'inactive';
};

export type UnitUpdateFields = {
  name?: string;
  unit_code?: string | null;
  floor?: string | null;
  area_sqm?: string | null;
  status?: 'active' | 'inactive';
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
    ((typeof area === 'number' || typeof area === 'string') &&
      /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(String(area)) &&
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
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal,
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

export async function fetchPortfolioWritePermissions(
  organizationId: string,
  signal?: AbortSignal,
): Promise<PortfolioWritePermissions> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new PortfoliosRequestError('Choose a valid organisation first.', 400);
  }
  let response: Response;
  try {
    const query = new URLSearchParams({ organizationId });
    response = await fetch(`/api/portfolio-write-permissions?${query}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new PortfoliosRequestError(
      'Portfolio permissions could not be reached. Please try again.',
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
      'Portfolio permissions could not be verified.',
      response.status,
    );
  }
  try {
    const payload: unknown = await response.json();
    if (
      !isRecord(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof payload.can_create !== 'boolean' ||
      typeof payload.can_update !== 'boolean'
    ) {
      throw new TypeError();
    }
    return {
      can_create: payload.can_create,
      can_update: payload.can_update,
    };
  } catch {
    throw new PortfoliosRequestError(
      'Portfolio permissions could not be verified.',
      502,
    );
  }
}

async function writePortfolio(
  method: 'POST' | 'PATCH',
  organizationId: string,
  fields: Partial<PortfolioEditableFields>,
  portfolioId?: string,
): Promise<Portfolio> {
  if (
    !UUID_PATTERN.test(organizationId) ||
    (method === 'PATCH' && (!portfolioId || !UUID_PATTERN.test(portfolioId))) ||
    (method === 'POST' && portfolioId !== undefined)
  ) {
    throw new PortfoliosRequestError('Choose a valid portfolio first.', 400);
  }
  const keys = Object.keys(fields);
  const name = fields.name?.trim();
  if (
    keys.length === 0 ||
    keys.some((key) => key !== 'name' && key !== 'status') ||
    (fields.name !== undefined &&
      (!name || name.length > 200)) ||
    (fields.status !== undefined &&
      fields.status !== 'active' &&
      fields.status !== 'inactive') ||
    (method === 'POST' && !name)
  ) {
    throw new PortfoliosRequestError('Enter valid portfolio details.', 400);
  }
  const body: Partial<PortfolioEditableFields> = { ...fields };
  if (fields.name !== undefined) body.name = name;
  const query = new URLSearchParams({ organizationId });
  const path =
    method === 'POST'
      ? `/api/portfolios?${query}`
      : `/api/portfolios/${encodeURIComponent(portfolioId ?? '')}?${query}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PortfoliosRequestError(
      'Portfolio changes could not be submitted. Please try again.',
      0,
    );
  }
  if (response.status === 401) {
    throw new PortfoliosRequestError('Your session has expired.', 401);
  }
  if (response.status === 403) {
    throw new PortfoliosRequestError(
      'You do not have permission to change portfolios.',
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
        : 'Portfolio details could not be saved. Please review your changes.',
      response.status,
    );
  }
  try {
    const payload: unknown = await response.json();
    const expectedId =
      portfolioId ??
      (isRecord(payload) && typeof payload.id === 'string' ? payload.id : '');
    return parsePortfolio(payload, organizationId, expectedId);
  } catch {
    throw new PortfoliosRequestError(
      'The saved portfolio could not be verified.',
      502,
    );
  }
}

export function createPortfolio(
  organizationId: string,
  fields: PortfolioEditableFields,
): Promise<Portfolio> {
  return writePortfolio('POST', organizationId, fields);
}

export function updatePortfolio(
  portfolioId: string,
  organizationId: string,
  fields: Partial<PortfolioEditableFields>,
): Promise<Portfolio> {
  return writePortfolio('PATCH', organizationId, fields, portfolioId);
}

export async function fetchSiteWritePermissions(
  organizationId: string,
  signal?: AbortSignal,
): Promise<SiteWritePermissions> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new PortfoliosRequestError('Choose a valid organisation first.', 400);
  }
  let response: Response;
  try {
    const query = new URLSearchParams({ organizationId });
    response = await fetch(`/api/site-write-permissions?${query}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new PortfoliosRequestError(
      'Site permissions could not be reached. Please try again.',
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
      'Site permissions could not be verified.',
      response.status,
    );
  }
  try {
    const payload: unknown = await response.json();
    if (
      !isRecord(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof payload.can_create !== 'boolean' ||
      typeof payload.can_update !== 'boolean'
    ) {
      throw new TypeError();
    }
    return {
      can_create: payload.can_create,
      can_update: payload.can_update,
    };
  } catch {
    throw new PortfoliosRequestError(
      'Site permissions could not be verified.',
      502,
    );
  }
}

export async function fetchBuildingWritePermissions(
  organizationId: string,
  signal?: AbortSignal,
): Promise<BuildingWritePermissions> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new PortfoliosRequestError('Choose a valid organisation first.', 400);
  }
  let response: Response;
  try {
    const query = new URLSearchParams({ organizationId });
    response = await fetch(`/api/building-write-permissions?${query}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new PortfoliosRequestError(
      'Building permissions could not be reached. Please try again.',
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
      'Building permissions could not be verified.',
      response.status,
    );
  }
  try {
    const payload: unknown = await response.json();
    if (
      !isRecord(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof payload.can_create !== 'boolean' ||
      typeof payload.can_update !== 'boolean'
    ) {
      throw new TypeError();
    }
    return {
      can_create: payload.can_create,
      can_update: payload.can_update,
    };
  } catch {
    throw new PortfoliosRequestError(
      'Building permissions could not be verified.',
      502,
    );
  }
}

async function writeSite(
  method: 'POST' | 'PATCH',
  portfolioId: string,
  organizationId: string,
  fields: SiteEditableFields | SiteUpdateFields,
  siteId?: string,
): Promise<Site> {
  if (
    !UUID_PATTERN.test(portfolioId) ||
    !UUID_PATTERN.test(organizationId) ||
    (method === 'PATCH' && (!siteId || !UUID_PATTERN.test(siteId))) ||
    (method === 'POST' && siteId !== undefined)
  ) {
    throw new PortfoliosRequestError('Choose a valid site first.', 400);
  }
  const keys = Object.keys(fields);
  const name = fields.name?.trim();
  if (
    keys.length === 0 ||
    keys.some((key) => !['name', 'address', 'status'].includes(key)) ||
    (fields.name !== undefined && (!name || name.length > 200)) ||
    (fields.address !== undefined &&
      fields.address !== null &&
      (typeof fields.address !== 'string' || fields.address.length > 1000)) ||
    (fields.status !== undefined &&
      fields.status !== 'active' &&
      fields.status !== 'inactive') ||
    (method === 'POST' && !name)
  ) {
    throw new PortfoliosRequestError('Enter valid site details.', 400);
  }

  const body: SiteUpdateFields = { ...fields };
  if (fields.name !== undefined) body.name = name;
  if (typeof fields.address === 'string') body.address = fields.address.trim();
  const query = new URLSearchParams({ organizationId, portfolioId });
  const path =
    method === 'POST'
      ? `/api/sites?${query}`
      : `/api/sites/${encodeURIComponent(siteId ?? '')}?${query}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PortfoliosRequestError(
      'Site changes could not be submitted. Please try again.',
      0,
    );
  }
  if (response.status === 401) {
    throw new PortfoliosRequestError('Your session has expired.', 401);
  }
  if (response.status === 403) {
    throw new PortfoliosRequestError(
      'You do not have permission to change sites.',
      403,
    );
  }
  if (response.status === 404) {
    throw new PortfoliosRequestError('Site or portfolio not found.', 404);
  }
  if (!response.ok) {
    throw new PortfoliosRequestError(
      response.status === 503
        ? 'The property service is temporarily unavailable. Please try again.'
        : 'Site details could not be saved. Please review your changes.',
      response.status,
    );
  }
  try {
    const payload: unknown = await response.json();
    const asset = parseAsset(
      payload,
      'site',
      organizationId,
      {
        portfolioId,
        ...(siteId === undefined ? {} : { resourceId: siteId }),
      },
    );
    if (!('portfolio_id' in asset)) throw new TypeError();
    return asset;
  } catch {
    throw new PortfoliosRequestError(
      'The saved site could not be verified.',
      502,
    );
  }
}

export function createSite(
  portfolioId: string,
  organizationId: string,
  fields: SiteEditableFields,
): Promise<Site> {
  return writeSite('POST', portfolioId, organizationId, fields);
}

export function updateSite(
  siteId: string,
  portfolioId: string,
  organizationId: string,
  fields: SiteUpdateFields,
): Promise<Site> {
  return writeSite('PATCH', portfolioId, organizationId, fields, siteId);
}

async function writeBuilding(
  method: 'POST' | 'PATCH',
  portfolioId: string,
  siteId: string,
  organizationId: string,
  fields: BuildingEditableFields | BuildingUpdateFields,
  buildingId?: string,
): Promise<Building> {
  if (
    ![portfolioId, siteId, organizationId].every((id) => UUID_PATTERN.test(id)) ||
    (method === 'PATCH' &&
      (!buildingId || !UUID_PATTERN.test(buildingId))) ||
    (method === 'POST' && buildingId !== undefined)
  ) {
    throw new PortfoliosRequestError('Choose a valid building first.', 400);
  }
  const keys = Object.keys(fields);
  const name = fields.name?.trim();
  if (
    keys.length === 0 ||
    keys.some(
      (key) =>
        !['name', 'building_code', 'address', 'status'].includes(key),
    ) ||
    (fields.name !== undefined && (!name || name.length > 200)) ||
    (fields.building_code !== undefined &&
      fields.building_code !== null &&
      (typeof fields.building_code !== 'string' ||
        fields.building_code.length > 100)) ||
    (fields.address !== undefined &&
      fields.address !== null &&
      (typeof fields.address !== 'string' || fields.address.length > 1000)) ||
    (fields.status !== undefined &&
      fields.status !== 'active' &&
      fields.status !== 'inactive') ||
    (method === 'POST' && !name)
  ) {
    throw new PortfoliosRequestError('Enter valid building details.', 400);
  }

  const body: BuildingUpdateFields = { ...fields };
  if (fields.name !== undefined) body.name = name;
  if (typeof fields.building_code === 'string') {
    body.building_code = fields.building_code.trim() || null;
  }
  if (typeof fields.address === 'string') body.address = fields.address.trim() || null;
  const query = new URLSearchParams({ organizationId, portfolioId, siteId });
  const path =
    method === 'POST'
      ? `/api/buildings?${query}`
      : `/api/buildings/${encodeURIComponent(buildingId ?? '')}?${query}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PortfoliosRequestError(
      'Building changes could not be submitted. Please try again.',
      0,
    );
  }
  if (response.status === 401) {
    throw new PortfoliosRequestError('Your session has expired.', 401);
  }
  if (response.status === 403) {
    throw new PortfoliosRequestError(
      'You do not have permission to change buildings.',
      403,
    );
  }
  if (response.status === 404) {
    throw new PortfoliosRequestError('Building or parent asset not found.', 404);
  }
  if (!response.ok) {
    throw new PortfoliosRequestError(
      response.status === 503
        ? 'The property service is temporarily unavailable. Please try again.'
        : 'Building details could not be saved. Please review your changes.',
      response.status,
    );
  }
  try {
    const asset = parseAsset(
      await response.json(),
      'building',
      organizationId,
      { portfolioId, siteId },
      buildingId,
    );
    if (!('site_id' in asset)) throw new TypeError();
    return asset;
  } catch {
    throw new PortfoliosRequestError(
      'The saved building could not be verified.',
      502,
    );
  }
}

export function createBuilding(
  portfolioId: string,
  siteId: string,
  organizationId: string,
  fields: BuildingEditableFields,
): Promise<Building> {
  return writeBuilding('POST', portfolioId, siteId, organizationId, fields);
}

export function updateBuilding(
  buildingId: string,
  portfolioId: string,
  siteId: string,
  organizationId: string,
  fields: BuildingUpdateFields,
): Promise<Building> {
  return writeBuilding(
    'PATCH',
    portfolioId,
    siteId,
    organizationId,
    fields,
    buildingId,
  );
}

export async function fetchUnitWritePermissions(
  organizationId: string,
  signal?: AbortSignal,
): Promise<UnitWritePermissions> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new PortfoliosRequestError('Choose a valid organisation first.', 400);
  }
  let response: Response;
  try {
    const query = new URLSearchParams({ organizationId });
    response = await fetch(`/api/unit-write-permissions?${query}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new PortfoliosRequestError(
      'Unit permissions could not be reached. Please try again.',
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
      'Unit permissions could not be verified.',
      response.status,
    );
  }
  try {
    const payload: unknown = await response.json();
    if (
      !isRecord(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof payload.can_create !== 'boolean' ||
      typeof payload.can_update !== 'boolean'
    ) {
      throw new TypeError();
    }
    return { can_create: payload.can_create, can_update: payload.can_update };
  } catch {
    throw new PortfoliosRequestError(
      'Unit permissions could not be verified.',
      502,
    );
  }
}

async function writeUnit(
  method: 'POST' | 'PATCH',
  portfolioId: string,
  siteId: string,
  buildingId: string,
  organizationId: string,
  fields: UnitEditableFields | UnitUpdateFields,
  unitId?: string,
): Promise<Unit> {
  if (
    ![portfolioId, siteId, buildingId, organizationId].every((id) =>
      UUID_PATTERN.test(id),
    ) ||
    (method === 'PATCH' && (!unitId || !UUID_PATTERN.test(unitId))) ||
    (method === 'POST' && unitId !== undefined)
  ) {
    throw new PortfoliosRequestError('Choose a valid unit first.', 400);
  }
  const keys = Object.keys(fields);
  const name = fields.name?.trim();
  const area = fields.area_sqm;
  if (
    keys.length === 0 ||
    keys.some(
      (key) =>
        !['name', 'unit_code', 'floor', 'area_sqm', 'status'].includes(key),
    ) ||
    (fields.name !== undefined && (!name || name.length > 200)) ||
    (fields.unit_code !== undefined &&
      fields.unit_code !== null &&
      (typeof fields.unit_code !== 'string' || fields.unit_code.length > 100)) ||
    (fields.floor !== undefined &&
      fields.floor !== null &&
      (typeof fields.floor !== 'string' || fields.floor.length > 50)) ||
    (area !== undefined &&
      area !== null &&
      (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(area) ||
        !Number.isFinite(Number(area)) ||
        Number(area) <= 0)) ||
    (fields.status !== undefined &&
      fields.status !== 'active' &&
      fields.status !== 'inactive') ||
    (method === 'POST' && !name)
  ) {
    throw new PortfoliosRequestError('Enter valid unit details.', 400);
  }

  const body: UnitUpdateFields = { ...fields };
  if (fields.name !== undefined) body.name = name;
  if (typeof fields.unit_code === 'string') {
    body.unit_code = fields.unit_code.trim() || null;
  }
  if (typeof fields.floor === 'string') body.floor = fields.floor.trim() || null;
  if (typeof fields.area_sqm === 'string') body.area_sqm = fields.area_sqm.trim();
  const query = new URLSearchParams({
    organizationId,
    portfolioId,
    siteId,
    buildingId,
  });
  const collectionPath = `/api/portfolios/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}/units`;
  const path =
    method === 'POST'
      ? `${collectionPath}?${query}`
      : `${collectionPath}/${encodeURIComponent(unitId ?? '')}?${query}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PortfoliosRequestError(
      'Unit changes could not be submitted. Please try again.',
      0,
    );
  }
  if (response.status === 401) {
    throw new PortfoliosRequestError('Your session has expired.', 401);
  }
  if (response.status === 403) {
    throw new PortfoliosRequestError(
      'You do not have permission to change units.',
      403,
    );
  }
  if (response.status === 404) {
    throw new PortfoliosRequestError('Unit or parent asset not found.', 404);
  }
  if (!response.ok) {
    throw new PortfoliosRequestError(
      response.status === 503
        ? 'The property service is temporarily unavailable. Please try again.'
        : 'Unit details could not be saved. Please review your changes.',
      response.status,
    );
  }
  try {
    const asset = parseAsset(
      await response.json(),
      'unit',
      organizationId,
      { portfolioId, siteId, buildingId },
      unitId,
    );
    if (!('building_id' in asset)) throw new TypeError();
    return asset;
  } catch {
    throw new PortfoliosRequestError(
      'The saved unit could not be verified.',
      502,
    );
  }
}

export function createUnit(
  portfolioId: string,
  siteId: string,
  buildingId: string,
  organizationId: string,
  fields: UnitEditableFields,
): Promise<Unit> {
  return writeUnit(
    'POST',
    portfolioId,
    siteId,
    buildingId,
    organizationId,
    fields,
  );
}

export function updateUnit(
  unitId: string,
  portfolioId: string,
  siteId: string,
  buildingId: string,
  organizationId: string,
  fields: UnitUpdateFields,
): Promise<Unit> {
  return writeUnit(
    'PATCH',
    portfolioId,
    siteId,
    buildingId,
    organizationId,
    fields,
    unitId,
  );
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
  signal?: AbortSignal,
): Promise<Site> {
  if (!UUID_PATTERN.test(siteId)) {
    throw new PortfoliosRequestError('Choose a valid site first.', 400);
  }
  const path = assetPath(
    portfolioId,
    `/${encodeURIComponent(siteId)}`,
    organizationId,
  );
  return fetchAssetResponse(
    path,
    (payload) =>
      parseAsset(
        payload,
        'site',
        organizationId,
        { portfolioId },
        siteId,
      ) as Site,
    signal,
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
