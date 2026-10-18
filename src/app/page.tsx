'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DashboardStats, Property, propertyApi } from '@/lib/api';

export default function Home() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([propertyApi.stats(), propertyApi.list()])
      .then(([nextStats, nextProperties]) => {
        setStats(nextStats);
        setProperties(nextProperties.slice(0, 5));
      })
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">MICROCOREM <span>PropertyOS</span></div>
        <nav aria-label="Main navigation">
          <Link className="active" href="/">Overview</Link>
          <Link href="/properties">Properties</Link>
        </nav>
        <p className="sidebarNote">Portfolio demo · Fictional records</p>
      </aside>
      <section className="content">
        <header>
          <div>
            <p className="eyebrow">ASSET MANAGEMENT</p>
            <h1>Property overview</h1>
            <p className="muted">A clear view of your property portfolio.</p>
          </div>
          <span className="tag">Demonstration</span>
        </header>

        {error && <p className="alert error" role="alert">Could not load portfolio: {error}</p>}

        <div className="metrics" aria-label="Portfolio statistics">
          <article><span>Properties</span><strong>{loading ? '—' : stats?.properties ?? 0}</strong></article>
          <article><span>Total units</span><strong>{loading ? '—' : stats?.total_units ?? 0}</strong></article>
          <article><span>Occupancy</span><strong>{loading ? '—' : `${stats?.occupancy_percent ?? 0}%`}</strong></article>
        </div>

        <section className="panel" id="properties">
          <div className="panelHeading">
            <h2>Properties</h2>
            <Link className="textLink" href="/properties">Manage properties</Link>
          </div>
          {loading ? (
            <p className="state" role="status">Loading portfolio…</p>
          ) : error ? (
            <p className="state">Portfolio data is unavailable.</p>
          ) : properties.length === 0 ? (
            <div className="state emptyState">
              <p>No properties yet.</p>
              <Link className="button primary" href="/properties">Add your first property</Link>
            </div>
          ) : (
            <div className="tableWrap">
              <table>
                <thead><tr><th>Property</th><th>Location</th><th>Units</th><th>Occupied</th><th>Status</th></tr></thead>
                <tbody>{properties.map((property) => (
                  <tr key={property.id}>
                    <td><b>{property.name}</b><small>{property.id.slice(0, 8)}</small></td>
                    <td>{property.location}</td>
                    <td>{property.units}</td>
                    <td>{property.occupied}</td>
                    <td><span className={`status ${property.status.toLowerCase()}`}>{property.status}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
        <p className="footnote">Live portfolio data · Demonstration only · No authentication</p>
      </section>
    </main>
  );
}