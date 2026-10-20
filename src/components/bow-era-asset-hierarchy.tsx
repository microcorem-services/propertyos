'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  EmptyState,
  ErrorMessage,
  LoadingState,
  Wordmark,
} from '@/components/bow-era-ui';
import {
  buildingHref,
  fetchBuilding,
  fetchBuildingWritePermissions,
  fetchBuildings,
  fetchSite,
  fetchSiteWritePermissions,
  fetchSites,
  fetchUnit,
  fetchUnitWritePermissions,
  fetchUnits,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  siteHref,
  unitHref,
  type Building,
  type Site,
  type Unit,
} from '@/lib/portfolios/client';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Asset = Site | Building | Unit;
type AssetLevel = 'site' | 'building' | 'unit';
type ChildAssets = Building[] | Unit[];

type AssetPageData = {
  asset: Asset;
  children: ChildAssets | null;
};

type SiteCollectionProps = {
  portfolioId: string;
  organizationId: string;
};

type AssetDetailPageProps = {
  level: AssetLevel;
  portfolioId: string;
  siteId: string;
  buildingId?: string;
  unitId?: string;
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

function UnitWriteAction({
  action,
  portfolioId,
  siteId,
  buildingId,
  unitId,
  organizationId,
}: {
  action: 'create' | 'edit';
  portfolioId: string;
  siteId: string;
  buildingId: string;
  unitId?: string;
  organizationId: string;
}) {
  const [allowed, setAllowed] = useState(false);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchUnitWritePermissions(organizationId, controller.signal)
      .then((permissions) => {
        if (!controller.signal.aborted) {
          setAllowed(
            action === 'create'
              ? permissions.can_create
              : permissions.can_update,
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setVerified(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setVerified(true);
      });
    return () => controller.abort();
  }, [action, organizationId]);

  if (!verified || !allowed) return null;
  const buildingPath = `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}`;
  const href =
    action === 'create'
      ? `${buildingPath}/units/new?organizationId=${encodeURIComponent(organizationId)}`
      : `${buildingPath}/units/${encodeURIComponent(unitId ?? '')}/edit?organizationId=${encodeURIComponent(organizationId)}`;
  return (
    <div className="bowera-editor-action-row">
      <Link className="bow-era-button bow-era-button-secondary" href={href}>
        {action === 'create' ? 'Add unit' : 'Edit unit'}
      </Link>
    </div>
  );
}

function Status({ status }: { status: 'active' | 'inactive' }) {
  return (
    <span className={`bowera-portfolio-status bowera-portfolio-status-${status}`}>
      <span className="bowera-portfolio-status-dot" aria-hidden="true" />
      {status === 'active' ? 'Active' : 'Inactive'}
    </span>
  );
}

function SiteCards({
  sites,
  portfolioId,
  organizationId,
}: {
  sites: Site[];
  portfolioId: string;
  organizationId: string;
}) {
  if (sites.length === 0) {
    return (
      <EmptyState title="No sites to show">
        No sites are available for this portfolio yet.
      </EmptyState>
    );
  }
  return (
    <div className="bowera-asset-grid">
      {sites.map((site) => (
        <Link
          className="bowera-asset-card"
          href={siteHref(portfolioId, site.id, organizationId)}
          key={site.id}
        >
          <div className="bowera-asset-card-top">
            <span className="bow-era-eyebrow">Site</span>
            <Status status={site.status} />
          </div>
          <h3>{site.name}</h3>
          {site.address && <p>{site.address}</p>}
          <span className="bowera-asset-card-action">View site and buildings</span>
        </Link>
      ))}
    </div>
  );
}

export function SiteCollection({
  portfolioId,
  organizationId,
}: SiteCollectionProps) {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [permissionVerified, setPermissionVerified] = useState(false);
  const [permissionFailed, setPermissionFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchSites(portfolioId, organizationId)
      .then((result) => {
        if (active) setSites(result);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof PortfoliosRequestError
            ? reason
            : new PortfoliosRequestError(
                'Sites could not be loaded. Please try again.',
                503,
              ),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [portfolioId, organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSiteWritePermissions(organizationId, controller.signal)
      .then((permissions) => {
        if (!controller.signal.aborted) setCanCreate(permissions.can_create);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPermissionFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPermissionVerified(true);
      });
    return () => controller.abort();
  }, [organizationId]);

  if (loading) return <LoadingState label="Retrieving sites securely…" />;
  if (error) {
    return (
      <AssetError
        error={error}
        returnTo={`/portfolio/${encodeURIComponent(portfolioId)}?organizationId=${encodeURIComponent(organizationId)}`}
      />
    );
  }
  return (
    <section className="bowera-hierarchy-section" aria-labelledby="site-list-title">
      <div className="bowera-portfolio-section-heading">
        <div>
          <p className="bow-era-eyebrow">Property hierarchy</p>
          <h2 id="site-list-title">Sites</h2>
        </div>
        <div className="bowera-editor-action-row">
          <p className="bowera-portfolio-count">
            {sites.length} {sites.length === 1 ? 'site' : 'sites'}
          </p>
          {permissionVerified && canCreate && (
            <Link
              className="bow-era-button bow-era-button-secondary"
              href={`/portfolio/${encodeURIComponent(portfolioId)}/sites/new?organizationId=${encodeURIComponent(organizationId)}`}
            >
              Add site
            </Link>
          )}
          {permissionVerified && permissionFailed && (
            <span className="bowera-editor-permission-note" role="status">
              Site creation permissions could not be verified.
            </span>
          )}
        </div>
      </div>
      <SiteCards
        sites={sites}
        portfolioId={portfolioId}
        organizationId={organizationId}
      />
    </section>
  );
}

function AssetError({
  error,
  returnTo,
}: {
  error: PortfoliosRequestError;
  returnTo: string;
}) {
  if (error.status === 404) {
    return (
      <EmptyState title="Asset not found">
        This asset is not available in the selected portfolio.
        <Link className="bow-era-button" href={returnTo}>
          Return to portfolio
        </Link>
      </EmptyState>
    );
  }
  return (
    <ErrorMessage
      variant={error.status === 401 || error.status === 400 ? 'auth' : 'error'}
      title={
        error.status === 401
          ? 'Your session has expired'
          : error.status === 403
            ? 'Organisation access denied'
            : error.status === 400
              ? 'Choose an organisation'
              : 'Property details could not be loaded'
      }
      action={
        error.status === 401 ? (
          <Link
            className="bow-era-button"
            href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
          >
            Sign in securely
          </Link>
        ) : (
          <Link className="bow-era-button" href="/organizations">
            Choose an organisation
          </Link>
        )
      }
    >
      {error.status === 401
        ? 'Sign in again to continue. Your access will be checked securely.'
        : error.status === 403
          ? 'Your account is not authorised for this organisation.'
          : error.message}
    </ErrorMessage>
  );
}

function ChildCards({
  level,
  assets,
  portfolioId,
  siteId,
  buildingId,
  organizationId,
}: {
  level: 'building' | 'unit';
  assets: ChildAssets;
  portfolioId: string;
  siteId: string;
  buildingId?: string;
  organizationId: string;
}) {
  if (assets.length === 0) {
    return (
      <EmptyState title={`No ${level === 'building' ? 'buildings' : 'units'} to show`}>
        No {level === 'building' ? 'buildings' : 'units'} are available here yet.
      </EmptyState>
    );
  }
  if (level === 'unit' && !buildingId) return null;

  return (
    <div className="bowera-asset-grid">
      {level === 'building'
        ? (assets as Building[]).map((building) => (
            <Link
              className="bowera-asset-card"
              href={buildingHref(
                portfolioId,
                siteId,
                building.id,
                organizationId,
              )}
              key={building.id}
            >
              <div className="bowera-asset-card-top">
                <span className="bow-era-eyebrow">Building</span>
                <Status status={building.status} />
              </div>
              <h3>{building.name}</h3>
              {building.building_code && <p>Code: {building.building_code}</p>}
              {building.address && <p>{building.address}</p>}
              <span className="bowera-asset-card-action">View building and units</span>
            </Link>
          ))
        : buildingId ? (assets as Unit[]).map((unit) => (
            <Link
              className="bowera-asset-card"
              href={unitHref(
                portfolioId,
                siteId,
                buildingId,
                unit.id,
                organizationId,
              )}
              key={unit.id}
            >
              <div className="bowera-asset-card-top">
                <span className="bow-era-eyebrow">Unit</span>
                <Status status={unit.status} />
              </div>
              <h3>{unit.name}</h3>
              {unit.unit_code && <p>Code: {unit.unit_code}</p>}
              {unit.floor && <p>Floor: {unit.floor}</p>}
              {unit.area_sqm && <p>Area: {unit.area_sqm} m²</p>}
              <span className="bowera-asset-card-action">View unit details</span>
            </Link>
          )) : null}
    </div>
  );
}

function SiteEditAction({
  portfolioId,
  siteId,
  organizationId,
}: {
  portfolioId: string;
  siteId: string;
  organizationId: string;
}) {
  const [canUpdate, setCanUpdate] = useState(false);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSiteWritePermissions(organizationId, controller.signal)
      .then((permissions) => {
        if (!controller.signal.aborted) setCanUpdate(permissions.can_update);
      })
      .finally(() => {
        if (!controller.signal.aborted) setVerified(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setVerified(true);
      });
    return () => controller.abort();
  }, [organizationId]);

  if (!verified || !canUpdate) return null;
  return (
    <div className="bowera-editor-action-row">
      <Link
        className="bow-era-button bow-era-button-secondary"
        href={`/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/edit?organizationId=${encodeURIComponent(organizationId)}`}
      >
        Edit site
      </Link>
    </div>
  );
}

function BuildingWriteAction({
  action,
  portfolioId,
  siteId,
  buildingId,
  organizationId,
}: {
  action: 'create' | 'edit';
  portfolioId: string;
  siteId: string;
  buildingId?: string;
  organizationId: string;
}) {
  const [allowed, setAllowed] = useState(false);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchBuildingWritePermissions(organizationId, controller.signal)
      .then((permissions) => {
        if (!controller.signal.aborted) {
          setAllowed(
            action === 'create'
              ? permissions.can_create
              : permissions.can_update,
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setVerified(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setVerified(true);
      });
    return () => controller.abort();
  }, [action, organizationId]);

  if (!verified || !allowed) return null;
  const href =
    action === 'create'
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/new?organizationId=${encodeURIComponent(organizationId)}`
      : `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId ?? '')}/edit?organizationId=${encodeURIComponent(organizationId)}`;
  return (
    <div className="bowera-editor-action-row">
      <Link className="bow-era-button bow-era-button-secondary" href={href}>
        {action === 'create' ? 'Add building' : 'Edit building'}
      </Link>
    </div>
  );
}

function AssetDetails({ asset, level }: { asset: Asset; level: AssetLevel }) {
  const facts: Array<[string, string]> = [
    ['Status', asset.status === 'active' ? 'Active' : 'Inactive'],
    ['Created', formatDate(asset.created_at)],
    ['Last updated', formatDate(asset.updated_at)],
  ];
  if (level === 'site' && 'address' in asset && asset.address) {
    facts.unshift(['Address', asset.address]);
  }
  if (level === 'building' && 'building_code' in asset) {
    if (asset.building_code) facts.unshift(['Building code', asset.building_code]);
    if (asset.address) facts.unshift(['Address', asset.address]);
  }
  if (level === 'unit' && 'unit_code' in asset) {
    if (asset.unit_code) facts.unshift(['Unit code', asset.unit_code]);
    if (asset.floor) facts.unshift(['Floor', asset.floor]);
    if (asset.area_sqm) facts.unshift(['Area', `${asset.area_sqm} m²`]);
  }

  return (
    <section className="bowera-detail-card" aria-labelledby="asset-detail-title">
      <div className="bowera-detail-card-top">
        <p className="bow-era-eyebrow">{level} record</p>
        <Status status={asset.status} />
      </div>
      <h2 className="bowera-detail-name" id="asset-detail-title">
        {asset.name}
      </h2>
      <dl className="bowera-detail-list">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function AssetDetailPage({
  level,
  portfolioId,
  siteId,
  buildingId,
  unitId,
}: AssetDetailPageProps) {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [data, setData] = useState<AssetPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);
  const ids = [portfolioId, siteId, buildingId, unitId].filter(
    (id): id is string => id !== undefined,
  );

  useEffect(() => {
    let active = true;
    const orgId = parsePortfolioOrganizationId(window.location.search);
    setOrganizationId(orgId);
    if (!orgId || !ids.every((id) => UUID_PATTERN.test(id))) {
      setError(
        new PortfoliosRequestError(
          orgId ? 'Invalid asset identifier.' : 'Choose an organisation first.',
          orgId ? 400 : 400,
        ),
      );
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        let result: AssetPageData;
        if (level === 'site') {
          const [asset, children] = await Promise.all([
            fetchSite(portfolioId, siteId, orgId),
            fetchBuildings(portfolioId, siteId, orgId),
          ]);
          result = { asset, children };
        } else if (level === 'building' && buildingId) {
          const [asset, children] = await Promise.all([
            fetchBuilding(portfolioId, siteId, buildingId, orgId),
            fetchUnits(portfolioId, siteId, buildingId, orgId),
          ]);
          result = { asset, children };
        } else if (level === 'unit' && buildingId && unitId) {
          result = {
            asset: await fetchUnit(
              portfolioId,
              siteId,
              buildingId,
              unitId,
              orgId,
            ),
            children: null,
          };
        } else {
          throw new PortfoliosRequestError('Invalid asset identifier.', 400);
        }
        if (active) setData(result);
      } catch (reason) {
        if (!active) return;
        setError(
          reason instanceof PortfoliosRequestError
            ? reason
            : new PortfoliosRequestError(
                'Property details could not be loaded. Please try again.',
                503,
              ),
        );
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [level, portfolioId, siteId, buildingId, unitId]);

  const organizationQuery = organizationId
    ? `?organizationId=${encodeURIComponent(organizationId)}`
    : '';
  const portfolioHref = `/portfolio/${encodeURIComponent(portfolioId)}${organizationQuery}`;
  const sitePageHref = `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}${organizationQuery}`;
  const buildingPageHref =
    buildingId && organizationId
      ? buildingHref(portfolioId, siteId, buildingId, organizationId)
      : sitePageHref;
  const currentName = data?.asset.name ?? `${level[0].toUpperCase()}${level.slice(1)}`;

  return (
    <div className="bow-era-page bowera-portfolio-page bowera-detail-page">
      <header className="bow-era-topbar bow-era-frame">
        <Link href="/organizations" aria-label="BOWERA organisations home">
          <Wordmark />
        </Link>
        <Link className="bowera-portfolio-back" href={portfolioHref}>
          Back to portfolio
        </Link>
      </header>

      <main className="bowera-portfolio-main bow-era-frame">
        <nav className="bowera-detail-breadcrumb" aria-label="Breadcrumb">
          <Link href={portfolioHref}>Portfolio</Link>
          <span aria-hidden="true">/</span>
          <Link href={sitePageHref}>Site</Link>
          {level !== 'site' && (
            <>
              <span aria-hidden="true">/</span>
              <Link href={buildingPageHref}>Building</Link>
            </>
          )}
          {level === 'unit' && (
            <>
              <span aria-hidden="true">/</span>
              <span aria-current="page">Unit</span>
            </>
          )}
          {level === 'site' && (
            <>
              <span aria-hidden="true">/</span>
              <span aria-current="page">Site</span>
            </>
          )}
          {level === 'building' && (
            <>
              <span aria-hidden="true">/</span>
              <span aria-current="page">Building</span>
            </>
          )}
        </nav>

        <div className="bowera-hierarchy-section">
          {loading ? (
            <LoadingState label={`Retrieving ${level} details securely…`} />
          ) : error ? (
            <AssetError error={error} returnTo={portfolioHref} />
          ) : data ? (
            <>
              <div className="bowera-asset-heading">
                <p className="bow-era-eyebrow">Property hierarchy</p>
                <h1 className="bow-era-title">{currentName}</h1>
                <p className="bow-era-description">
                  Verified {level} details and its place in the portfolio.
                </p>
                {level === 'site' && organizationId && (
                  <SiteEditAction
                    organizationId={organizationId}
                    portfolioId={portfolioId}
                    siteId={siteId}
                  />
                )}
                {level === 'unit' && organizationId && buildingId && unitId && (
                  <UnitWriteAction
                    action="edit"
                    buildingId={buildingId}
                    organizationId={organizationId}
                    portfolioId={portfolioId}
                    siteId={siteId}
                    unitId={unitId}
                  />
                )}
                {level === 'building' && organizationId && (
                  <BuildingWriteAction
                    action="edit"
                    buildingId={buildingId}
                    organizationId={organizationId}
                    portfolioId={portfolioId}
                    siteId={siteId}
                  />
                )}
              </div>
              <AssetDetails asset={data.asset} level={level} />
              {level === 'site' && organizationId && (
                <section
                  className="bowera-hierarchy-section"
                  aria-labelledby="building-list-title"
                >
                  <div className="bowera-portfolio-section-heading">
                    <div>
                      <p className="bow-era-eyebrow">Site contents</p>
                      <h2 id="building-list-title">Buildings</h2>
                    </div>
                    <div className="bowera-editor-action-row">
                      <p className="bowera-portfolio-count">
                        {data.children?.length ?? 0}{' '}
                        {data.children?.length === 1 ? 'building' : 'buildings'}
                      </p>
                      <BuildingWriteAction
                        action="create"
                        organizationId={organizationId}
                        portfolioId={portfolioId}
                        siteId={siteId}
                      />
                    </div>
                  </div>
                  <ChildCards
                    level="building"
                    assets={data.children ?? []}
                    portfolioId={portfolioId}
                    siteId={siteId}
                    organizationId={organizationId}
                  />
                </section>
              )}
              {level === 'building' && buildingId && organizationId && (
                <section
                  className="bowera-hierarchy-section"
                  aria-labelledby="unit-list-title"
                >
                  <div className="bowera-portfolio-section-heading">
                    <div>
                      <p className="bow-era-eyebrow">Building contents</p>
                      <h2 id="unit-list-title">Units</h2>
                    </div>
                    <div className="bowera-editor-action-row">
                      <p className="bowera-portfolio-count">
                        {data.children?.length ?? 0}{' '}
                        {data.children?.length === 1 ? 'unit' : 'units'}
                      </p>
                      <UnitWriteAction
                        action="create"
                        buildingId={buildingId}
                        organizationId={organizationId}
                        portfolioId={portfolioId}
                        siteId={siteId}
                      />
                    </div>
                  </div>
                  <ChildCards
                    level="unit"
                    assets={data.children ?? []}
                    portfolioId={portfolioId}
                    siteId={siteId}
                    buildingId={buildingId}
                    organizationId={organizationId}
                  />
                </section>
              )}
            </>
          ) : null}
        </div>
      </main>

      <footer className="bow-era-footer">
        <div className="bow-era-frame bow-era-footer-inner">
          <span>
            <span className="bow-era-footer-accent">BOWERA</span> by Microcorem
          </span>
          <span>Private workspace · Secure by design</span>
        </div>
      </footer>
    </div>
  );
}
