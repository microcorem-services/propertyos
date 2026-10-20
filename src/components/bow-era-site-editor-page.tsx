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
import { SiteEditorForm } from '@/components/bow-era-site-editor';
import {
  fetchPortfolio,
  fetchSite,
  fetchSiteWritePermissions,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  type Site,
} from '@/lib/portfolios/client';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function SiteEditorPage({
  mode,
  portfolioId,
  siteId,
}: {
  mode: 'create' | 'edit';
  portfolioId: string;
  siteId?: string;
}) {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);

  useEffect(() => {
    const orgId = parsePortfolioOrganizationId(window.location.search);
    setOrganizationId(orgId);
    if (!UUID_PATTERN.test(portfolioId) || (siteId && !UUID_PATTERN.test(siteId))) {
      setError(new PortfoliosRequestError('Site not found.', 404));
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
        const permissionsRequest = fetchSiteWritePermissions(
          verifiedOrganizationId,
          controller.signal,
        );
        if (mode === 'create') {
          const [portfolio, permissions] = await Promise.all([
            fetchPortfolio(portfolioId, verifiedOrganizationId, controller.signal),
            permissionsRequest,
          ]);
          if (controller.signal.aborted) return;
          setCanWrite(permissions.can_create);
          if (portfolio.organization_id !== verifiedOrganizationId) {
            throw new PortfoliosRequestError('Portfolio not found.', 404);
          }
        } else if (siteId) {
          const [record, permissions] = await Promise.all([
            fetchSite(
              portfolioId,
              siteId,
              verifiedOrganizationId,
              controller.signal,
            ),
            permissionsRequest,
          ]);
          if (controller.signal.aborted) return;
          setSite(record);
          setCanWrite(permissions.can_update);
        } else {
          throw new PortfoliosRequestError('Site not found.', 404);
        }
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof PortfoliosRequestError
            ? reason
            : new PortfoliosRequestError(
                'Site details and permissions could not be verified.',
                503,
              ),
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [mode, portfolioId, siteId]);

  const portfolioHref =
    organizationId && UUID_PATTERN.test(portfolioId)
      ? `/portfolio/${encodeURIComponent(portfolioId)}?organizationId=${encodeURIComponent(organizationId)}`
      : '/portfolio';
  const siteHref =
    siteId && organizationId && UUID_PATTERN.test(siteId)
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}?organizationId=${encodeURIComponent(organizationId)}`
      : portfolioHref;
  const returnTo =
    mode === 'create'
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/new?organizationId=${encodeURIComponent(organizationId ?? '')}`
      : `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId ?? '')}/edit?organizationId=${encodeURIComponent(organizationId ?? '')}`;
  const signInHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <div className="bow-era-page bowera-portfolio-page">
      <header className="bow-era-topbar bow-era-frame">
        <Link href="/organizations" aria-label="BOWERA organisations home">
          <Wordmark />
        </Link>
        <Link className="bowera-portfolio-back" href={mode === 'edit' ? siteHref : portfolioHref}>
          {mode === 'edit' ? 'Back to site' : 'Back to portfolio'}
        </Link>
      </header>
      <main className="bowera-portfolio-main bow-era-frame">
        <nav className="bowera-detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/organizations">Organisations</Link>
          <span aria-hidden="true">/</span>
          <Link href={portfolioHref}>Portfolio</Link>
          <span aria-hidden="true">/</span>
          {mode === 'edit' ? (
            <>
              <Link href={siteHref}>{site?.name ?? 'Site'}</Link>
              <span aria-hidden="true">/</span>
              <span aria-current="page">Edit</span>
            </>
          ) : (
            <span aria-current="page">Add site</span>
          )}
        </nav>
        <PageHeading
          eyebrow="Property hierarchy"
          title={mode === 'create' ? 'Add a site' : 'Edit site'}
          description={
            mode === 'create'
              ? 'Add a site to this portfolio using verified property details.'
              : 'Update the verified details for this site.'
          }
        />
        <div className="bowera-editor-content">
          {loading ? (
            <LoadingState label="Loading site and verifying permissions…" />
          ) : error ? (
            error.status === 404 ? (
              <EmptyState title={mode === 'create' ? 'Portfolio not found' : 'Site not found'}>
                This property is not available in the selected organisation.
                <Link className="bow-era-button" href={portfolioHref}>
                  Back to portfolio
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
                        : 'Site could not be loaded'
                }
                action={
                  error.status === 401 ? (
                    <Link className="bow-era-button" href={signInHref}>
                      Sign in securely
                    </Link>
                  ) : (
                    <Link className="bow-era-button" href={portfolioHref}>
                      Back to portfolio
                    </Link>
                  )
                }
              >
                {error.message}
              </ErrorMessage>
            )
          ) : !canWrite || (mode === 'edit' && !site) || !organizationId ? (
            <ErrorMessage
              title={`${mode === 'create' ? 'Site creation' : 'Site editing'} is not available`}
              action={
                <Link className="bow-era-button" href={mode === 'edit' ? siteHref : portfolioHref}>
                  {mode === 'edit' ? 'Back to site' : 'Back to portfolio'}
                </Link>
              }
            >
              Your account does not have permission to {mode} sites in this organisation.
            </ErrorMessage>
          ) : (
            <SiteEditorForm
              cancelHref={mode === 'edit' ? siteHref : portfolioHref}
              mode={mode}
              organizationId={organizationId}
              portfolioId={portfolioId}
              site={site ?? undefined}
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
