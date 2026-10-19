'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  EmptyState,
  ErrorMessage,
  LoadingState,
  PageHeading,
  Wordmark,
} from '@/components/bow-era-ui';
import {
  fetchPortfolios,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  type Portfolio,
} from '@/lib/portfolios/client';

function signInHref(organizationId: string): string {
  const returnTo = `/portfolio?organizationId=${encodeURIComponent(organizationId)}`;
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

function PortfolioCard({ portfolio }: { portfolio: Portfolio }) {
  return (
    <article className="bowera-portfolio-card">
      <div className="bowera-portfolio-card-top">
        <span
          className={`bowera-portfolio-status bowera-portfolio-status-${portfolio.status}`}
        >
          <span className="bowera-portfolio-status-dot" aria-hidden="true" />
          {portfolio.status === 'active' ? 'Active' : 'Inactive'}
        </span>
        <span className="bowera-portfolio-card-accent" aria-hidden="true" />
      </div>
      <h2 className="bowera-portfolio-name">{portfolio.name}</h2>
      <dl className="bowera-portfolio-meta">
        <div>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={portfolio.updated_at}>
              {formatDate(portfolio.updated_at)}
            </time>
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
      </dl>
    </article>
  );
}

export default function PortfolioPage() {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);

  const loadPortfolios = useCallback(
    async (id: string, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const results = await fetchPortfolios(id, signal);
        if (signal?.aborted) return;
        setPortfolios(results);
      } catch (requestError) {
        if (signal?.aborted) return;
        setError(
          requestError instanceof PortfoliosRequestError
            ? requestError
            : new PortfoliosRequestError(
                'Portfolios could not be loaded. Please try again.',
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
    const id = parsePortfolioOrganizationId(window.location.search);
    setOrganizationId(id);
    if (!id) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadPortfolios(id, controller.signal);
    return () => controller.abort();
  }, [loadPortfolios]);

  const chooserHref = organizationId
    ? `/organizations?organizationId=${encodeURIComponent(organizationId)}`
    : '/organizations';

  return (
    <div className="bow-era-page bowera-portfolio-page">
      <header className="bow-era-topbar bow-era-frame">
        <Link href="/organizations" aria-label="BOWERA organisations home">
          <Wordmark />
        </Link>
        <Link className="bowera-portfolio-back" href={chooserHref}>
          Back to organisations
        </Link>
      </header>

      <main className="bowera-portfolio-main bow-era-frame">
        <div className="bowera-portfolio-heading-row">
          <PageHeading
            eyebrow="Your workspace"
            title="Portfolio overview"
            description="A considered view of the portfolios available to your organisation."
          />
          {organizationId && (
            <p className="bowera-portfolio-organisation">
              <span>Selected organisation</span>
              <code>{organizationId}</code>
            </p>
          )}
        </div>

        <section
          className="bowera-portfolio-content"
          aria-labelledby="portfolio-list-heading"
        >
          <div className="bowera-portfolio-section-heading">
            <div>
              <p className="bow-era-eyebrow">Property interests</p>
              <h2 id="portfolio-list-heading">Your portfolios</h2>
            </div>
            {!loading && !error && (
              <p className="bowera-portfolio-count" aria-live="polite">
                {portfolios.length}{' '}
                {portfolios.length === 1 ? 'portfolio' : 'portfolios'}
              </p>
            )}
          </div>

          {!organizationId ? (
            <ErrorMessage
              variant="auth"
              title="Choose an organisation"
              action={
                <Link className="bow-era-button" href="/organizations">
                  Go to organisation chooser
                </Link>
              }
            >
              Select an organisation before viewing its portfolios. The
              organisation identifier in a URL does not grant access.
            </ErrorMessage>
          ) : loading ? (
            <LoadingState label="Retrieving your portfolios securely…" />
          ) : error ? (
            <ErrorMessage
              variant={error.status === 401 ? 'auth' : 'error'}
              title={
                error.status === 401
                  ? 'Your session has expired'
                  : error.status === 403
                    ? 'Organisation access denied'
                    : 'We could not load your portfolios'
              }
              action={
                error.status === 401 ? (
                  <Link
                    className="bow-era-button"
                    href={signInHref(organizationId)}
                  >
                    Sign in securely
                  </Link>
                ) : error.status === 403 ? (
                  <Link className="bow-era-button" href={chooserHref}>
                    Choose another organisation
                  </Link>
                ) : (
                  <button
                    className="bow-era-button bow-era-button-secondary"
                    onClick={() => void loadPortfolios(organizationId)}
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
                  ? 'Your account is not authorised for this organisation. Choose an organisation you can access.'
                  : error.message}
            </ErrorMessage>
          ) : portfolios.length === 0 ? (
            <EmptyState title="No portfolios to show">
              There are no portfolios available for this organisation yet.
            </EmptyState>
          ) : (
            <div className="bowera-portfolio-grid">
              {portfolios.map((portfolio) => (
                <PortfolioCard key={portfolio.id} portfolio={portfolio} />
              ))}
            </div>
          )}
        </section>
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
