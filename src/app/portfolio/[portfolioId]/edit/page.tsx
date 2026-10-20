'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  EmptyState,
  ErrorMessage,
  LoadingState,
  PageHeading,
  Wordmark,
} from '@/components/bow-era-ui';
import { PortfolioEditorForm } from '@/components/bow-era-portfolio-editor';
import {
  fetchPortfolio,
  fetchPortfolioWritePermissions,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  type Portfolio,
} from '@/lib/portfolios/client';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function signInHref(portfolioId: string, organizationId: string): string {
  const returnTo = `/portfolio/${encodeURIComponent(portfolioId)}/edit?organizationId=${encodeURIComponent(organizationId)}`;
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export default function EditPortfolioPage() {
  const params = useParams<{ portfolioId: string }>();
  const portfolioId = params.portfolioId;
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [canUpdate, setCanUpdate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);

  useEffect(() => {
    const orgId = parsePortfolioOrganizationId(window.location.search);
    setOrganizationId(orgId);
    if (!UUID_PATTERN.test(portfolioId)) {
      setError(new PortfoliosRequestError('Portfolio not found.', 404));
      setLoading(false);
      return;
    }
    if (!orgId) {
      setError(new PortfoliosRequestError('Choose an organisation first.', 400));
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    void Promise.all([
      fetchPortfolio(portfolioId, orgId, controller.signal),
      fetchPortfolioWritePermissions(orgId, controller.signal),
    ])
      .then(([record, permissions]) => {
        if (controller.signal.aborted) return;
        setPortfolio(record);
        setCanUpdate(permissions.can_update);
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          requestError instanceof PortfoliosRequestError
            ? requestError
            : new PortfoliosRequestError(
                'Portfolio details and permissions could not be verified.',
                503,
              ),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [portfolioId]);

  const detailHref =
    organizationId && UUID_PATTERN.test(portfolioId)
      ? `/portfolio/${encodeURIComponent(portfolioId)}?organizationId=${encodeURIComponent(organizationId)}`
      : '/portfolio';
  const dashboardHref = organizationId
    ? `/portfolio?organizationId=${encodeURIComponent(organizationId)}`
    : '/portfolio';

  return (
    <div className="bow-era-page bowera-portfolio-page">
      <header className="bow-era-topbar bow-era-frame">
        <Link href="/organizations" aria-label="BOWERA organisations home">
          <Wordmark />
        </Link>
        <Link className="bowera-portfolio-back" href={detailHref}>
          Back to portfolio
        </Link>
      </header>
      <main className="bowera-portfolio-main bow-era-frame">
        <nav className="bowera-detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/organizations">Organisations</Link>
          <span aria-hidden="true">/</span>
          <Link href={dashboardHref}>Portfolios</Link>
          <span aria-hidden="true">/</span>
          <Link href={detailHref}>{portfolio?.name ?? 'Portfolio'}</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Edit</span>
        </nav>
        <PageHeading
          eyebrow="Your workspace"
          title="Edit portfolio"
          description="Update the verified details for this portfolio."
        />
        <div className="bowera-editor-content">
          {loading ? (
            <LoadingState label="Loading portfolio and verifying permissions…" />
          ) : error ? (
            error.status === 404 ? (
              <EmptyState title="Portfolio not found">
                This portfolio is not available in the selected organisation.
                <Link className="bow-era-button" href={dashboardHref}>
                  Back to portfolios
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
                        : 'Portfolio could not be loaded'
                }
                action={
                  error.status === 401 && organizationId ? (
                    <Link
                      className="bow-era-button"
                      href={signInHref(portfolioId, organizationId)}
                    >
                      Sign in securely
                    </Link>
                  ) : (
                    <Link className="bow-era-button" href={dashboardHref}>
                      Back to portfolios
                    </Link>
                  )
                }
              >
                {error.message}
              </ErrorMessage>
            )
          ) : !canUpdate || !portfolio || !organizationId ? (
            <ErrorMessage
              title="Portfolio editing is not available"
              action={
                <Link className="bow-era-button" href={detailHref}>
                  Back to portfolio
                </Link>
              }
            >
              Your account does not have permission to edit this portfolio.
            </ErrorMessage>
          ) : (
            <PortfolioEditorForm
              cancelHref={detailHref}
              mode="edit"
              organizationId={organizationId}
              portfolio={portfolio}
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
