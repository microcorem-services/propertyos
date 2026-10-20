'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  EmptyState,
  ErrorMessage,
  LoadingState,
  PageHeading,
  Wordmark,
} from '@/components/bow-era-ui';
import { PortfolioEditAction } from '@/components/bow-era-portfolio-editor';
import {
  fetchPortfolio,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  type Portfolio,
} from '@/lib/portfolios/client';
import { SiteCollection } from '@/components/bow-era-asset-hierarchy';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

function signInHref(portfolioId: string, organizationId: string): string {
  const returnTo = `/portfolio/${encodeURIComponent(portfolioId)}?organizationId=${encodeURIComponent(organizationId)}`;
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function PortfolioDetails({ portfolio }: { portfolio: Portfolio }) {
  return (
    <section className="bowera-detail-card" aria-labelledby="portfolio-details-title">
      <div className="bowera-detail-card-top">
        <p className="bow-era-eyebrow">Portfolio record</p>
        <span
          className={`bowera-portfolio-status bowera-portfolio-status-${portfolio.status}`}
        >
          <span className="bowera-portfolio-status-dot" aria-hidden="true" />
          {portfolio.status === 'active' ? 'Active' : 'Inactive'}
        </span>
      </div>
      <h2 className="bowera-detail-name" id="portfolio-details-title">
        {portfolio.name}
      </h2>
      <dl className="bowera-detail-list">
        <div>
          <dt>Portfolio ID</dt>
          <dd>
            <code>{portfolio.id}</code>
          </dd>
        </div>
        <div>
          <dt>Organisation ID</dt>
          <dd>
            <code>{portfolio.organization_id}</code>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={portfolio.created_at}>
              {formatDate(portfolio.created_at)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={portfolio.updated_at}>
              {formatDate(portfolio.updated_at)}
            </time>
          </dd>
        </div>
      </dl>
    </section>
  );
}

export default function PortfolioDetailPage() {
  const params = useParams<{ portfolioId: string }>();
  const portfolioId = params.portfolioId;
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);

  const loadPortfolio = useCallback(
    async (id: string, orgId: string, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchPortfolio(id, orgId, signal);
        if (signal?.aborted) return;
        setPortfolio(result);
      } catch (requestError) {
        if (signal?.aborted) return;
        setError(
          requestError instanceof PortfoliosRequestError
            ? requestError
            : new PortfoliosRequestError(
                'Portfolio details could not be loaded. Please try again.',
                503,
              ),
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [],
  );

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
    void loadPortfolio(portfolioId, orgId, controller.signal);
    return () => controller.abort();
  }, [loadPortfolio, portfolioId]);

  const dashboardHref = organizationId
    ? `/portfolio?organizationId=${encodeURIComponent(organizationId)}`
    : '/portfolio';
  const chooserHref = organizationId
    ? `/organizations?organizationId=${encodeURIComponent(organizationId)}`
    : '/organizations';

  return (
    <div className="bow-era-page bowera-portfolio-page bowera-detail-page">
      <header className="bow-era-topbar bow-era-frame">
        <Link href="/organizations" aria-label="BOWERA organisations home">
          <Wordmark />
        </Link>
        <Link className="bowera-portfolio-back" href={dashboardHref}>
          Back to portfolios
        </Link>
      </header>

      <main className="bowera-portfolio-main bow-era-frame">
        <nav className="bowera-detail-breadcrumb" aria-label="Breadcrumb">
          <Link href={chooserHref}>Organisations</Link>
          <span aria-hidden="true">/</span>
          <Link href={dashboardHref}>Portfolios</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Details</span>
        </nav>

        <div className="bowera-portfolio-heading-row bowera-detail-heading-row">
          <PageHeading
            eyebrow="Your workspace"
            title={portfolio?.name ?? 'Portfolio details'}
            description="A clear view of the verified details for this portfolio."
          />
          {organizationId && (
            <p className="bowera-portfolio-organisation">
              <span>Selected organisation</span>
              <code>{organizationId}</code>
            </p>
          )}
        </div>

        {!organizationId && !loading && !error ? (
          <ErrorMessage
            variant="auth"
            title="Choose an organisation"
            action={
              <Link className="bow-era-button" href="/organizations">
                Go to organisation chooser
              </Link>
            }
          >
            Choose an organisation before opening a portfolio. Identifiers in
            the URL do not grant access.
          </ErrorMessage>
        ) : loading ? (
          <LoadingState label="Retrieving portfolio details securely…" />
        ) : error ? (
          error.status === 404 ? (
            <EmptyState title="Portfolio not found">
              This portfolio is not available in the selected organisation.
              Choose another portfolio from the dashboard.
              <Link className="bow-era-button" href={dashboardHref}>
                Back to portfolios
              </Link>
            </EmptyState>
          ) : (
            <ErrorMessage
              variant={error.status === 401 || error.status === 400 ? 'auth' : 'error'}
              title={
                error.status === 401
                  ? 'Your session has expired'
                  : error.status === 403
                    ? 'Organisation access denied'
                    : error.status === 400
                      ? 'Choose an organisation'
                      : 'We could not load this portfolio'
              }
              action={
                error.status === 401 ? (
                  UUID_PATTERN.test(portfolioId) && organizationId ? (
                    <Link
                      className="bow-era-button"
                      href={signInHref(portfolioId, organizationId)}
                    >
                      Sign in securely
                    </Link>
                  ) : (
                    <Link className="bow-era-button" href="/organizations">
                      Go to organisation chooser
                    </Link>
                  )
                ) : error.status === 403 ? (
                  <Link className="bow-era-button" href={chooserHref}>
                    Choose another organisation
                  </Link>
                ) : error.status === 400 ? (
                  <Link className="bow-era-button" href="/organizations">
                    Go to organisation chooser
                  </Link>
                ) : (
                  <button
                    className="bow-era-button bow-era-button-secondary"
                    onClick={() => {
                      if (organizationId) {
                        void loadPortfolio(portfolioId, organizationId);
                      }
                    }}
                    type="button"
                  >
                    Try again
                  </button>
                )
              }
            >
              {error.status === 401
                ? 'Sign in again to continue. Your access will be checked securely.'
                : error.status === 403
                  ? 'Your account is not authorised for this organisation.'
                  : error.status === 400
                    ? 'Select an organisation before opening portfolio details.'
                    : error.message}
            </ErrorMessage>
          )
        ) : portfolio ? (
          <>
            <PortfolioDetails portfolio={portfolio} />
            {organizationId && (
              <>
                <PortfolioEditAction
                  organizationId={organizationId}
                  portfolioId={portfolioId}
                />
                <SiteCollection
                  portfolioId={portfolioId}
                  organizationId={organizationId}
                />
              </>
            )}
          </>
        ) : null}
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
