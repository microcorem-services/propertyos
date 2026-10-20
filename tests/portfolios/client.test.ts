import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchPortfolio,
  fetchPortfolioWritePermissions,
  fetchPortfolios,
  createPortfolio,
  updatePortfolio,
  fetchSite,
  fetchSites,
  fetchBuilding,
  fetchBuildings,
  fetchUnit,
  fetchUnits,
  parsePortfolioOrganizationId,
  portfolioDetailHref,
  siteHref,
  buildingHref,
  unitHref,
  PortfoliosRequestError,
  type Building,
  type Portfolio,
  type Site,
  type Unit,
} from '../../src/lib/portfolios/client';

const organizationId = '00000000-0000-4000-8000-000000000001';
const portfolio: Portfolio = {
  id: '00000000-0000-4000-8000-000000000101',
  organization_id: organizationId,
  name: 'Test portfolio',
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};
const site: Site = {
  id: '00000000-0000-4000-8000-000000000201',
  organization_id: organizationId,
  portfolio_id: portfolio.id,
  name: 'North Grounds',
  address: 'Example Road',
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};
const building: Building = {
  id: '00000000-0000-4000-8000-000000000301',
  organization_id: organizationId,
  site_id: site.id,
  name: 'Main House',
  building_code: 'MH',
  address: null,
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};
const unit: Unit = {
  id: '00000000-0000-4000-8000-000000000401',
  organization_id: organizationId,
  building_id: building.id,
  name: 'Suite 4',
  unit_code: 'S4',
  floor: '4',
  area_sqm: '42.50',
  status: 'active',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-02-03T04:05:06+00:00',
};

test('accepts only one valid organisation ID in the page URL', () => {
  assert.equal(
    parsePortfolioOrganizationId(`?organizationId=${organizationId}`),
    organizationId,
  );
  for (const query of [
    '',
    '?organizationId=not-a-uuid',
    `?organizationId=${organizationId}&organizationId=${organizationId}`,
    `?organizationId=${organizationId}&subject=private`,
  ]) {
    assert.equal(parsePortfolioOrganizationId(query), null);
  }
});

test('builds portfolio detail URLs from validated identifiers', () => {
  assert.equal(
    portfolioDetailHref(portfolio.id, organizationId),
    `/portfolio/${portfolio.id}?organizationId=${organizationId}`,
  );
  assert.throws(() => portfolioDetailHref('not-a-uuid', organizationId));
  assert.throws(() => portfolioDetailHref(portfolio.id, 'not-a-uuid'));
});

