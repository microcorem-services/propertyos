'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  createPortfolio,
  fetchPortfolioWritePermissions,
  portfolioDetailHref,
  PortfoliosRequestError,
  updatePortfolio,
  type Portfolio,
} from '@/lib/portfolios/client';

export function PortfolioEditAction({
  portfolioId,
  organizationId,
}: {
  portfolioId: string;
  organizationId: string;
}) {
  const [canUpdate, setCanUpdate] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchPortfolioWritePermissions(organizationId, controller.signal)
      .then((permissions) => {
        if (!controller.signal.aborted) setCanUpdate(permissions.can_update);
      })
      .catch(() => {
        if (!controller.signal.aborted) setVerificationFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setVerified(true);
      });
    return () => controller.abort();
  }, [organizationId]);

  if (!verified) return null;
  if (verificationFailed) {
    return (
      <p className="bowera-editor-permission-note" role="status">
        Portfolio editing permissions could not be verified.
      </p>
    );
  }
  if (!canUpdate) return null;
  return (
    <div className="bowera-editor-action-row">
      <Link
        className="bow-era-button bow-era-button-secondary"
        href={`/portfolio/${encodeURIComponent(portfolioId)}/edit?organizationId=${encodeURIComponent(organizationId)}`}
      >
        Edit portfolio
      </Link>
    </div>
  );
}

export function PortfolioEditorForm({
  mode,
  organizationId,
  portfolio,
  cancelHref,
}: {
  mode: 'create' | 'edit';
  organizationId: string;
  portfolio?: Portfolio;
  cancelHref: string;
}) {
  const [name, setName] = useState(portfolio?.name ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(
    portfolio?.status ?? 'active',
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const submissionLock = useRef(false);
  const unchanged =
    mode === 'edit' &&
    portfolio !== undefined &&
    name.trim() === portfolio.name &&
    status === portfolio.status;

  const returnTo =
    mode === 'create'
      ? `/portfolio/new?organizationId=${encodeURIComponent(organizationId)}`
      : `/portfolio/${encodeURIComponent(portfolio?.id ?? '')}/edit?organizationId=${encodeURIComponent(organizationId)}`;
  const signInHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || saved || unchanged) return;
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 200) {
      setError('Enter a portfolio name between 1 and 200 characters.');
      setErrorStatus(400);
      return;
    }
    submissionLock.current = true;
    setSaving(true);
    setError(null);
    setErrorStatus(null);
    try {
      let result: Portfolio;
      if (mode === 'create') {
        result = await createPortfolio(organizationId, {
          name: cleanName,
          status,
        });
      } else if (portfolio) {
        result = await updatePortfolio(portfolio.id, organizationId, {
          name: cleanName,
          status,
        });
      } else {
        setError('Portfolio details could not be verified. Reload and try again.');
        setErrorStatus(503);
        return;
      }
      setSaved(result);
    } catch (requestError) {
      setError(
        requestError instanceof PortfoliosRequestError
          ? requestError.message
          : 'Portfolio details could not be saved. Please try again.',
      );
      setErrorStatus(
        requestError instanceof PortfoliosRequestError
          ? requestError.status
          : 503,
      );
    } finally {
      submissionLock.current = false;
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <section className="bowera-editor-panel" aria-labelledby="portfolio-saved-title">
        <p className="bow-era-eyebrow">Changes saved</p>
        <h2 id="portfolio-saved-title" className="bowera-editor-title">
          {mode === 'create' ? 'Portfolio created' : 'Portfolio updated'}
        </h2>
        <p className="bowera-editor-copy">
          {saved.name} is ready to view.
        </p>
        <Link
          className="bow-era-button"
          href={portfolioDetailHref(saved.id, saved.organization_id)}
        >
          View portfolio
        </Link>
      </section>
    );
  }

  return (
    <form className="bowera-editor-panel" onSubmit={submit} noValidate>
      <p className="bow-era-eyebrow">
        {mode === 'create' ? 'Portfolio details' : 'Edit portfolio'}
      </p>
      <h2 className="bowera-editor-title">
        {mode === 'create' ? 'Name your portfolio' : 'Update portfolio details'}
      </h2>
      <p className="bowera-editor-copy">
        Only the portfolio name and status can be changed here.
      </p>

      <div className="bowera-editor-fields">
        <div className="bowera-editor-field">
          <label htmlFor="portfolio-name">Portfolio name</label>
          <input
            aria-describedby={
              errorStatus === 400
                ? 'portfolio-form-error'
                : 'portfolio-name-hint'
            }
            aria-invalid={errorStatus === 400}
            autoComplete="off"
            id="portfolio-name"
            maxLength={200}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
            required
            value={name}
          />
          <span className="bowera-editor-hint" id="portfolio-name-hint">
            Up to 200 characters.
          </span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="portfolio-status">Status</label>
          <select
            id="portfolio-status"
            onChange={(event) => {
              setStatus(
                event.currentTarget.value === 'inactive' ? 'inactive' : 'active',
              );
              setError(null);
              setErrorStatus(null);
            }}
            value={status}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>

      {error && (
        <div
          className="bowera-editor-error"
          id="portfolio-form-error"
          role="alert"
        >
          <p>{error}</p>
          {errorStatus === 401 && (
            <Link className="bowera-inline-retry" href={signInHref}>
              Sign in securely
            </Link>
          )}
          {errorStatus === 403 && (
            <p>Your account is not authorised to make this change.</p>
          )}
        </div>
      )}

      <div className="bowera-editor-actions">
        <button
          className="bow-era-button"
          disabled={
            saving ||
            (mode === 'edit' && unchanged)
          }
          type="submit"
        >
          {saving ? 'Saving…' : mode === 'create' ? 'Create portfolio' : 'Save changes'}
        </button>
        <Link className="bow-era-button bow-era-button-secondary" href={cancelHref}>
          Cancel
        </Link>
      </div>
      {saving && (
        <p className="bowera-editor-hint" role="status" aria-live="polite">
          Saving portfolio details securely…
        </p>
      )}
    </form>
  );
}
