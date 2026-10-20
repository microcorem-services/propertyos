'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import {
  createUnit,
  PortfoliosRequestError,
  updateUnit,
  type Unit,
} from '@/lib/portfolios/client';

export function UnitEditorForm({
  mode,
  portfolioId,
  siteId,
  buildingId,
  organizationId,
  unit,
  cancelHref,
}: {
  mode: 'create' | 'edit';
  portfolioId: string;
  siteId: string;
  buildingId: string;
  organizationId: string;
  unit?: Unit;
  cancelHref: string;
}) {
  const [name, setName] = useState(unit?.name ?? '');
  const [unitCode, setUnitCode] = useState(unit?.unit_code ?? '');
  const [floor, setFloor] = useState(unit?.floor ?? '');
  const [area, setArea] = useState(unit?.area_sqm ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(
    unit?.status ?? 'active',
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Unit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const submissionLock = useRef(false);
  const unchanged =
    mode === 'edit' &&
    unit !== undefined &&
    name.trim() === unit.name &&
    (unitCode.trim() || null) === unit.unit_code &&
    (floor.trim() || null) === unit.floor &&
    (area.trim() || null) === unit.area_sqm &&
    status === unit.status;
  const invalidName = !name.trim() || name.trim().length > 200;
  const invalidArea =
    area.trim() !== '' &&
    (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(area.trim()) ||
      Number(area) <= 0);
  const buildingPath = `/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}`;
  const returnTo =
    mode === 'create'
      ? `${buildingPath}/units/new?organizationId=${encodeURIComponent(organizationId)}`
      : `${buildingPath}/units/${encodeURIComponent(unit?.id ?? '')}/edit?organizationId=${encodeURIComponent(organizationId)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || saved || unchanged) return;
    const cleanName = name.trim();
    const cleanCode = unitCode.trim();
    const cleanFloor = floor.trim();
    const cleanArea = area.trim();
    if (
      !cleanName ||
      cleanName.length > 200 ||
      cleanCode.length > 100 ||
      cleanFloor.length > 50 ||
      (cleanArea !== '' &&
        (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(cleanArea) ||
          Number(cleanArea) <= 0))
    ) {
      setError('Enter a unit name, optional code and floor within their limits, and an area greater than zero with up to two decimal places.');
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
        unit_code: cleanCode || null,
        floor: cleanFloor || null,
        area_sqm: cleanArea || null,
        status,
      };
      const result =
        mode === 'create'
          ? await createUnit(
              portfolioId,
              siteId,
              buildingId,
              organizationId,
              fields,
            )
          : unit
            ? await updateUnit(
                unit.id,
                portfolioId,
                siteId,
                buildingId,
                organizationId,
                fields,
              )
            : null;
      if (!result) {
        setError('Unit details could not be verified. Reload and try again.');
        setErrorStatus(503);
        return;
      }
      setSaved(result);
    } catch (reason) {
      setError(
        reason instanceof PortfoliosRequestError
          ? reason.message
          : 'Unit details could not be saved. Please try again.',
      );
      setErrorStatus(
        reason instanceof PortfoliosRequestError ? reason.status : 503,
      );
    } finally {
      submissionLock.current = false;
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <section className="bowera-editor-panel" aria-labelledby="unit-saved-title">
        <p className="bow-era-eyebrow">Changes saved</p>
        <h2 id="unit-saved-title" className="bowera-editor-title">
          {mode === 'create' ? 'Unit created' : 'Unit updated'}
        </h2>
        <p className="bowera-editor-copy">{saved.name} is ready to view.</p>
        <Link
          className="bow-era-button"
          href={`/portfolio/${encodeURIComponent(portfolioId)}/sites/${encodeURIComponent(siteId)}/buildings/${encodeURIComponent(buildingId)}/units/${encodeURIComponent(saved.id)}?organizationId=${encodeURIComponent(saved.organization_id)}`}
        >
          View unit
        </Link>
      </section>
    );
  }

  return (
    <form className="bowera-editor-panel" onSubmit={submit} noValidate>
      <p className="bow-era-eyebrow">
        {mode === 'create' ? 'Unit details' : 'Edit unit'}
      </p>
      <h2 className="bowera-editor-title">
        {mode === 'create' ? 'Create a unit' : 'Update unit details'}
      </h2>
      <p className="bowera-editor-copy">
        Only the name, unit code, floor, area and status can be changed here.
      </p>
      <div className="bowera-editor-fields">
        <div className="bowera-editor-field">
          <label htmlFor="unit-name">Unit name</label>
          <input
            id="unit-name"
            autoComplete="off"
            maxLength={200}
            required
            value={name}
            aria-invalid={errorStatus === 400 && invalidName}
            aria-describedby={
              errorStatus === 400 && invalidName
                ? 'unit-form-error'
                : 'unit-name-hint'
            }
            onChange={(event) => {
              setName(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
          />
          <span className="bowera-editor-hint" id="unit-name-hint">
            Up to 200 characters.
          </span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="unit-code">Unit code</label>
          <input
            id="unit-code"
            autoComplete="off"
            maxLength={100}
            value={unitCode}
            onChange={(event) => {
              setUnitCode(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
          />
          <span className="bowera-editor-hint">Optional; up to 100 characters.</span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="unit-floor">Floor</label>
          <input
            id="unit-floor"
            autoComplete="off"
            maxLength={50}
            value={floor}
            onChange={(event) => {
              setFloor(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
          />
          <span className="bowera-editor-hint">Optional; up to 50 characters.</span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="unit-area">Area (m²)</label>
          <input
            id="unit-area"
            inputMode="decimal"
            maxLength={13}
            value={area}
            aria-invalid={errorStatus === 400 && invalidArea}
            aria-describedby={
              errorStatus === 400 && invalidArea
                ? 'unit-form-error'
                : 'unit-area-hint'
            }
            onChange={(event) => {
              setArea(event.currentTarget.value);
              setError(null);
              setErrorStatus(null);
            }}
          />
          <span className="bowera-editor-hint" id="unit-area-hint">
            Optional; greater than zero, up to two decimal places.
          </span>
        </div>
        <div className="bowera-editor-field">
          <label htmlFor="unit-status">Status</label>
          <select
            id="unit-status"
            value={status}
            onChange={(event) => {
              setStatus(
                event.currentTarget.value === 'inactive' ? 'inactive' : 'active',
              );
              setError(null);
              setErrorStatus(null);
            }}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>
      {error && (
        <div className="bowera-editor-error" id="unit-form-error" role="alert">
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
          {saving ? 'Saving…' : mode === 'create' ? 'Create unit' : 'Save changes'}
        </button>
        <Link className="bow-era-button bow-era-button-secondary" href={cancelHref}>
          Cancel
        </Link>
      </div>
      {saving && (
        <p className="bowera-editor-hint" role="status" aria-live="polite">
          Saving unit details securely…
        </p>
      )}
    </form>
  );
}
