'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EmptyState,
  ErrorMessage,
  LoadingState,
  PageHeading,
  Wordmark,
} from '@/components/bow-era-ui';
import {
  fetchOrganizationsPage,
  organizationSelectionHref,
  OrganizationsRequestError,
  type OrganizationChoice,
} from '@/lib/organizations/client';

const ORGANIZATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loginHref(): string {
  return '/api/auth/login?returnTo=%2Forganizations';
}

function ArchitectureIllustration() {
  return (
    <Image
      className="bow-era-house-illustration"
      src="/images/bowera-architecture.webp"
      alt="Modern glass residence overlooking the Los Angeles skyline at sunset, with illuminated interiors, an infinity pool, and lush landscaping."
      width={1152}
      height={768}
      sizes="(max-width: 680px) calc(100vw - 36px), (max-width: 900px) 40vw, 50vw"
      unoptimized
      priority
      fetchPriority="high"
    />
  );
}

export default function OrganizationsPage() {
  const [organizations, setOrganizations] = useState<OrganizationChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<OrganizationsRequestError | null>(null);
  const [pageError, setPageError] = useState('');
  const [pageErrorRequiresSignIn, setPageErrorRequiresSignIn] = useState(false);

  const loadFirstPage = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setPageError('');
    try {
      const page = await fetchOrganizationsPage(null, signal);
      if (signal?.aborted) return;
      setOrganizations(page.organizations);
      setNextCursor(page.next_cursor);
      const selected = new URL(window.location.href).searchParams.get(
        'organizationId',
      );
      setSelectedId(
        selected &&
          ORGANIZATION_ID_PATTERN.test(selected) &&
          page.organizations.some((organization) => organization.id === selected)
          ? selected
          : null,
      );
    } catch (requestError) {
      if (signal?.aborted) return;
      setError(
        requestError instanceof OrganizationsRequestError
          ? requestError
          : new OrganizationsRequestError(
              'Organizations are temporarily unavailable. Please try again.',
              503,
            ),
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadFirstPage(controller.signal);
    return () => controller.abort();
  }, [loadFirstPage]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setPageError('');
    setPageErrorRequiresSignIn(false);
    try {
      const page = await fetchOrganizationsPage(nextCursor);
      setOrganizations((current) => {
        const existing = new Set(current.map((organization) => organization.id));
        return [
          ...current,
          ...page.organizations.filter(
            (organization) => !existing.has(organization.id),
          ),
        ];
      });
      setNextCursor(page.next_cursor);
    } catch (requestError) {
      const requiresSignIn =
        requestError instanceof OrganizationsRequestError &&
        requestError.status === 401;
      setPageError(
        requestError instanceof OrganizationsRequestError
          ? requestError.message
          : 'More organizations could not be loaded. Please try again.',
      );
      setPageErrorRequiresSignIn(requiresSignIn);
    } finally {
      setLoadingMore(false);
    }
  }

  const selectedOrganization = useMemo(
    () => organizations.find((organization) => organization.id === selectedId) ?? null,
    [organizations, selectedId],
  );

  function selectOrganization(organization: OrganizationChoice) {
    const href = organizationSelectionHref(
      organization.id,
      window.location.search,
    );
    window.history.replaceState(null, '', href);
    setSelectedId(organization.id);
  }

  return (
    <div className="bow-era-page">
      <header className="bow-era-topbar bow-era-frame">
        <Link href="/organizations" aria-label="BOWERA organizations home">
          <Wordmark />
        </Link>
        <p className="bow-era-topbar-note">Property, thoughtfully managed</p>
      </header>

      <main className="bow-era-main bow-era-frame">
        <section className="bow-era-layout" aria-label="Choose your workspace">
          <aside
            className="bow-era-architecture"
            aria-label="BOWERA, a considered home for property"
          >
            <div className="bow-era-architecture-art">
              <ArchitectureIllustration />
            </div>
            <div className="bow-era-architecture-caption">
              <p className="bow-era-eyebrow">A more considered view</p>
              <p className="bow-era-architecture-title">
                Your property.
                <br />
                In good hands.
              </p>
              <p className="bow-era-architecture-copy">
                A quiet space to bring your property interests together.
              </p>
            </div>
          </aside>

          <div className="bow-era-chooser">
            <PageHeading
              eyebrow="Your workspace"
              title={
                <>
                  Choose an
                  <br />
                  organisation
                </>
              }
              description="Select an organisation to continue. Your access is checked again for every protected request."
            />

            <section
              className="bow-era-chooser-panel"
              aria-labelledby="organization-list-heading"
            >
              <h2
                id="organization-list-heading"
                className="bow-era-section-label"
              >
                Your organisations
              </h2>

              {loading ? (
                <LoadingState label="Retrieving your organisations securely…" />
              ) : error ? (
                <ErrorMessage
                  variant={error.status === 401 ? 'auth' : 'error'}
                  title={
                    error.status === 401
                      ? 'Sign in to continue'
                      : 'We could not load your organisations'
                  }
                  action={
                    error.status === 401 ? (
                      <Link
                        className="bow-era-button bow-era-button-link"
                        href={loginHref()}
                      >
                        Continue to secure sign in
                      </Link>
                    ) : (
                      <button
                        className="bow-era-button bow-era-button-secondary"
                        onClick={() => void loadFirstPage()}
                        type="button"
                      >
                        Try again
                      </button>
                    )
                  }
                >
                  {error.status === 401
                    ? 'Your session may have expired. Continue through secure sign-in to access your workspace.'
                    : error.message}
                </ErrorMessage>
              ) : organizations.length === 0 ? (
                <EmptyState title="No organisations yet">
                  No active organisation memberships are associated with your
                  account. If you believe this is an error, contact your
                  organisation administrator.
                </EmptyState>
              ) : (
                <>
                  <div
                    className="bow-era-organization-list"
                    role="group"
                    aria-label="Select an organisation"
                  >
                    {organizations.map((organization) => {
                      const selected = selectedId === organization.id;
                      return (
                        <button
                          aria-pressed={selected}
                          className="bow-era-organization-card"
                          key={organization.id}
                          onClick={() => selectOrganization(organization)}
                          type="button"
                        >
                          <span className="bow-era-organization-copy">
                            <span className="bow-era-organization-name">
                              {organization.name}
                            </span>
                            <span className="bow-era-organization-id">
                              Organisation ID · {organization.id}
                            </span>
                          </span>
                          <span
                            className="bow-era-selection-indicator"
                            aria-hidden="true"
                          >
                            ✓
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {pageError && (
                    <div role="alert">
                      <p className="bow-era-inline-error">{pageError}</p>
                      {pageErrorRequiresSignIn && (
                        <Link
                          className="bow-era-button bow-era-button-link"
                          href={loginHref()}
                        >
                          Continue to secure sign in
                        </Link>
                      )}
                    </div>
                  )}

                  <div className="bow-era-selection-bar" aria-live="polite">
                    <div>
                      <p className="bow-era-selection-label">
                        Current selection
                      </p>
                      <p className="bow-era-selection-value">
                        {selectedOrganization?.name ??
                          'Select an organisation above'}
                      </p>
                    </div>
                    {selectedOrganization && (
                      <Link
                        className="bow-era-button"
                        href={`/portfolio?organizationId=${encodeURIComponent(selectedOrganization.id)}`}
                      >
                        View portfolios
                      </Link>
                    )}
                    {nextCursor && (
                      <button
                        className="bow-era-button bow-era-button-secondary"
                        disabled={loadingMore}
                        onClick={() => void loadMore()}
                        type="button"
                      >
                        {loadingMore
                          ? 'Loading…'
                          : 'Load more organisations'}
                      </button>
                    )}
                  </div>
                  <p className="bow-era-note">
                    Selection is stored in this page’s URL for navigation only.
                    It does not grant access; protected services independently
                    verify your membership.
                  </p>
                </>
              )}
            </section>
          </div>
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
