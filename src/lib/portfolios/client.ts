export type Portfolio = {
  id: string;
  organization_id: string;
  name: string;
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
