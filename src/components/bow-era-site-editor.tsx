'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import {
  createSite,
  PortfoliosRequestError,
  updateSite,
  type Site,
} from '@/lib/portfolios/client';

export function SiteEditorForm({
  mode,
  portfolioId,
  organizationId,
  site,
  cancelHref,
}: {
  mode: 'create' | 'edit';
  portfolioId: string;
  organizationId: string;
  site?: Site;
  cancelHref: string;
}) {
  const [name, setName] = useState(site?.name ?? '');
  const [address, setAddress] = useState(site?.address ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(
    site?.status ?? 'active',
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const submissionLock = useRef(false);
  const unchanged =
    mode === 'edit' &&
    site !== undefined &&
    name.trim() === site.name &&
    (address.trim() || null) === site.address &&
    status === site.status;
  const returnTo =
    mode === 'create'
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/new?organizationId=${encodeURIComponent(organizationId)}`
      : `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(site?.id ?? '')}/edit?organizationId=${encodeURIComponent(organizationId)}`;
  const signInHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || saved || unchanged) return;
    const cleanName = name.trim();
    const cleanAddress = address.trim();
    if (!cleanName || cleanName.length > 200 || cleanAddress.length > 1000) {
      setError('Enter a site name up to 200 characters and an address up to 1,000 characters.');
      setErrorStatus(400);
      return;
    }
    submissionLock.current = true;
    setSaving(true);
    setError(null);
    setErrorStatus(null);
    try {
      const fields = {
        name: cleanName,
        address: cleanAddress || null,
        status,
      };
      let result: Site;
      if (mode === 'create') {
        result = await createSite(portfolioId, organizationId, fields);
      } else if (site) {
        result = await updateSite(site.id, portfolioId, organizationId, fields);
      } else {
        setError('Site details could not be verified. Reload and try again.');
        setErrorStatus(503);
        return;
      }
      setSaved(result);
    } catch (requestError) {
      setError(
        requestError instanceof PortfoliosRequestError
          ? requestError.message
          : 'Site details could not be saved. Please try again.',
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
      <section className="bowera-editor-panel" aria-labelledby="site-saved-title">
        <p className="bow-era-eyebrow">Changes saved</p>
        <h2 id="site-saved-title" className="bowera-editor-title">
          {mode === 'create' ? 'Site created' : 'Site updated'}
        </h2>
        <p className="bowera-editor-copy">{saved.name} is ready to view.</p>
        <Link
          className="bow-era-button"
          href={`/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(saved.id)}?organizationId=${encodeURIComponent(saved.organization_id)}`}
        >
          View site
        </Link>
      </section>
    );
  }

  return (
    <form className="bowera-editor-panel" onSubmit={submit} noValidate>
      <p className="bow-era-eyebrow">
        {mode === 'create' ? 'Site details' : 'Edit site'}
      </p>
      <h2 className="bowera-editor-title">
        {mode === 'create' ? 'Add a site' : 'Update site details'}
      </h2>
      <p className="bowera-editor-copy">
        Only the site name, address and status can be changed here.
      </p>

      <div className="bowera-editor-fields">
        <div className="bowera-editor-field">
          <label htmlFor="site-name">Site name</label>
          <input
            aria-describedby={errorStatus === 400 ? 'site-form-error' : 'site-name-hint'}
            aria-invalid={errorStatus === 400}
            autoComplete="off"
            id="site-name"
            maxLength={200}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
            required
            value={name}
          />
          <span className="bowera-editor-hint" id="site-name-hint">
            Up to 200 characters.
          </span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="site-address">Address</label>
          <input
            autoComplete="street-address"
            id="site-address"
            maxLength={1000}
            onChange={(event) => {
              setAddress(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
            value={address}
          />
          <span className="bowera-editor-hint">
            Optional; leave blank to clear an existing address.
          </span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="site-status">Status</label>
          <select
            id="site-status"
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
        <div className="bowera-editor-error" id="site-form-error" role="alert">
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
          disabled={saving || (mode === 'edit' && unchanged)}
          type="submit"
        >
          {saving ? 'Saving…' : mode === 'create' ? 'Create site' : 'Save changes'}
        </button>
        <Link className="bow-era-button bow-era-button-secondary" href={cancelHref}>
          Cancel
        </Link>
      </div>
      {saving && (
        <p className="bowera-editor-hint" role="status" aria-live="polite">
          Saving site details securely…
        </p>
      )}
    </form>
  );
}
