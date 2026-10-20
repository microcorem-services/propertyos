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
import { UnitEditorForm } from '@/components/bow-era-unit-editor';
import {
  fetchBuilding,
  fetchUnit,
  fetchUnitWritePermissions,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  type Building,
  type Unit,
} from '@/lib/portfolios/client';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function UnitEditorPage({
  mode,
  portfolioId,
  siteId,
  buildingId,
  unitId,
}: {
  mode: 'create' | 'edit';
  portfolioId: string;
  siteId: string;
  buildingId: string;
  unitId?: string;
}) {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [unit, setUnit] = useState<Unit | null>(null);
  const [building, setBuilding] = useState<Building | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PortfoliosRequestError | null>(null);

  useEffect(() => {
    const orgId = parsePortfolioOrganizationId(window.location.search);
    setOrganizationId(orgId);
    if (
      ![portfolioId, siteId, buildingId].every((id) => UUID_PATTERN.test(id)) ||
      (unitId !== undefined && !UUID_PATTERN.test(unitId))
    ) {
      setError(new PortfoliosRequestError('Unit or parent asset not found.', 404));
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
        const [building, permissions] = await Promise.all([
          fetchBuilding(portfolioId, siteId, buildingId, verifiedOrganizationId),
          fetchUnitWritePermissions(verifiedOrganizationId, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        if (building.site_id !== siteId) {
          throw new PortfoliosRequestError('Building not found.', 404);
        }
        setBuilding(building);
        if (mode === 'create') {
          setCanWrite(permissions.can_create);
        } else if (unitId) {
          const record = await fetchUnit(
            portfolioId,
            siteId,
            buildingId,
            unitId,
            verifiedOrganizationId,
          );
          if (controller.signal.aborted) return;
          if (record.building_id !== buildingId) {
            throw new PortfoliosRequestError('Unit not found.', 404);
          }
          setUnit(record);
          setCanWrite(permissions.can_update);
        } else {
          throw new PortfoliosRequestError('Unit not found.', 404);
        }
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof PortfoliosRequestError
            ? reason
            : new PortfoliosRequestError(
                'Unit details and permissions could not be verified.',
                503,
              ),
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [mode, portfolioId, siteId, buildingId, unitId]);

  const portfolioHref =
    organizationId && UUID_PATTERN.test(portfolioId)
      ? `/portfolio/${encodeURIComponent(portfolioId)}?organizationId=${encodeURIComponent(organizationId)}`
      : '/portfolio';
  const buildingHref =
    organizationId && UUID_PATTERN.test(buildingId)
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}?organizationId=${encodeURIComponent(organizationId)}`
      : portfolioHref;
  const unitHref =
    unitId && organizationId
      ? `${buildingHref.split('?')[0]}/units/${encodeURIComponent(unitId)}?organizationId=${encodeURIComponent(organizationId)}`
      : buildingHref;
  const returnTo =
    mode === 'create'
      ? `${buildingHref.split('?')[0]}/units/new?organizationId=${encodeURIComponent(organizationId ?? '')}`
      : `${unitHref.split('?')[0]}/edit?organizationId=${encodeURIComponent(organizationId ?? '')}`;

  return (
    <div className="bow-era-page bowera-portfolio-page">
      <header className="bow-era-topbar bow-era-frame">
        <Link href="/organizations" aria-label="BOWERA organisations home">
          <Wordmark />
        </Link>
        <Link className="bowera-portfolio-back" href={mode === 'edit' ? unitHref : buildingHref}>
          {mode === 'edit' ? 'Back to unit' : 'Back to building'}
        </Link>
      </header>
      <main className="bowera-portfolio-main bow-era-frame">
        <nav className="bowera-detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/organizations">Organisations</Link>
          <span aria-hidden="true">/</span>
          <Link href={portfolioHref}>Portfolio</Link>
          <span aria-hidden="true">/</span>
          <Link href={buildingHref}>Building</Link>
          <span aria-hidden="true">/</span>
          {mode === 'edit' ? (
            <>
              <Link href={unitHref}>{unit?.name ?? 'Unit'}</Link>
              <span aria-hidden="true">/</span>
              <span aria-current="page">Edit</span>
            </>
          ) : (
            <span aria-current="page">Add unit</span>
          )}
        </nav>
        <PageHeading
          eyebrow="Property hierarchy"
          title={mode === 'create' ? 'Create a unit' : 'Edit unit'}
          description={
            mode === 'create'
              ? 'Add a unit to the selected building using verified property details.'
              : 'Update the verified details for this unit.'
          }
        />
        {building && (
          <p className="bowera-editor-copy" aria-live="polite">
            Selected building: <strong>{building.name}</strong>
          </p>
        )}
        <div className="bowera-editor-content">
          {loading ? (
            <LoadingState label="Loading unit and verifying permissions…" />
          ) : error ? (
            error.status === 404 ? (
              <EmptyState title="Unit or parent asset not found">
                This property is not available in the selected organisation.
                <Link className="bow-era-button" href={buildingHref}>
                  Back to building
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
                        : 'Unit could not be loaded'
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
                    <Link className="bow-era-button" href={buildingHref}>
                      Back to building
                    </Link>
                  )
                }
              >
                {error.message}
              </ErrorMessage>
            )
          ) : !canWrite || (mode === 'edit' && !unit) || !organizationId ? (
            <ErrorMessage
              title={`${mode === 'create' ? 'Unit creation' : 'Unit editing'} is not available`}
              action={
                <Link className="bow-era-button" href={mode === 'edit' ? unitHref : buildingHref}>
                  {mode === 'edit' ? 'Back to unit' : 'Back to building'}
                </Link>
              }
            >
              Your account does not have permission to {mode} units in this organisation.
            </ErrorMessage>
          ) : (
            <UnitEditorForm
              buildingId={buildingId}
              cancelHref={mode === 'edit' ? unitHref : buildingHref}
              mode={mode}
              organizationId={organizationId}
              portfolioId={portfolioId}
              siteId={siteId}
              unit={unit ?? undefined}
            />
          )}
        </div>
      </main>
      <footer className="bow-era-footer">
        <div className="bow-era-frame bow-era-footer-inner">
          <span><span className="bow-era-footer-accent">BOWERA</span> by Microcorem</span>
          <span>Private workspace · Secure by design</span>
        </div>
      </footer>
    </div>
  );
}
