'use client';

import Link from 'next/link';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EmptyState,
  ErrorMessage,
  LoadingState,
  PageHeading,
  Wordmark,
} from '@/components/bow-era-ui';
import {
  fetchBuildings,
  fetchPortfolios,
  fetchSites,
  fetchUnits,
  parsePortfolioOrganizationId,
  PortfoliosRequestError,
  type Building,
  type Portfolio,
  type Site,
  type Unit,
} from '@/lib/portfolios/client';
import {
  createLease,
  fetchLease,
  fetchLeasePermissions,
  fetchLeases,
  LeaseRequestError,
  updateLease,
  type Lease,
  type LeaseFields,
  type LeasePartyInput,
  type LeasePaymentFrequency,
  type LeaseStatus,
  type LeaseSummary,
  type LeaseUnitReference,
  type LeaseUpdateFields,
} from '@/lib/leases/client';

const PAGE_SIZE = 20;
const STATUSES: LeaseStatus[] = ['draft', 'active', 'expired', 'terminated'];
const CURRENCIES = ['GBP', 'EUR', 'USD'] as const;
const FREQUENCIES: LeasePaymentFrequency[] = ['monthly', 'quarterly', 'annually'];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Mode = 'register' | 'new' | 'detail';
type UnitOption = LeaseUnitReference & { label: string };
type LeaseFormValues = {
  lease_reference: string;
  start_date: string;
  expiry_date: string;
  break_date: string;
  rent_amount: string;
  currency: LeaseFields['currency'];
  payment_frequency: LeasePaymentFrequency;
  status: LeaseStatus;
  parties: LeasePartyInput[];
};

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function compareRentAmounts(left: string, right: string): number {
  const [leftWhole, leftFraction] = left.split('.');
  const [rightWhole, rightFraction] = right.split('.');
  const normalizedLeftWhole = leftWhole.replace(/^0+(?=\d)/, '');
  const normalizedRightWhole = rightWhole.replace(/^0+(?=\d)/, '');
  if (normalizedLeftWhole.length !== normalizedRightWhole.length) {
    return normalizedLeftWhole.length - normalizedRightWhole.length;
  }
  if (normalizedLeftWhole !== normalizedRightWhole) {
    return normalizedLeftWhole < normalizedRightWhole ? -1 : 1;
  }
  return leftFraction === rightFraction
    ? 0
    : leftFraction < rightFraction
      ? -1
      : 1;
}

function organizationFromLocation(): string | null {
  return parsePortfolioOrganizationId(window.location.search);
}

function leaseHref(leaseId: string, organizationId: string): string {
  if (!UUID_PATTERN.test(leaseId) || !UUID_PATTERN.test(organizationId)) {
    throw new Error('Invalid lease link.');
  }
  return `/leases/${encodeURIComponent(leaseId)}?organizationId=${encodeURIComponent(organizationId)}`;
}

function listHref(organizationId: string | null): string {
  return organizationId
    ? `/leases?organizationId=${encodeURIComponent(organizationId)}`
    : '/leases';
}

