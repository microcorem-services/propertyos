'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import {
  createBuilding,
  PortfoliosRequestError,
  updateBuilding,
  type Building,
} from '@/lib/portfolios/client';

export function BuildingEditorForm({
  mode,
  portfolioId,
  siteId,
  organizationId,
  building,
  cancelHref,
}: {
  mode: 'create' | 'edit';
  portfolioId: string;
  siteId: string;
  organizationId: string;
  building?: Building;
  cancelHref: string;
}) {
  const [name, setName] = useState(building?.name ?? '');
  const [buildingCode, setBuildingCode] = useState(building?.building_code ?? '');
  const [address, setAddress] = useState(building?.address ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(
    building?.status ?? 'active',
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Building | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const submissionLock = useRef(false);
  const unchanged =
    mode === 'edit' &&
    building !== undefined &&
    name.trim() === building.name &&
    (buildingCode.trim() || null) === building.building_code &&
    (address.trim() || null) === building.address &&
    status === building.status;
  const returnTo =
    mode === 'create'
      ? `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/new?organizationId=${encodeURIComponent(organizationId)}`
      : `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(building?.id ?? '')}/edit?organizationId=${encodeURIComponent(organizationId)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || saved || unchanged) return;
    const cleanName = name.trim();
    const cleanCode = buildingCode.trim();
    const cleanAddress = address.trim();
    if (
      !cleanName ||
      cleanName.length > 200 ||
      cleanCode.length > 100 ||
      cleanAddress.length > 1000
    ) {
      setError('Enter a building name up to 200 characters, a code up to 100 characters and an address up to 1,000 characters.');
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
        building_code: cleanCode || null,
        address: cleanAddress || null,
        status,
      };
      const result =
        mode === 'create'
          ? await createBuilding(
              portfolioId,
              siteId,
              organizationId,
              fields,
            )
          : building
            ? await updateBuilding(
                building.id,
                portfolioId,
                siteId,
                organizationId,
                fields,
              )
            : null;
      if (!result) {
        setError('Building details could not be verified. Reload and try again.');
        setErrorStatus(503);
        return;
      }
      setSaved(result);
    } catch (requestError) {
      setError(
        requestError instanceof PortfoliosRequestError
          ? requestError.message
          : 'Building details could not be saved. Please try again.',
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
      <section className="bowera-editor-panel" aria-labelledby="building-saved-title">
        <p className="bow-era-eyebrow">Changes saved</p>
        <h2 id="building-saved-title" className="bowera-editor-title">
          {mode === 'create' ? 'Building created' : 'Building updated'}
        </h2>
        <p className="bowera-editor-copy">{saved.name} is ready to view.</p>
        <Link
          className="bow-era-button"
          href={`/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(saved.id)}?organizationId=${encodeURIComponent(saved.organization_id)}`}
        >
          View building
        </Link>
      </section>
    );
  }

  return (
    <form className="bowera-editor-panel" onSubmit={submit} noValidate>
      <p className="bow-era-eyebrow">
        {mode === 'create' ? 'Building details' : 'Edit building'}
      </p>
      <h2 className="bowera-editor-title">
        {mode === 'create' ? 'Add a building' : 'Update building details'}
      </h2>
      <p className="bowera-editor-copy">
        Only the building name, code, address and status can be changed here.
      </p>

      <div className="bowera-editor-fields">
        <div className="bowera-editor-field">
          <label htmlFor="building-name">Building name</label>
          <input
            aria-describedby={errorStatus === 400 ? 'building-form-error' : 'building-name-hint'}
            aria-invalid={errorStatus === 400}
            autoComplete="off"
            id="building-name"
            maxLength={200}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
            required
            value={name}
          />
          <span className="bowera-editor-hint" id="building-name-hint">
            Up to 200 characters.
          </span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="building-code">Building code</label>
          <input
            autoComplete="off"
            id="building-code"
            maxLength={100}
            onChange={(event) => {
              setBuildingCode(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
            value={buildingCode}
          />
          <span className="bowera-editor-hint">
            Optional; leave blank to clear an existing code.
          </span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="building-address">Address</label>
          <input
            autoComplete="street-address"
            id="building-address"
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
          <label htmlFor="building-status">Status</label>
          <select
            id="building-status"
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
        <div className="bowera-editor-error" id="building-form-error" role="alert">
          <p>{error}</p>
          {errorStatus === 401 && (
            <Link
              className="bowera-inline-retry"
              href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
            >
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
          {saving ? 'Saving…' : mode === 'create' ? 'Create building' : 'Save changes'}
        </button>
        <Link className="bow-era-button bow-era-button-secondary" href={cancelHref}>
          Cancel
        </Link>
      </div>
      {saving && (
        <p className="bowera-editor-hint" role="status" aria-live="polite">
          Saving building details securely…
        </p>
      )}
    </form>
  );
}
