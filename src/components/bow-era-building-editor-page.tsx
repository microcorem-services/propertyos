'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  EmptyState,
  ErrorMessage,
  LoadingState,
  PageHeading,
  Wordmark,
} from '@/components/bow-era-ui';
import { BuildingEditorForm } from '@/components/bow-era-building-editor';
import {
  fetchBuilding,
  fetchBuildingWritePermissions,
  fetchSite,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  type Building,
} from '@/lib/portfolios/client';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function BuildingEditorPage({
  mode,
  portfolioId,
  siteId,
  buildingId,
}: {
  mode: 'create' | 'edit';
  portfolioId: string;
  siteId: string;
  buildingId?: string;
}) {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [building, setBuilding] = useState<Building | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);

  useEffect(() => {
    const orgId = parsePortfolioOrganizationId(window.location.search);
    setOrganizationId(orgId);
    if (
      !UUID_PATTERN.test(portfolioId) ||
      !UUID_PATTERN.test(siteId) ||
      (buildingId !== undefined && !UUID_PATTERN.test(buildingId))
    ) {
      setError(new PortfoliosRequestError('Building not found.', 404));
      setLoading(false);
      return;
    }
    if (!orgId) {
      setError(new PortfoliosRequestError('Choose an organisation first.', 400));
      setLoading(false);
      return;
    }
    const verifiedOrganizationId = orgId;
    const controller = new AbortController();
    async function load() {
      try {
        const permissionsRequest = fetchBuildingWritePermissions(
          verifiedOrganizationId,
          controller.signal,
        );
        if (mode === 'create') {
          const [site, permissions] = await Promise.all([
            fetchSite(
              portfolioId,
              siteId,
              verifiedOrganizationId,
              controller.signal,
            ),
            permissionsRequest,
          ]);
          if (controller.signal.aborted) return;
          if (site.portfolio_id !== portfolioId) {
            throw new PortfoliosRequestError('Site not found.', 404);
          }
          setCanWrite(permissions.can_create);
        } else if (buildingId) {
          const [record, permissions] = await Promise.all([
            fetchBuilding(
              portfolioId,
              siteId,
              buildingId,
              verifiedOrganizationId,
            ),
            permissionsRequest,
          ]);
          if (controller.signal.aborted) return;
          if (record.site_id !== siteId) {
            throw new PortfoliosRequestError('Building not found.', 404);
          }
          setBuilding(record);
          setCanWrite(permissions.can_update);
        } else {
          throw new PortfoliosRequestError('Building not found.', 404);
        }
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof PortfoliosRequestError
            ? reason
            : new PortfoliosRequestError(
                'Building details and permissions could not be verified.',
                503,
              ),
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [mode, portfolioId, siteId, buildingId]);

  const portfolioHref =
    organizationId && UUID_PATTERN.test(portfolioId)
      ? `/portfolio/${encodeURIComponent(portfolioId)}?organizationId=${encodeURIComponent(organizationId)}`
      : '/portfolio';
  const siteHref =
    organizationId && UUID_PATTERN.test(siteId)
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}?organizationId=${encodeURIComponent(organizationId)}`
      : portfolioHref;
  const buildingHref =
    buildingId && organizationId
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}?organizationId=${encodeURIComponent(organizationId)}`
      : siteHref;
  const returnTo =
    mode === 'create'
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/new?organizationId=${encodeURIComponent(organizationId ?? '')}`
      : `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId ?? '')}/edit?organizationId=${encodeURIComponent(organizationId ?? '')}`;

  return (
    <div className="bow-era-page bowera-portfolio-page">
      <header className="bow-era-topbar bow-era-frame">
        <Link href="/organizations" aria-label="BOWERA organisations home">
          <Wordmark />
        </Link>
        <Link className="bowera-portfolio-back" href={mode === 'edit' ? buildingHref : siteHref}>
          {mode === 'edit' ? 'Back to building' : 'Back to site'}
        </Link>
      </header>
      <main className="bowera-portfolio-main bow-era-frame">
        <nav className="bowera-detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/organizations">Organisations</Link>
          <span aria-hidden="true">/</span>
          <Link href={portfolioHref}>Portfolio</Link>
          <span aria-hidden="true">/</span>
          <Link href={siteHref}>Site</Link>
          <span aria-hidden="true">/</span>
          {mode === 'edit' ? (
            <>
              <Link href={buildingHref}>{building?.name ?? 'Building'}</Link>
              <span aria-hidden="true">/</span>
              <span aria-current="page">Edit</span>
            </>
          ) : (
            <span aria-current="page">Add building</span>
          )}
        </nav>
        <PageHeading
          eyebrow="Property hierarchy"
          title={mode === 'create' ? 'Add a building' : 'Edit building'}
          description={
            mode === 'create'
              ? 'Add a building to this site using verified property details.'
              : 'Update the verified details for this building.'
          }
        />
        <div className="bowera-editor-content">
          {loading ? (
            <LoadingState label="Loading building and verifying permissions…" />
          ) : error ? (
            error.status === 404 ? (
              <EmptyState title="Building or parent asset not found">
                This property is not available in the selected organisation.
                <Link className="bow-era-button" href={siteHref}>
                  Back to site
                </Link>
              </EmptyState>
            ) : (
              <ErrorMessage
                variant={error.status === 400 || error.status === 401 ? 'auth' : 'error'}
                title={
                  error.status === 401
                    ? 'Your session has expired'
                    : error.status === 403
                      ? 'Organisation access denied'
                      : error.status === 400
                        ? 'Choose an organisation'
                        : 'Building could not be loaded'
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
                    <Link className="bow-era-button" href={siteHref}>
                      Back to site
                    </Link>
                  )
                }
              >
                {error.message}
              </ErrorMessage>
            )
          ) : !canWrite || (mode === 'edit' && !building) || !organizationId ? (
            <ErrorMessage
              title={`${mode === 'create' ? 'Building creation' : 'Building editing'} is not available`}
              action={
                <Link className="bow-era-button" href={mode === 'edit' ? buildingHref : siteHref}>
                  {mode === 'edit' ? 'Back to building' : 'Back to site'}
                </Link>
              }
            >
              Your account does not have permission to {mode} buildings in this organisation.
            </ErrorMessage>
          ) : (
            <BuildingEditorForm
              building={building ?? undefined}
              cancelHref={mode === 'edit' ? buildingHref : siteHref}
              mode={mode}
              organizationId={organizationId}
              portfolioId={portfolioId}
              siteId={siteId}
            />
          )}
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