function signInHref(returnTo: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function leaseError(error: unknown, fallback: string): LeaseRequestError {
  return error instanceof LeaseRequestError
    ? error
    : new LeaseRequestError(fallback, 503);
}

function SiteHeader({ backHref }: { backHref: string }) {
  return (
    <header className="bow-era-topbar bow-era-frame lease-topbar">
      <Link href="/organizations" aria-label="BOWERA organisations home">
        <Wordmark />
      </Link>
      <Link className="bowera-portfolio-back" href={backHref}>
        Back to leases
      </Link>
    </header>
  );
}

function LeaseRegister({
  organizationId,
  returnTo,
}: {
  organizationId: string;
  returnTo: string;
}) {
  const [leases, setLeases] = useState<LeaseSummary[]>([]);
  const [permissions, setPermissions] = useState<{ can_read: boolean; can_create: boolean; can_update: boolean } | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<LeaseStatus | 'all'>('all');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'updated_at', desc: true },
  ]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LeaseRequestError | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(0);
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [permissionResult, pageResult] = await Promise.all([
          fetchLeasePermissions(organizationId),
          fetchLeases({
            organizationId,
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
            status,
            search,
            sortBy: sorting[0]?.id === 'rent' ? 'rent_amount' : sorting[0]?.id as
              | 'lease_reference'
              | 'status'
              | 'start_date'
              | 'expiry_date'
              | 'updated_at'
              | undefined,
            sortDirection: sorting[0]?.desc === false ? 'asc' : 'desc',
          }),
        ]);
        if (signal?.aborted) return;
        setPermissions(permissionResult);
        if (!permissionResult.can_read) {
          setError(new LeaseRequestError('Organisation access denied.', 403));
          return;
        }
        setLeases(pageResult.items);
        setTotal(pageResult.total);
      } catch (reason) {
        if (!signal?.aborted) {
          setError(leaseError(reason, 'Leases could not be loaded. Please try again.'));
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [organizationId, page, search, sorting, status],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const columns = useMemo<ColumnDef<LeaseSummary>[]>(
    () => [
      {
        accessorKey: 'lease_reference',
        header: 'Lease reference',
        cell: ({ row }) => (
          <Link
            className="lease-reference-link"
            href={leaseHref(row.original.id, organizationId)}
          >
            {row.original.lease_reference}
          </Link>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => {
          const value = getValue<LeaseStatus>();
          return <span className={`lease-status lease-status-${value}`}>{value}</span>;
        },
      },
      {
        id: 'units',
        accessorFn: (row) => row.units.length,
        header: 'Linked units',
        enableSorting: false,
        cell: ({ row }) => (
          <span title={row.original.units.map((unit) => unit.unit_id).join(', ')}>
            {row.original.units.length} {row.original.units.length === 1 ? 'unit' : 'units'}
          </span>
        ),
      },
      {
        id: 'parties',
        accessorFn: (row) =>
          row.parties
            .filter((party) => party.role === 'tenant')
            .map((party) => party.legal_name)
            .join(', '),
        header: 'Tenant(s)',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.parties
            .filter((party) => party.role === 'tenant')
            .map((party) => party.legal_name)
            .join(', '),
      },
      { accessorKey: 'start_date', header: 'Commencement', cell: ({ getValue }) => formatDate(getValue<string>()) },
      { accessorKey: 'expiry_date', header: 'Expiry', cell: ({ getValue }) => formatDate(getValue<string>()) },
      {
        id: 'rent',
        accessorFn: (row) => row.rent_amount,
        header: 'Rent',
        sortingFn: (rowA, rowB, columnId) =>
          compareRentAmounts(
            rowA.getValue<string>(columnId),
            rowB.getValue<string>(columnId),
          ),
        cell: ({ row }) => `${row.original.currency} ${row.original.rent_amount} / ${row.original.payment_frequency}`,
      },
      { accessorKey: 'updated_at', header: 'Last modified', cell: ({ getValue }) => formatTimestamp(getValue<string>()) },
      {
        id: 'actions',
        header: 'Actions',
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            className="bow-era-button bow-era-button-secondary lease-action"
            href={leaseHref(row.original.id, organizationId)}
            aria-label={`View lease ${row.original.lease_reference}`}
          >
            View
          </Link>
        ),
      },
    ],
    [organizationId],
  );
  const table = useReactTable({
    data: leases,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const returnHref = listHref(organizationId);
  return (
    <div className="bow-era-page bowera-portfolio-page">
      <SiteHeader backHref="/organizations" />
      <main className="bowera-portfolio-main bow-era-frame lease-main">
        <PageHeading
          eyebrow="Property operations"
          title="Lease register"
          description="Review and maintain the contractual information entered for this organisation."
        />
        <p className="lease-legal-note" role="note">
          Lease information is user-entered administrative data and has not been independently legally validated.
          BOWERA does not provide legal advice or infer contractual rights from dates.
        </p>
        <div className="lease-toolbar">
          <label>
            <span>Search leases</span>
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              aria-label="Search leases"
              placeholder="Reference or party name"
            />
          </label>
          <label>
            <span>Status</span>
            <select
              aria-label="Filter leases by status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as LeaseStatus | 'all');
                setPage(0);
              }}
            >
              <option value="all">All statuses</option>
              {STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          {permissions?.can_create && (
            <Link className="bow-era-button lease-create-button" href={`/leases/new?organizationId=${encodeURIComponent(organizationId)}`}>
              Create lease
            </Link>
          )}
        </div>
        {loading ? (
          <LoadingState label="Loading leases and checking organisation permissions…" />
        ) : error ? (
          <ErrorMessage
            title={error.status === 401 ? 'Your session has expired' : error.status === 403 ? 'Lease access is not available' : 'Leases could not be loaded'}
            action={error.status === 401 ? <Link className="bow-era-button" href={signInHref(returnTo)}>Sign in securely</Link> : undefined}
          >
            {error.message}
          </ErrorMessage>
        ) : leases.length === 0 ? (
          <EmptyState title={search || status !== 'all' ? 'No matching leases' : 'No leases yet'}>
            {search || status !== 'all'
              ? 'Adjust the search or status filter to see other leases.'
              : 'Create a lease to record a user-entered commercial agreement for this organisation.'}
          </EmptyState>
        ) : (
          <>
            <div className="lease-table-wrap">
              <table className="lease-table">
                <caption className="sr-only">Commercial leases for this organisation</caption>
                <thead>
                  {table.getHeaderGroups().map((group) => (
                    <tr key={group.id}>
                      {group.headers.map((header) => (
                        <th key={header.id} aria-sort={header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : 'none'}>
                          {header.isPlaceholder ? null : header.column.getCanSort() ? (
                            <button type="button" className="lease-sort-button" onClick={header.column.getToggleSortingHandler()}>
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              <span aria-hidden="true">{header.column.getIsSorted() === 'asc' ? ' ↑' : header.column.getIsSorted() === 'desc' ? ' ↓' : ' ↕'}</span>
                            </button>
                          ) : flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="lease-pagination" aria-label="Lease register pagination">
              <span>Page {page + 1} of {pageCount} · {total} leases</span>
              <div>
                <button className="bow-era-button bow-era-button-secondary" type="button" disabled={page === 0 || loading} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button>
                <button className="bow-era-button bow-era-button-secondary" type="button" disabled={page + 1 >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>Next</button>
              </div>
            </nav>
          </>
        )}
      </main>
    </div>
  );
}

function initialForm(lease?: Lease): LeaseFormValues {
  return {
    lease_reference: lease?.lease_reference ?? '',
    start_date: lease?.start_date ?? '',
    expiry_date: lease?.expiry_date ?? '',
    break_date: lease?.break_date ?? '',
    rent_amount: lease?.rent_amount ?? '',
    currency: lease?.currency ?? 'GBP',
    payment_frequency: lease?.payment_frequency ?? 'monthly',
    status: lease?.status ?? 'draft',
    parties: lease?.parties.map(({ legal_name, role, party_type }) => ({
      legal_name,
      role,
      party_type,
    })) ?? [
      { legal_name: '', role: 'landlord', party_type: 'organization' },
      { legal_name: '', role: 'tenant', party_type: 'organization' },
    ],
  };
}

function LeaseForm({
  organizationId,
  lease,
  canUpdate,
  onSaved,
  onCancel,
}: {
  organizationId: string;
  lease?: Lease;
  canUpdate: boolean;
  onSaved: (record: Lease) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(() => initialForm(lease));
  const [units, setUnits] = useState<LeaseUnitReference[]>(() => lease?.units ?? []);
  const [unitLinksChanged, setUnitLinksChanged] = useState(false);
  const [unitOptions, setUnitOptions] = useState<UnitOption[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [availableUnits, setAvailableUnits] = useState<Unit[]>([]);
  const [selectedPortfolio, setSelectedPortfolio] = useState('');
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedBuilding, setSelectedBuilding] = useState('');
  const [selectedUnit, setSelectedUnit] = useState('');
  const [assetError, setAssetError] = useState('');
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');

  useEffect(() => {
    let active = true;
    void fetchPortfolios(organizationId)
      .then((records) => {
        if (active) setPortfolios(records.filter((record) => record.status === 'active'));
      })
      .catch(() => {
        if (active) setAssetError('The organisation property hierarchy could not be loaded.');
      })
      .finally(() => {
        if (active) setLoadingAssets(false);
      });
    return () => { active = false; };
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    setSites([]);
    setBuildings([]);
    setAvailableUnits([]);
    setSelectedSite('');
    setSelectedBuilding('');
    setSelectedUnit('');
    if (!selectedPortfolio) return;
    const portfolio = portfolios.find((item) => item.id === selectedPortfolio);
    if (!portfolio) return;
    void fetchSites(portfolio.id, organizationId)
      .then((records) => { if (active) setSites(records.filter((record) => record.status === 'active')); })
      .catch(() => { if (active) setAssetError('Sites could not be loaded.'); });
    return () => { active = false; };
  }, [organizationId, portfolios, selectedPortfolio]);

  useEffect(() => {
    let active = true;
    setBuildings([]);
    setAvailableUnits([]);
    setSelectedBuilding('');
    setSelectedUnit('');
    if (!selectedPortfolio || !selectedSite) return;
    void fetchBuildings(selectedPortfolio, selectedSite, organizationId)
      .then((records) => { if (active) setBuildings(records.filter((record) => record.status === 'active')); })
      .catch(() => { if (active) setAssetError('Buildings could not be loaded.'); });
    return () => { active = false; };
  }, [organizationId, selectedPortfolio, selectedSite]);

  useEffect(() => {
    let active = true;
    setAvailableUnits([]);
    setSelectedUnit('');
    if (!selectedPortfolio || !selectedSite || !selectedBuilding) return;
    void fetchUnits(selectedPortfolio, selectedSite, selectedBuilding, organizationId)
      .then((records) => { if (active) setAvailableUnits(records.filter((record) => record.status === 'active')); })
      .catch(() => { if (active) setAssetError('Units could not be loaded.'); });
    return () => { active = false; };
  }, [organizationId, selectedPortfolio, selectedSite, selectedBuilding]);

  const update = <K extends keyof LeaseFormValues>(key: K, value: LeaseFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  function addUnit(): void {
    const unit = availableUnits.find((item) => item.id === selectedUnit);
    const portfolio = portfolios.find((item) => item.id === selectedPortfolio);
    const site = sites.find((item) => item.id === selectedSite);
    const building = buildings.find((item) => item.id === selectedBuilding);
    if (!unit || !portfolio || !site || !building || units.some((item) => item.unit_id === unit.id)) {
      setFieldError('Select an unlinked Unit from this organisation first.');
      return;
    }
    const reference: LeaseUnitReference = {
      portfolio_id: portfolio.id,
      site_id: site.id,
      building_id: building.id,
      unit_id: unit.id,
    };
    setUnits((current) => [...current, reference]);
    setUnitLinksChanged(true);
    setUnitOptions((current) => [
      ...current,
      {
        ...reference,
        label: `${portfolio.name} / ${site.name} / ${building.name} / ${unit.name}${unit.unit_code ? ` (${unit.unit_code})` : ''}`,
      },
    ]);
    setSelectedUnit('');
    setFieldError('');
  }

  function addParty(): void {
    setValues((current) => ({
      ...current,
      parties: [...current.parties, { legal_name: '', role: 'tenant', party_type: 'organization' }],
    }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    setFieldError('');
    if (!canUpdate) {
      setError('You do not have permission to update leases in this organisation.');
      return;
    }
    if (!values.lease_reference.trim() || values.lease_reference.trim().length > 100) {
      setFieldError('Enter a lease reference with between 1 and 100 characters.');
      return;
    }
    if (!units.length || units.length > 50) {
      setFieldError('Select between 1 and 50 active Units from the organisation property hierarchy.');
      return;
    }
    const rent = values.rent_amount.trim();
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(rent) || Number(rent) <= 0) {
      setFieldError('Enter a positive rent amount with no more than two decimal places.');
      return;
    }
    const parties = values.parties.map((party) => ({
      ...party,
      legal_name: party.legal_name.trim(),
    }));
    if (
      parties.length < 2 ||
      parties.length > 100 ||
      parties.some((party) => !party.legal_name || party.legal_name.length > 250) ||
      !parties.some((party) => party.role === 'landlord') ||
      !parties.some((party) => party.role === 'tenant')
    ) {
      setFieldError('Add valid party names and at least one landlord and one tenant.');
      return;
    }
    if (
      !values.start_date ||
      !values.expiry_date ||
      values.expiry_date < values.start_date ||
      (values.break_date && (values.break_date < values.start_date || values.break_date > values.expiry_date))
    ) {
      setFieldError('Check the start, expiry and optional break dates.');
      return;
    }
    const sharedFields = {
      ...values,
      lease_reference: values.lease_reference.trim(),
      rent_amount: rent.includes('.') ? rent : `${rent}.00`,
      break_date: values.break_date || null,
      parties,
    };
    const createFields: LeaseFields = { ...sharedFields, units };
    const updateFields: LeaseUpdateFields = {
      ...sharedFields,
      ...(unitLinksChanged ? { units } : {}),
    };
    setSaving(true);
    try {
      const record = lease
        ? await updateLease(organizationId, lease.id, updateFields)
        : await createLease(organizationId, createFields);
      onSaved(record);
    } catch (reason) {
      setError(leaseError(reason, 'The lease could not be saved.').message);
    } finally {
      setSaving(false);
    }
  }

  const currentUnitLabel = (unit: LeaseUnitReference) =>
    unitOptions.find((option) => option.unit_id === unit.unit_id)?.label ??
    `Previously linked Unit · ${unit.unit_id.slice(0, 8)}`;

  return (
    <form className="lease-form" onSubmit={(event) => void submit(event)}>
      <p className="lease-legal-note" role="note">
        Enter the contractual information supplied by your organisation. It has not been independently legally validated.
        This interface is administrative record-keeping, not legal advice. It does not determine legal rights or obligations.
      </p>
      <fieldset disabled={saving || !canUpdate}>
        <legend>Lease terms</legend>
        <div className="lease-form-grid">
          <label>Lease reference<input required maxLength={100} value={values.lease_reference} onChange={(event) => update('lease_reference', event.target.value)} /></label>
          <label>Status<select value={values.status} onChange={(event) => update('status', event.target.value as LeaseStatus)}>{STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>Commencement date<input type="date" required value={values.start_date} onChange={(event) => update('start_date', event.target.value)} /></label>
          <label>Expiry date<input type="date" required value={values.expiry_date} onChange={(event) => update('expiry_date', event.target.value)} /></label>
          <label>Optional break date<input type="date" value={values.break_date} onChange={(event) => update('break_date', event.target.value)} /></label>
          <label>Rent amount<input required inputMode="decimal" aria-describedby="lease-rent-help" value={values.rent_amount} onChange={(event) => update('rent_amount', event.target.value)} /><small id="lease-rent-help">Use a decimal amount with up to two decimal places; do not enter a currency symbol.</small></label>
          <label>Currency<select value={values.currency} onChange={(event) => update('currency', event.target.value as LeaseFields['currency'])}>{CURRENCIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>Payment frequency<select value={values.payment_frequency} onChange={(event) => update('payment_frequency', event.target.value as LeasePaymentFrequency)}>{FREQUENCIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        </div>
      </fieldset>

      <fieldset disabled={saving || !canUpdate}>
        <legend>Linked property units</legend>
        <p className="lease-field-note">Choose active Units from this organisation. Unit ownership and hierarchy are revalidated by the Lease service when saved.</p>
        {loadingAssets ? <p role="status">Loading authorised property hierarchy…</p> : assetError ? <p role="alert">{assetError}</p> : (
          <div className="lease-unit-picker">
            <label>Portfolio<select aria-label="Portfolio" value={selectedPortfolio} onChange={(event) => setSelectedPortfolio(event.target.value)}><option value="">Choose portfolio</option>{portfolios.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Site<select aria-label="Site" value={selectedSite} disabled={!selectedPortfolio} onChange={(event) => setSelectedSite(event.target.value)}><option value="">Choose site</option>{sites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Building<select aria-label="Building" value={selectedBuilding} disabled={!selectedSite} onChange={(event) => setSelectedBuilding(event.target.value)}><option value="">Choose building</option>{buildings.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Unit<select aria-label="Unit" value={selectedUnit} disabled={!selectedBuilding} onChange={(event) => setSelectedUnit(event.target.value)}><option value="">Choose active Unit</option>{availableUnits.map((item) => <option key={item.id} value={item.id}>{item.name}{item.unit_code ? ` (${item.unit_code})` : ''}</option>)}</select></label>
            <button className="bow-era-button bow-era-button-secondary" type="button" onClick={addUnit} disabled={!selectedUnit}>Add Unit</button>
          </div>
        )}
        <ul className="lease-linked-units" aria-label="Selected Units">
          {units.map((unit) => (
            <li key={unit.unit_id}>
              <span>{currentUnitLabel(unit)}</span>
              <button type="button" aria-label={`Remove ${currentUnitLabel(unit)}`} onClick={() => { setUnitLinksChanged(true); setUnits((current) => current.filter((item) => item.unit_id !== unit.unit_id)); }}>Remove</button>
            </li>
          ))}
          {units.length === 0 && <li>No Units selected.</li>}
        </ul>
      </fieldset>

      <fieldset disabled={saving || !canUpdate}>
        <legend>Legal parties</legend>
        <p className="lease-field-note">Enter party names as provided. This application does not verify legal identity or give legal advice.</p>
        {values.parties.map((party, index) => (
          <div className="lease-party-row" key={`${index}-${party.role}`}>
            <label>Party name<input required maxLength={250} value={party.legal_name} onChange={(event) => setValues((current) => ({ ...current, parties: current.parties.map((item, itemIndex) => itemIndex === index ? { ...item, legal_name: event.target.value } : item) }))} /></label>
            <label>Role<select value={party.role} onChange={(event) => setValues((current) => ({ ...current, parties: current.parties.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value as LeasePartyInput['role'] } : item) }))}><option value="landlord">Landlord</option><option value="tenant">Tenant</option><option value="guarantor">Guarantor</option></select></label>
            <label>Party type<select value={party.party_type} onChange={(event) => setValues((current) => ({ ...current, parties: current.parties.map((item, itemIndex) => itemIndex === index ? { ...item, party_type: event.target.value as LeasePartyInput['party_type'] } : item) }))}><option value="organization">Organisation</option><option value="individual">Individual</option></select></label>
            {values.parties.length > 2 && <button type="button" className="lease-remove-party" aria-label={`Remove party ${index + 1}`} onClick={() => setValues((current) => ({ ...current, parties: current.parties.filter((_, itemIndex) => itemIndex !== index) }))}>Remove party</button>}
          </div>
        ))}
        <button type="button" className="bow-era-button bow-era-button-secondary" onClick={addParty}>Add party</button>
      </fieldset>
      {fieldError && <p className="lease-form-error" role="alert">{fieldError}</p>}
      {error && <p className="lease-form-error" role="alert">{error}</p>}
      {!canUpdate && <p role="alert">You have read-only access to leases in this organisation.</p>}
      <div className="lease-form-actions">
        <button className="bow-era-button" type="submit" disabled={saving || !canUpdate}>{saving ? 'Saving…' : lease ? 'Save changes' : 'Create lease'}</button>
        <button className="bow-era-button bow-era-button-secondary" type="button" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}

function LeaseDetail({ lease, canUpdate, onEdit }: { lease: Lease; canUpdate: boolean; onEdit: () => void }) {
  const tenants = lease.parties.filter((party) => party.role === 'tenant');
  const landlords = lease.parties.filter((party) => party.role === 'landlord');
  const guarantors = lease.parties.filter((party) => party.role === 'guarantor');
  return (
    <section className="lease-detail">
      <div className="lease-detail-heading">
        <div>
          <span className={`lease-status lease-status-${lease.status}`}>{lease.status}</span>
          <h2>{lease.lease_reference}</h2>
        </div>
        {canUpdate && <button type="button" className="bow-era-button" onClick={onEdit}>Edit lease</button>}
      </div>
      <p className="lease-legal-note" role="note">Contractual information is user-entered and has not been independently legally validated. BOWERA does not provide legal advice.</p>
      <dl className="lease-detail-grid">
        <div><dt>Commencement</dt><dd>{formatDate(lease.start_date)}</dd></div>
        <div><dt>Expiry</dt><dd>{formatDate(lease.expiry_date)}</dd></div>
        <div><dt>Optional break date</dt><dd>{lease.break_date ? formatDate(lease.break_date) : 'Not recorded'}</dd></div>
        <div><dt>Rent</dt><dd>{lease.currency} {lease.rent_amount} / {lease.payment_frequency}</dd></div>
        <div><dt>Landlords</dt><dd>{landlords.map((party) => party.legal_name).join(', ') || 'Not recorded'}</dd></div>
        <div><dt>Tenants</dt><dd>{tenants.map((party) => party.legal_name).join(', ') || 'Not recorded'}</dd></div>
        <div><dt>Guarantors</dt><dd>{guarantors.map((party) => party.legal_name).join(', ') || 'Not recorded'}</dd></div>
      </dl>
      <section aria-labelledby="lease-units-heading">
        <h3 id="lease-units-heading">Linked Units</h3>
        <ul className="lease-linked-units">
          {lease.units.map((unit) => (
            <li key={unit.unit_id}>
              <span>
                {unit.verified_status === 'active'
                  ? `Verified active Unit · ${unit.unit_id.slice(0, 8)} · Building ${unit.building_id.slice(0, 8)}`
                  : `Unit reference unavailable · ${unit.unit_id.slice(0, 8)} · Building ${unit.building_id.slice(0, 8)}`}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="lease-audit-heading">
        <h3 id="lease-audit-heading">Change history</h3>
        {lease.audit_events.length === 0 ? <p>No audit history is available.</p> : (
          <ol className="lease-audit-list">
            {lease.audit_events.map((event, index) => (
              <li key={`${event.occurred_at}-${index}`}>
                <strong>{event.event_type === 'created' ? 'Lease recorded' : 'Lease updated'}</strong>
                <time dateTime={event.occurred_at}>{formatTimestamp(event.occurred_at)}</time>
                {event.changed_fields.length > 0 && <span>Changed: {event.changed_fields.join(', ')}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="lease-field-note">Dates are displayed as recorded. No renewal rights, break-clause validity, rent-review entitlement, legal notices or statutory obligations are inferred.</p>
    </section>
  );
}

function LeaseRegisterPage() {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setOrganizationId(organizationFromLocation());
    setChecked(true);
  }, []);

  return (
    <div className="bow-era-page bowera-portfolio-page">
      {!checked ? (
        <main className="bowera-portfolio-main bow-era-frame lease-main">
          <LoadingState label="Checking organisation selection…" />
        </main>
      ) : !organizationId ? (
        <main className="bowera-portfolio-main bow-era-frame lease-main">
          <ErrorMessage
            title="Choose an organisation"
            action={<Link className="bow-era-button" href="/organizations">Choose organisation</Link>}
          >
            Select an organisation before opening its lease register.
          </ErrorMessage>
        </main>
      ) : (
        <LeaseRegister organizationId={organizationId} returnTo={listHref(organizationId)} />
      )}
    </div>
  );
}

export function LeaseWorkspace({ mode, leaseId }: { mode: 'new' | 'detail'; leaseId?: string }) {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [lease, setLease] = useState<Lease | null>(null);
  const [permissions, setPermissions] = useState<{ can_read: boolean; can_create: boolean; can_update: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(mode === 'new');
  const [error, setError] = useState<LeaseRequestError | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const org = organizationFromLocation();
    setOrganizationId(org);
    if (!org || (leaseId !== undefined && !UUID_PATTERN.test(leaseId))) {
      setError(new LeaseRequestError('Choose a valid organisation or lease.', 400));
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void Promise.all([
      fetchLeasePermissions(org),
      mode === 'detail' && leaseId ? fetchLease(org, leaseId) : Promise.resolve(null),
    ])
      .then(([access, record]) => {
        if (!active) return;
        setPermissions(access);
        setLease(record);
        if (!access.can_read && mode !== 'new') {
          setError(new LeaseRequestError('Organisation access denied.', 403));
        } else if (mode === 'new' && !access.can_create) {
          setError(new LeaseRequestError('Lease creation is not permitted.', 403));
        } else if (mode === 'detail' && !record) {
          setError(new LeaseRequestError('Lease not found.', 404));
        }
      })
      .catch((reason) => {
        if (active) setError(leaseError(reason, 'Lease details could not be verified.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [leaseId, mode]);

  const backHref = listHref(organizationId);
  function saved(record: Lease): void {
    setLease(record);
    setNotice(mode === 'new' ? 'Lease created successfully.' : 'Lease changes saved.');
    setEditing(false);
  }

  return (
    <div className="bow-era-page bowera-portfolio-page">
      <SiteHeader backHref={backHref} />
      <main className="bowera-portfolio-main bow-era-frame lease-main">
        <nav className="bowera-detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/organizations">Organisations</Link><span aria-hidden="true">/</span>
          <Link href={backHref}>Lease register</Link><span aria-hidden="true">/</span>
          <span aria-current="page">{mode === 'new' ? 'Create lease' : lease?.lease_reference ?? 'Lease details'}</span>
        </nav>
        <PageHeading
          eyebrow="Property operations"
          title={mode === 'new' ? 'Create a lease record' : lease?.lease_reference ?? 'Lease details'}
          description={mode === 'new' ? 'Record contractual information supplied by authorised users.' : 'View the recorded lease terms, linked property Units and change history.'}
        />
        {notice && <p className="lease-success" role="status">{notice}</p>}
        {loading ? <LoadingState label="Loading lease and checking organisation permissions…" /> : error ? (
          <ErrorMessage
            title={error.status === 401 ? 'Your session has expired' : error.status === 403 ? 'Lease access is not available' : error.status === 404 ? 'Lease not found' : 'Lease could not be loaded'}
            action={error.status === 401 ? <Link className="bow-era-button" href={signInHref(`${mode === 'new' ? '/leases/new' : `/leases/${encodeURIComponent(leaseId ?? '')}`}?organizationId=${encodeURIComponent(organizationId ?? '')}`)}>Sign in securely</Link> : <Link className="bow-era-button" href="/organizations">Choose organisation</Link>}
          >
            {error.message}
          </ErrorMessage>
        ) : lease && !editing ? (
          <>
            <LeaseDetail
              lease={lease}
              canUpdate={Boolean(permissions?.can_update || (mode === 'new' && permissions?.can_create))}
              onEdit={() => { setNotice(''); setEditing(true); }}
            />
            {mode === 'new' && (
              <Link className="bow-era-button" href={leaseHref(lease.id, lease.organization_id)}>
                Open lease record
              </Link>
            )}
          </>
        ) : (
          <LeaseForm
            organizationId={organizationId ?? ''}
            lease={mode === 'detail' ? lease ?? undefined : undefined}
            canUpdate={mode === 'new' ? Boolean(permissions?.can_create) : Boolean(permissions?.can_update)}
            onSaved={saved}
            onCancel={() => mode === 'detail' ? setEditing(false) : window.location.assign(backHref)}
          />
        )}
      </main>
    </div>
  );
}

export function LeasePage({ mode, leaseId }: { mode: Mode; leaseId?: string }) {
  if (mode === 'register') return <LeaseRegisterPage />;
  return (
    <LeaseWorkspace
      mode={mode}
      {...(leaseId === undefined ? {} : { leaseId })}
    />
  );
}
