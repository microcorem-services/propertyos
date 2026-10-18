'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  Property,
  PropertyInput,
  PropertyStatus,
  propertyApi,
} from '@/lib/api';

type SortKey = 'name' | 'location' | 'units' | 'occupied' | 'status';
type FormMode = 'create' | 'view' | 'edit';

const blankProperty: PropertyInput = {
  name: '',
  location: '',
  units: 1,
  occupied: 0,
  status: 'Operational',
};

export default function PropertiesPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [ascending, setAscending] = useState(true);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [selected, setSelected] = useState<Property | null>(null);
  const [draft, setDraft] = useState<PropertyInput>(blankProperty);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [error, setError] = useState('');

  async function loadProperties() {
    setError('');
    setLoading(true);
    try {
      setProperties(await propertyApi.list());
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProperties();
  }, []);

  const visibleProperties = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return properties
      .filter((property) =>
        [property.name, property.location, property.id]
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
      )
      .sort((left, right) => {
        const first = left[sortKey];
        const second = right[sortKey];
        const comparison = typeof first === 'number' && typeof second === 'number'
          ? first - second
          : String(first).localeCompare(String(second));
        return ascending ? comparison : -comparison;
      });
  }, [ascending, properties, query, sortKey]);

  function openCreate() {
    setSelected(null);
    setDraft(blankProperty);
    setFormError('');
    setMode('create');
  }

  function openProperty(property: Property, nextMode: FormMode) {
    setSelected(property);
    setFormError('');
    setDraft({
      name: property.name,
      location: property.location,
      units: property.units,
      occupied: property.occupied,
      status: property.status,
    });
    setMode(nextMode);
  }

  function closeForm() {
    setMode(null);
    setSelected(null);
  }

  async function saveProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.occupied > draft.units) {
      setFormError('Occupied units cannot exceed total units.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (mode === 'edit' && selected) {
        await propertyApi.update(selected.id, draft);
      } else {
        await propertyApi.create(draft);
      }
      closeForm();
      await loadProperties();
    } catch (saveError) {
      setFormError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteProperty(property: Property) {
    if (!window.confirm(`Delete ${property.name}? This cannot be undone.`)) return;
    setError('');
    try {
      await propertyApi.delete(property.id);
      await loadProperties();
    } catch (deleteError) {
      setError((deleteError as Error).message);
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setAscending(!ascending);
    else {
      setSortKey(key);
      setAscending(true);
    }
  }

  const readOnly = mode === 'view';
  const sortableHeaders: [string, SortKey][] = [
    ['Property', 'name'],
    ['Location', 'location'],
    ['Units', 'units'],
    ['Occupied', 'occupied'],
    ['Status', 'status'],
  ];

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">MICROCOREM <span>PropertyOS</span></div>
        <nav aria-label="Main navigation">
          <Link href="/">Overview</Link>
          <Link className="active" href="/properties">Properties</Link>
        </nav>
        <p className="sidebarNote">Portfolio demo · Fictional records</p>
      </aside>
      <section className="content">
        <header>
          <div>
            <p className="eyebrow">ASSET MANAGEMENT</p>
            <h1>Properties</h1>
            <p className="muted">Manage the records in your portfolio.</p>
          </div>
          <button className="button primary" onClick={openCreate}>Add property</button>
        </header>

        {error && <p className="alert error" role="alert">{error}</p>}
        <section className="panel">
          <div className="toolbar">
            <div className="panelHeading"><h2>Portfolio</h2><span className="muted">{properties.length} records</span></div>
            <label className="searchField">
              <span>Search</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, location or ID" type="search" />
            </label>
          </div>

          {loading ? (
            <p className="state" role="status">Loading properties…</p>
          ) : error && properties.length === 0 ? (
            <div className="state"><p>Properties could not be loaded.</p><button className="button" onClick={() => void loadProperties()}>Retry</button></div>
          ) : properties.length === 0 ? (
            <div className="state emptyState"><p>No properties have been added.</p><button className="button primary" onClick={openCreate}>Add your first property</button></div>
          ) : visibleProperties.length === 0 ? (
            <p className="state">No properties match “{query}”.</p>
          ) : (
            <div className="tableWrap">
              <table>
                <thead><tr>
                  {sortableHeaders.map(([label, key]) => (
                    <th key={key} aria-sort={sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none'}>
                      <button className="sortButton" onClick={() => toggleSort(key)}>{label}{sortKey === key ? (ascending ? ' ↑' : ' ↓') : ''}</button>
                    </th>
                  ))}
                  <th>Actions</th>
                </tr></thead>
                <tbody>{visibleProperties.map((property) => (
                  <tr key={property.id}>
                    <td><b>{property.name}</b><small>{property.id.slice(0, 8)}</small></td>
                    <td>{property.location}</td>
                    <td>{property.units}</td>
                    <td>{property.occupied}</td>
                    <td><span className={`status ${property.status.toLowerCase()}`}>{property.status}</span></td>
                    <td className="rowActions">
                      <button onClick={() => openProperty(property, 'view')}>View</button>
                      <button onClick={() => openProperty(property, 'edit')}>Edit</button>
                      <button className="dangerText" onClick={() => void deleteProperty(property)}>Delete</button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
        <p className="footnote"><Link className="textLink" href="/">Back to overview</Link> · Demonstration records only</p>
      </section>

      {mode && (
        <div className="dialogBackdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeForm(); }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="propertyDialogTitle">
            <div className="panelHeading">
              <h2 id="propertyDialogTitle">{mode === 'create' ? 'Add property' : mode === 'edit' ? 'Edit property' : 'Property details'}</h2>
              <button className="closeButton" aria-label="Close" onClick={closeForm}>×</button>
            </div>
            {formError && <p className="alert error" role="alert">{formError}</p>}
            <form className="propertyForm" onSubmit={saveProperty}>
              <label>Property name<input required maxLength={120} value={draft.name} disabled={readOnly} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label>Location<input required maxLength={120} value={draft.location} disabled={readOnly} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label>
              <div className="formGrid">
                <label>Total units<input type="number" required min={1} max={100000} value={draft.units} disabled={readOnly} onChange={(event) => setDraft({ ...draft, units: Number(event.target.value) })} /></label>
                <label>Occupied units<input type="number" required min={0} max={draft.units} value={draft.occupied} disabled={readOnly} onChange={(event) => setDraft({ ...draft, occupied: Number(event.target.value) })} /></label>
              </div>
              <label>Status<select value={draft.status} disabled={readOnly} onChange={(event) => setDraft({ ...draft, status: event.target.value as PropertyStatus })}>
                <option>Operational</option><option>Review</option><option>Maintenance</option>
              </select></label>
              <div className="dialogActions">
                {readOnly ? <button type="button" className="button" onClick={() => setMode('edit')}>Edit property</button> : <button className="button primary" disabled={saving}>{saving ? 'Saving…' : mode === 'create' ? 'Create property' : 'Save changes'}</button>}
                <button type="button" className="button quiet" onClick={closeForm}>{readOnly ? 'Close' : 'Cancel'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}