test('validates portfolio response fields and organisation ownership', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json([portfolio]);
    assert.deepEqual(await fetchPortfolios(organizationId), [portfolio]);

    for (const invalid of [
      [{ ...portfolio, private_field: 'secret' }],
      [{ ...portfolio, organization_id: '00000000-0000-4000-8000-000000000002' }],
      [{ ...portfolio, status: 'pending' }],
      [{ ...portfolio, updated_at: 'not-a-date' }],
      [portfolio, portfolio],
    ]) {
      globalThis.fetch = async () => Response.json(invalid);
      await assert.rejects(
        fetchPortfolios(organizationId),
        (error: unknown) =>
          error instanceof PortfoliosRequestError && error.status === 502,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requests only the same-origin portfolio BFF without caching', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  let options: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    options = init;
    return Response.json([portfolio]);
  };
  try {
    await fetchPortfolios(organizationId);
    assert.equal(url, `/api/portfolios?organizationId=${organizationId}`);
    assert.equal(options?.method, 'GET');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.redirect, 'error');
    assert.deepEqual([...new Headers(options?.headers).keys()], ['accept']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps expired sessions, forbidden access and service failures to safe messages', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, expectedStatus] of [
      [401, 401],
      [403, 403],
      [503, 503],
    ]) {
      globalThis.fetch = async () =>
        Response.json({ error: 'sensitive upstream detail' }, { status });
      await assert.rejects(
        fetchPortfolios(organizationId),
        (error: unknown) =>
          error instanceof PortfoliosRequestError &&
          error.status === expectedStatus &&
          !error.message.includes('sensitive upstream detail'),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetches a single portfolio only from the same-origin detail BFF', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  let options: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    options = init;
    return Response.json(portfolio);
  };
  try {
    assert.deepEqual(
      await fetchPortfolio(portfolio.id, organizationId),
      portfolio,
    );
    assert.equal(
      url,
      `/api/portfolios/${portfolio.id}?organizationId=${organizationId}`,
    );
    assert.equal(options?.method, 'GET');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.redirect, 'error');
    assert.deepEqual([...new Headers(options?.headers).keys()], ['accept']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects incorrect portfolio IDs, wrong organization records and detail errors', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const invalid of [
      { ...portfolio, id: '00000000-0000-4000-8000-000000000102' },
      { ...portfolio, organization_id: '00000000-0000-4000-8000-000000000002' },
      { ...portfolio, private_field: 'sensitive' },
    ]) {
      globalThis.fetch = async () => Response.json(invalid);
      await assert.rejects(
        fetchPortfolio(portfolio.id, organizationId),
        (error: unknown) =>
          error instanceof PortfoliosRequestError && error.status === 502,
      );
    }

    for (const [status, expectedStatus] of [
      [401, 401],
      [403, 403],
      [404, 404],
      [503, 503],
    ]) {
      globalThis.fetch = async () =>
        Response.json({ error: 'sensitive Registry detail' }, { status });
      await assert.rejects(
        fetchPortfolio(portfolio.id, organizationId),
        (error: unknown) =>
          error instanceof PortfoliosRequestError &&
          error.status === expectedStatus &&
          !error.message.includes('sensitive Registry detail'),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reads validated portfolio write capabilities from the same-origin BFF', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  let options: RequestInit | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      url = String(input);
      options = init;
      return Response.json({ can_create: true, can_update: false });
    };
    assert.deepEqual(await fetchPortfolioWritePermissions(organizationId), {
      can_create: true,
      can_update: false,
    });
    assert.equal(
      url,
      `/api/portfolio-write-permissions?organizationId=${organizationId}`,
    );
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.redirect, 'error');

    globalThis.fetch = async () =>
      Response.json({ can_create: true, can_update: false, role: 'admin' });
    await assert.rejects(
      fetchPortfolioWritePermissions(organizationId),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('creates and updates portfolios using only editable fields and verifies responses', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ ...portfolio, name: 'Renamed portfolio' });
    };
    assert.deepEqual(
      await createPortfolio(organizationId, {
        name: 'Renamed portfolio',
        status: 'active',
      }),
      { ...portfolio, name: 'Renamed portfolio' },
    );
    assert.deepEqual(
      await updatePortfolio(portfolio.id, organizationId, {
        name: 'Renamed portfolio',
      }),
      { ...portfolio, name: 'Renamed portfolio' },
    );
    assert.equal(calls[0].url, `/api/portfolios?organizationId=${organizationId}`);
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(calls[1].url, `/api/portfolios/${portfolio.id}?organizationId=${organizationId}`);
    assert.equal(calls[1].init?.method, 'PATCH');
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.equal(calls[0].init?.cache, 'no-store');
    assert.equal(calls[0].init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      name: 'Renamed portfolio',
      status: 'active',
    });
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
      name: 'Renamed portfolio',
    });
    for (const invalid of [
      () => createPortfolio(organizationId, { name: ' ', status: 'active' }),
      () => createPortfolio(organizationId, { name: 'Name', status: 'active', organization_id: organizationId } as never),
      () => updatePortfolio('not-a-uuid', organizationId, { name: 'Name' }),
      () => updatePortfolio(portfolio.id, organizationId, { status: 'pending' } as never),
    ]) {
      await assert.rejects(invalid, PortfoliosRequestError);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('builds hierarchy links from validated parent and child IDs', () => {
  assert.equal(
    siteHref(portfolio.id, site.id, organizationId),
    `/portfolio/${portfolio.id}/sites/${site.id}?organizationId=${organizationId}`,
  );
  assert.equal(
    buildingHref(portfolio.id, site.id, building.id, organizationId),
    `/portfolio/${portfolio.id}/sites/${site.id}/buildings/${building.id}?organizationId=${organizationId}`,
  );
  assert.equal(
    unitHref(portfolio.id, site.id, building.id, unit.id, organizationId),
    `/portfolio/${portfolio.id}/sites/${site.id}/buildings/${building.id}/units/${unit.id}?organizationId=${organizationId}`,
  );
  assert.throws(() => siteHref('invalid', site.id, organizationId));
  assert.throws(() =>
    buildingHref(portfolio.id, site.id, 'invalid', organizationId),
  );
});

test('fetches hierarchy only from same-origin BFF routes and validates ownership', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const responses: unknown[] = [[site], site, [building], building, [unit], unit];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return Response.json(responses.shift());
  };
  try {
    assert.deepEqual(await fetchSites(portfolio.id, organizationId), [site]);
    assert.deepEqual(await fetchSite(portfolio.id, site.id, organizationId), site);
    assert.deepEqual(
      await fetchBuildings(portfolio.id, site.id, organizationId),
      [building],
    );
    assert.deepEqual(
      await fetchBuilding(portfolio.id, site.id, building.id, organizationId),
      building,
    );
    assert.deepEqual(
      await fetchUnits(portfolio.id, site.id, building.id, organizationId),
      [unit],
    );
    assert.deepEqual(
      await fetchUnit(
        portfolio.id,
        site.id,
        building.id,
        unit.id,
        organizationId,
      ),
      unit,
    );

    assert.deepEqual(
      calls.map(({ url }) => url),
      [
        `/api/portfolios/${portfolio.id}/sites?organizationId=${organizationId}`,
        `/api/portfolios/${portfolio.id}/sites/${site.id}?organizationId=${organizationId}`,
        `/api/portfolios/${portfolio.id}/sites/${site.id}/buildings?organizationId=${organizationId}`,
        `/api/portfolios/${portfolio.id}/sites/${site.id}/buildings/${building.id}?organizationId=${organizationId}`,
        `/api/portfolios/${portfolio.id}/sites/${site.id}/buildings/${building.id}/units?organizationId=${organizationId}`,
        `/api/portfolios/${portfolio.id}/sites/${site.id}/buildings/${building.id}/units/${unit.id}?organizationId=${organizationId}`,
      ],
    );
    for (const call of calls) {
      assert.equal(call.options?.credentials, 'same-origin');
      assert.equal(call.options?.cache, 'no-store');
      assert.equal(call.options?.redirect, 'error');
      assert.deepEqual([...new Headers(call.options?.headers).keys()], ['accept']);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects cross-parent, cross-organization and unexpected asset fields', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const invalid of [
      { ...site, portfolio_id: '00000000-0000-4000-8000-000000000099' },
      { ...site, organization_id: '00000000-0000-4000-8000-000000000099' },
      { ...site, secret: 'private' },
    ]) {
      globalThis.fetch = async () => Response.json([invalid]);
      await assert.rejects(
        fetchSites(portfolio.id, organizationId),
        (error: unknown) =>
          error instanceof PortfoliosRequestError && error.status === 502,
      );
    }
    globalThis.fetch = async () =>
      Response.json({ ...unit, building_id: site.id });
    await assert.rejects(
      fetchUnit(
        portfolio.id,
        site.id,
        building.id,
        unit.id,
        organizationId,
      ),
      (error: unknown) =>
        error instanceof PortfoliosRequestError && error.status === 502,
    );

    for (const [status, expectedStatus] of [
      [401, 401],
      [403, 403],
      [404, 404],
      [503, 503],
    ]) {
      globalThis.fetch = async () =>
        Response.json({ error: 'private upstream detail' }, { status });
      await assert.rejects(
        fetchBuilding(portfolio.id, site.id, building.id, organizationId),
        (error: unknown) =>
          error instanceof PortfoliosRequestError &&
          error.status === expectedStatus &&
          !error.message.includes('private upstream detail'),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
