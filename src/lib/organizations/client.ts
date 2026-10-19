export type OrganizationChoice = {
  id: string;
  name: string;
};

export type OrganizationsPage = {
  organizations: OrganizationChoice[];
  next_cursor: string | null;
};

export class OrganizationsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OrganizationsRequestError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_PAGE_SIZE = 100;

export function parseOrganizationsPage(payload: unknown): OrganizationsPage {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new TypeError('Invalid organizations response.');
  }

  const page = payload as Record<string, unknown>;
  if (
    Object.keys(page).length !== 2 ||
    !Object.hasOwn(page, 'organizations') ||
    !Object.hasOwn(page, 'next_cursor') ||
    !Array.isArray(page.organizations) ||
    page.organizations.length > MAX_PAGE_SIZE
  ) {
    throw new TypeError('Invalid organizations response.');
  }

  const organizations: OrganizationChoice[] = [];
  const seenIds = new Set<string>();
  for (const value of page.organizations) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Invalid organizations response.');
    }
    const organization = value as Record<string, unknown>;
    if (
      Object.keys(organization).length !== 2 ||
      !Object.hasOwn(organization, 'id') ||
      !Object.hasOwn(organization, 'name') ||
      typeof organization.id !== 'string' ||
      !UUID_PATTERN.test(organization.id) ||
      typeof organization.name !== 'string' ||
      organization.name.trim().length === 0 ||
      organization.name.length > 200 ||
      seenIds.has(organization.id)
    ) {
      throw new TypeError('Invalid organizations response.');
    }
    seenIds.add(organization.id);
    organizations.push({
      id: organization.id,
      name: organization.name,
    });
  }

  const nextCursor = page.next_cursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== 'string' || !CURSOR_PATTERN.test(nextCursor))
  ) {
    throw new TypeError('Invalid organizations response.');
  }
  if (nextCursor !== null && organizations.length !== MAX_PAGE_SIZE) {
    throw new TypeError('Invalid organizations response.');
  }

  return { organizations, next_cursor: nextCursor };
}

export function organizationSelectionHref(
  organizationId: string | null,
  currentSearch = '',
): string {
  const params = new URLSearchParams(currentSearch);
  params.delete('organizationId');
  if (organizationId !== null) {
    if (!UUID_PATTERN.test(organizationId)) {
      throw new TypeError('Invalid organization ID.');
    }
    params.set('organizationId', organizationId);
  }
  const query = params.toString();
  return query ? `/organizations?${query}` : '/organizations';
}

export async function fetchOrganizationsPage(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<OrganizationsPage> {
  const params = new URLSearchParams({ limit: String(MAX_PAGE_SIZE) });
  if (cursor !== null) {
    if (!CURSOR_PATTERN.test(cursor)) {
      throw new TypeError('Invalid organization cursor.');
    }
    params.set('cursor', cursor);
  }

  let response: Response;
  try {
    response = await fetch(`/api/organizations?${params.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new OrganizationsRequestError(
      'Organizations could not be reached. Please try again.',
      0,
    );
  }

  if (response.status === 401) {
    throw new OrganizationsRequestError('Your session has expired.', 401);
  }
  if (!response.ok) {
    throw new OrganizationsRequestError(
      response.status === 403
        ? 'You do not have access to your organizations.'
        : 'Organizations are temporarily unavailable. Please try again.',
      response.status,
    );
  }

  try {
    return parseOrganizationsPage(await response.json());
  } catch {
    throw new OrganizationsRequestError(
      'The organizations response could not be verified.',
      502,
    );
  }
}
