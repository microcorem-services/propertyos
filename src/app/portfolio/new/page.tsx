'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ErrorMessage,
  LoadingState,
  PageHeading,
  Wordmark,
} from '@/components/bow-era-ui';
import { PortfolioEditorForm } from '@/components/bow-era-portfolio-editor';
import {
  fetchPortfolioWritePermissions,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
} from '@/lib/portfolios/client';

function signInHref(organizationId: string): string {
  const returnTo = `/portfolio/new?organizationId=${encodeURIComponent(organizationId)}`;
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export default function NewPortfolioPage() {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);

  useEffect(() => {
    const id = parsePortfolioOrganizationId(window.location.search);
    setOrganizationId(id);
    if (!id) {
      setError(new PortfoliosRequestError('Choose an organisation first.', 400));
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void fetchPortfolioWritePermissions(id, controller.signal)
      .then((permissions) => {
        if (!controller.signal.aborted) setCanCreate(permissions.can_create);
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          requestError instanceof PortfoliosRequestError
            ? requestError
            : new PortfoliosRequestError(
                'Portfolio permissions could not be verified.',
                503,
              ),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const dashboardHref = organizationId
    ? `/portfolio?organizationId=${encodeURIComponent(organizationId)}`
    : '/portfolio';

  return (
    <div className="bow-era-page bowera-portfolio-page">
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
          <Link href="/organizations">Organisations</Link>
          <span aria-hidden="true">/</span>
          <Link href={dashboardHref}>Portfolios</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">New portfolio</span>
        </nav>
        <PageHeading
          eyebrow="Your workspace"
          title="Create a portfolio"
          description="Add a portfolio to the selected organisation."
        />
        <div className="bowera-editor-content">
          {loading ? (
            <LoadingState label="Verifying portfolio permissions securely…" />
          ) : error ? (
            <ErrorMessage
              variant={error.status === 400 || error.status === 401 ? 'auth' : 'error'}
              title={
                error.status === 401
                  ? 'Your session has expired'
                  : error.status === 403
                    ? 'Organisation access denied'
                    : error.status === 400
                      ? 'Choose an organisation'
                      : 'Creation permissions unavailable'
              }
              action={
                error.status === 401 && organizationId ? (
                  <Link className="bow-era-button" href={signInHref(organizationId)}>
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
          ) : !canCreate ? (
            <ErrorMessage
              title="Portfolio creation is not available"
              action={
                <Link className="bow-era-button" href={dashboardHref}>
                  Back to portfolios
                </Link>
              }
            >
              Your account does not have permission to create portfolios in this
              organisation.
            </ErrorMessage>
          ) : organizationId ? (
            <PortfolioEditorForm
              cancelHref={dashboardHref}
              mode="create"
              organizationId={organizationId}
            />
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
