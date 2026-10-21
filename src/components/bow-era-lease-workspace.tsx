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
  createRentSchedule,
  createPropertyExpense,
  fetchRentSchedules,
  fetchPropertyExpenses,
  generateRentSchedule,
  updatePropertyExpense,
  updateRentSchedule,
  type Lease,
  type PropertyExpense,
  type PropertyExpenseAssetLevel,
  type PropertyExpenseCategory,
  type PropertyExpenseFields,
  type PropertyExpenseUpdateFields,
  type LeaseFields,
  type LeasePartyInput,
  type LeasePaymentFrequency,
  type LeaseStatus,
  type LeaseSummary,
  type LeaseUnitReference,
  type LeaseUpdateFields,
  type RentSchedule,
  type RentScheduleFields,
  type RentScheduleFrequency,
} from '@/lib/leases/client';

const PAGE_SIZE = 20;
const STATUSES: LeaseStatus[] = ['draft', 'active', 'expired', 'terminated'];
const CURRENCIES = ['GBP', 'EUR', 'USD'] as const;
const FREQUENCIES: LeasePaymentFrequency[] = ['monthly', 'quarterly', 'annually'];
const EXPENSE_ASSET_LEVELS: PropertyExpenseAssetLevel[] = [
  'portfolio',
  'site',
  'building',
  'unit',
];
const EXPENSE_CATEGORIES: PropertyExpenseCategory[] = [
  'utilities',
  'maintenance',
  'insurance',
  'repairs',
  'cleaning',
  'security',
  'shared_facilities',
  'other',
];
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

type PropertyExpenseFormState = {
  asset_level: PropertyExpenseAssetLevel;
  portfolio_id: string;
  site_id: string;
  building_id: string;
  unit_id: string;
  category: PropertyExpenseCategory;
  description: string;
  amount: string;
  currency: Lease['currency'];
  expense_date: string;
  recoverability: 'recoverable' | 'non_recoverable';
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

function propertyExpenseError(error: unknown, fallback: string): Error {
  return error instanceof LeaseRequestError || error instanceof PortfoliosRequestError
    ? error
    : new Error(fallback);
}

function expenseAssetLabel(expense: PropertyExpense): string {
  if (expense.asset_level === 'portfolio') return `Portfolio ${expense.portfolio_id.slice(0, 8)}`;
  if (expense.asset_level === 'site') return `Site ${expense.site_id?.slice(0, 8) ?? 'unknown'}`;
  if (expense.asset_level === 'building') return `Building ${expense.building_id?.slice(0, 8) ?? 'unknown'}`;
  return `Unit ${expense.unit_id?.slice(0, 8) ?? 'unknown'}`;
}

function expenseCategoryLabel(category: PropertyExpenseCategory): string {
  return category.replaceAll('_', ' ');
}

function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure random number generation is unavailable.');
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
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

type RentScheduleFormState = {
  charge_category: RentSchedule['charge_category'];
  description: string;
  amount_per_period: string;
  payment_frequency: RentScheduleFrequency;
  start_date: string;
  end_date: string;
  due_day: number;
};

function RentScheduleForm({
  lease,
  schedule,
  saving,
  onCancel,
  onSaved,
}: {
  lease: Lease;
  schedule?: RentSchedule;
  saving: boolean;
  onCancel: () => void;
  onSaved: (value: RentSchedule) => void;
}) {
  const [values, setValues] = useState<RentScheduleFormState>({
    charge_category: schedule?.charge_category ?? 'base_rent',
    description: schedule?.description ?? 'Base rent',
    amount_per_period: schedule?.amount_per_period ?? '',
    payment_frequency: schedule?.payment_frequency ?? 'monthly',
    start_date: schedule?.start_date ?? lease.start_date,
    end_date: schedule?.end_date ?? lease.expiry_date,
    due_day: schedule?.due_day ?? 1,
  });
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    const amount = values.amount_per_period.trim();
    if (
      !/^\d{1,12}(?:\.\d{1,2})?$/.test(amount) ||
      !/[1-9]/.test(amount.replace('.', ''))
    ) {
      setError('Enter a positive fixed amount with no more than two decimal places.');
      return;
    }
    if (
      !values.start_date ||
      !values.end_date ||
      values.end_date < values.start_date ||
      values.start_date < lease.start_date ||
      values.end_date > lease.expiry_date
    ) {
      setError('Schedule dates must fall within the recorded lease term.');
      return;
    }
    const fields: RentScheduleFields = {
      charge_category: values.charge_category,
      description: values.description.trim(),
      amount_per_period: amount.includes('.') ? amount : `${amount}.00`,
      payment_frequency: values.payment_frequency,
      start_date: values.start_date,
      end_date: values.end_date,
      due_day: values.due_day,
      short_month_rule: 'clamp_to_month_end',
    };
    try {
      const result = schedule
        ? await updateRentSchedule(
            lease.organization_id,
            lease.id,
            schedule.id,
            fields,
          )
        : await createRentSchedule(lease.organization_id, lease.id, fields);
      onSaved(result);
    } catch (reason) {
      setError(leaseError(reason, 'The rent schedule could not be saved.').message);
    }
  }

  return (
    <form className="lease-form rent-schedule-form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={saving}>
        <legend>{schedule ? 'Edit draft charge schedule' : 'Create rent or charge schedule'}</legend>
        <p className="lease-field-note">
          Amounts are fixed per scheduled instalment. No amount is prorated. A schedule boundary within a payment period is flagged for manual review.
        </p>
        <div className="lease-form-grid">
          <label>
            Charge category
            <select
              value={values.charge_category}
              onChange={(event) => setValues((current) => ({
                ...current,
                charge_category: event.target.value as RentSchedule['charge_category'],
                description:
                  current.description === 'Base rent' && event.target.value !== 'base_rent'
                    ? ''
                    : current.description,
              }))}
            >
              <option value="base_rent">Base rent</option>
              <option value="service_charge">Service charge</option>
              <option value="building_maintenance">Building maintenance</option>
              <option value="insurance_contribution">Insurance contribution</option>
              <option value="shared_facilities">Shared facilities / common areas</option>
              <option value="other_property_charge">Other property charge</option>
            </select>
          </label>
          <label>
            Description
            <input
              required
              maxLength={250}
              value={values.description}
              onChange={(event) => setValues((current) => ({
                ...current,
                description: event.target.value,
              }))}
            />
          </label>
          <label>
            Amount per instalment ({lease.currency})
            <input
              required
              inputMode="decimal"
              aria-describedby="rent-schedule-amount-help"
              value={values.amount_per_period}
              onChange={(event) => setValues((current) => ({ ...current, amount_per_period: event.target.value }))}
            />
            <small id="rent-schedule-amount-help">Use a positive decimal amount with up to two decimal places.</small>
          </label>
          <label>
            Payment frequency
            <select
              value={values.payment_frequency}
              onChange={(event) => setValues((current) => ({ ...current, payment_frequency: event.target.value as RentScheduleFrequency }))}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annually">Annually</option>
            </select>
          </label>
          <label>
            Schedule commencement
            <input
              type="date"
              required
              value={values.start_date}
              min={lease.start_date}
              max={lease.expiry_date}
              onChange={(event) => setValues((current) => ({ ...current, start_date: event.target.value }))}
            />
          </label>
          <label>
            Schedule end
            <input
              type="date"
              required
              value={values.end_date}
              min={lease.start_date}
              max={lease.expiry_date}
              onChange={(event) => setValues((current) => ({ ...current, end_date: event.target.value }))}
            />
          </label>
          <label>
            Day of month payments are due
            <select
              value={values.due_day}
              onChange={(event) => setValues((current) => ({ ...current, due_day: Number(event.target.value) }))}
            >
              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>{day}</option>
              ))}
            </select>
          </label>
          <label>
            Short-month rule
            <select value="clamp_to_month_end" disabled>
              <option value="clamp_to_month_end">Use the month's final day when due day is unavailable</option>
            </select>
          </label>
        </div>
      </fieldset>
      {error && <p className="lease-form-error" role="alert">{error}</p>}
      <div className="lease-form-actions">
        <button className="bow-era-button" type="submit" disabled={saving}>
          {saving ? 'Saving…' : schedule ? 'Save draft schedule' : 'Create draft schedule'}
        </button>
        <button className="bow-era-button bow-era-button-secondary" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RentSchedulesPanel({
  organizationId,
  lease,
  canUpdate,
  onLeaseUpdated,
}: {
  organizationId: string;
  lease: Lease;
  canUpdate: boolean;
  onLeaseUpdated: (lease: Lease) => void;
}) {
  const [schedules, setSchedules] = useState<RentSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<RentSchedule | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSchedules(await fetchRentSchedules(organizationId, lease.id));
    } catch (reason) {
      setError(leaseError(reason, 'Rent schedules could not be loaded.').message);
    } finally {
      setLoading(false);
    }
  }, [lease.id, organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function finishMutation(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      await refresh();
      onLeaseUpdated(await fetchLease(organizationId, lease.id));
    } catch (reason) {
      setError(leaseError(reason, 'The rent schedule change could not be verified.').message);
    } finally {
      setSaving(false);
    }
  }

  async function activate(schedule: RentSchedule): Promise<void> {
    setSaving(true);
    setError('');
    try {
      await updateRentSchedule(organizationId, lease.id, schedule.id, { status: 'active' });
      await finishMutation();
    } catch (reason) {
      setError(leaseError(reason, 'The rent schedule could not be activated.').message);
      setSaving(false);
    }
  }

  async function regenerate(schedule: RentSchedule): Promise<void> {
    setSaving(true);
    setError('');
    try {
      await generateRentSchedule(organizationId, lease.id, schedule.id);
      await finishMutation();
    } catch (reason) {
      setError(leaseError(reason, 'Expected instalments could not be refreshed.').message);
      setSaving(false);
    }
  }

  return (
    <section className="lease-rent-schedules" aria-labelledby="rent-schedules-heading">
      <div className="lease-section-heading">
        <h3 id="rent-schedules-heading">Rent and service charge schedules</h3>
        {canUpdate && lease.status !== 'expired' && lease.status !== 'terminated' && !creating && !editingSchedule && (
          <button
            className="bow-era-button bow-era-button-secondary"
            type="button"
            onClick={() => setCreating(true)}
          >
            Create schedule
          </button>
        )}
      </div>
      <p className="lease-field-note">
        Expected instalments only; this is not payment collection. Currency follows the lease. Due days clamp to the final day of shorter months. Partial boundary periods are flagged and are not prorated.
      </p>
      {loading ? <p role="status">Loading rent schedules…</p> : null}
      {error && <p className="lease-form-error" role="alert">{error}</p>}
      {!loading && schedules.length === 0 && !creating && (
        <p>No rent or service charge schedules are recorded for this lease.</p>
      )}
      {schedules.map((schedule) => (
        <article className="lease-rent-schedule" key={schedule.id}>
          <div className="lease-section-heading">
            <h4>{schedule.charge_category.replaceAll('_', ' ')} · {schedule.status}</h4>
            {canUpdate && schedule.status === 'draft' && !editingSchedule && !creating && (
              <div className="lease-form-actions">
                <button
                  className="bow-era-button bow-era-button-secondary"
                  type="button"
                  disabled={saving}
                  onClick={() => setEditingSchedule(schedule)}
                >
                  Edit draft
                </button>
                <button
                  className="bow-era-button"
                  type="button"
                  disabled={saving}
                  onClick={() => void activate(schedule)}
                >
                  {saving ? 'Saving…' : 'Activate schedule'}
                </button>
              </div>
            )}
            {canUpdate && schedule.status === 'active' && (
              <button
                className="bow-era-button bow-era-button-secondary"
                type="button"
                disabled={saving}
                onClick={() => void regenerate(schedule)}
              >
                {saving ? 'Refreshing…' : 'Refresh expected instalments'}
              </button>
            )}
          </div>
          <dl className="lease-detail-grid rent-schedule-grid">
            <div><dt>Amount per instalment</dt><dd>{schedule.currency} {schedule.amount_per_period}</dd></div>
            <div><dt>Frequency</dt><dd>{schedule.payment_frequency}</dd></div>
            <div><dt>Schedule dates</dt><dd>{formatDate(schedule.start_date)} – {formatDate(schedule.end_date)}</dd></div>
            <div><dt>Due day</dt><dd>{schedule.due_day}; shorter months use their final day</dd></div>
          </dl>
          {schedule.manual_review_reasons.length > 0 && (
            <p className="lease-form-error" role="note">
              Manual review required for {schedule.manual_review_reasons.map((reason) =>
                reason === 'commencement_not_on_due_date'
                  ? 'the commencement boundary'
                  : 'the end boundary',
              ).join(' and ')}. No partial amount has been calculated.
            </p>
          )}
          <div className="lease-table-wrap lease-installments-wrap">
            <table className="lease-table lease-installments-table">
              <caption>Expected instalments for this schedule</caption>
              <thead>
                <tr><th scope="col">Due date</th><th scope="col">Expected amount</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                {schedule.installments.map((installment) => (
                  <tr key={installment.id}>
                    <td>{formatDate(installment.due_date)}</td>
                    <td>{installment.currency} {installment.amount}</td>
                    <td>{installment.status}</td>
                  </tr>
                ))}
                {schedule.installments.length === 0 && (
                  <tr><td colSpan={3}>No instalments generated.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {editingSchedule?.id === schedule.id && (
            <RentScheduleForm
              lease={lease}
              schedule={schedule}
              saving={saving}
              onCancel={() => setEditingSchedule(null)}
              onSaved={() => {
                setEditingSchedule(null);
                void finishMutation();
              }}
            />
          )}
        </article>
      ))}
      {creating && (
        <RentScheduleForm
          lease={lease}
          saving={saving}
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void finishMutation();
          }}
        />
      )}
    </section>
  );
}

function PropertyExpenseForm({
  organizationId,
  defaultCurrency,
  expense,
  saving,
  onCancel,
  onSaved,
}: {
  organizationId: string;
  defaultCurrency: Lease['currency'];
  expense?: PropertyExpense;
  saving: boolean;
  onCancel: () => void;
  onSaved: (value: PropertyExpense) => void;
}) {
  const [values, setValues] = useState<PropertyExpenseFormState>({
    asset_level: expense?.asset_level ?? 'unit',
    portfolio_id: expense?.portfolio_id ?? '',
    site_id: expense?.site_id ?? '',
    building_id: expense?.building_id ?? '',
    unit_id: expense?.unit_id ?? '',
    category: expense?.category ?? 'maintenance',
    description: expense?.description ?? '',
    amount: expense?.amount ?? '',
    currency: expense?.currency ?? defaultCurrency,
    expense_date: expense?.expense_date ?? '',
    recoverability: expense?.recoverability ?? 'recoverable',
  });
  const [assetError, setAssetError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(expense === undefined);

  const isEdit = expense !== undefined;

  useEffect(() => {
    if (isEdit) return;
    let active = true;
    void fetchPortfolios(organizationId)
      .then((items) => {
        if (active) setPortfolios(items.filter((item) => item.status === 'active'));
      })
      .catch((reason) => {
        if (active) setAssetError(propertyExpenseError(reason, 'Portfolios could not be loaded.').message);
      })
      .finally(() => {
        if (active) setLoadingAssets(false);
      });
    return () => { active = false; };
  }, [isEdit, organizationId]);

  useEffect(() => {
    if (isEdit) return;
    let active = true;
    setSites([]);
    setBuildings([]);
    setUnits([]);
    setValues((current) => ({ ...current, site_id: '', building_id: '', unit_id: '' }));
    if (!values.portfolio_id || values.asset_level === 'portfolio') return;
    void fetchSites(values.portfolio_id, organizationId)
      .then((items) => {
        if (active) setSites(items.filter((item) => item.status === 'active'));
      })
      .catch((reason) => {
        if (active) setAssetError(propertyExpenseError(reason, 'Sites could not be loaded.').message);
      });
    return () => { active = false; };
  }, [isEdit, organizationId, values.asset_level, values.portfolio_id]);

  useEffect(() => {
    if (isEdit) return;
    let active = true;
    setBuildings([]);
    setUnits([]);
    setValues((current) => ({ ...current, building_id: '', unit_id: '' }));
    if (!values.portfolio_id || !values.site_id || values.asset_level === 'site') return;
    void fetchBuildings(values.portfolio_id, values.site_id, organizationId)
      .then((items) => {
        if (active) setBuildings(items.filter((item) => item.status === 'active'));
      })
      .catch((reason) => {
        if (active) setAssetError(propertyExpenseError(reason, 'Buildings could not be loaded.').message);
      });
    return () => { active = false; };
  }, [isEdit, organizationId, values.asset_level, values.portfolio_id, values.site_id]);

  useEffect(() => {
    if (isEdit) return;
    let active = true;
    setUnits([]);
    setValues((current) => ({ ...current, unit_id: '' }));
    if (
      !values.portfolio_id ||
      !values.site_id ||
      !values.building_id ||
      values.asset_level === 'building'
    ) {
      return;
    }
    void fetchUnits(values.portfolio_id, values.site_id, values.building_id, organizationId)
      .then((items) => {
        if (active) setUnits(items.filter((item) => item.status === 'active'));
      })
      .catch((reason) => {
        if (active) setAssetError(propertyExpenseError(reason, 'Units could not be loaded.').message);
      });
    return () => { active = false; };
  }, [isEdit, organizationId, values.asset_level, values.portfolio_id, values.site_id, values.building_id]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFieldError('');
    const amount = values.amount.trim();
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(amount) || !/[1-9]/.test(amount.replace('.', ''))) {
      setFieldError('Enter a positive amount with no more than two decimal places.');
      return;
    }
    if (!values.description.trim() || values.description.trim().length > 250) {
      setFieldError('Enter a description between 1 and 250 characters.');
      return;
    }
    if (!values.expense_date) {
      setFieldError('Select an expense date.');
      return;
    }
    if (!isEdit) {
      if (!values.portfolio_id) {
        setFieldError('Select a portfolio for this expense.');
        return;
      }
      if ((values.asset_level === 'site' || values.asset_level === 'building' || values.asset_level === 'unit') && !values.site_id) {
        setFieldError('Select a site for this expense.');
        return;
      }
      if ((values.asset_level === 'building' || values.asset_level === 'unit') && !values.building_id) {
        setFieldError('Select a building for this expense.');
        return;
      }
      if (values.asset_level === 'unit' && !values.unit_id) {
        setFieldError('Select a unit for this expense.');
        return;
      }
    }
    try {
      if (isEdit) {
        const payload: PropertyExpenseUpdateFields = {
          category: values.category,
          description: values.description.trim(),
          amount: amount.includes('.') ? amount : `${amount}.00`,
          currency: values.currency,
          expense_date: values.expense_date,
          recoverability: values.recoverability,
        };
        onSaved(await updatePropertyExpense(organizationId, expense.id, payload));
      } else {
        const payload: PropertyExpenseFields = {
          idempotency_key: newIdempotencyKey(),
          asset_level: values.asset_level,
          portfolio_id: values.portfolio_id,
          ...(values.site_id ? { site_id: values.site_id } : {}),
          ...(values.building_id ? { building_id: values.building_id } : {}),
          ...(values.unit_id ? { unit_id: values.unit_id } : {}),
          category: values.category,
          description: values.description.trim(),
          amount: amount.includes('.') ? amount : `${amount}.00`,
          currency: values.currency,
          expense_date: values.expense_date,
          recoverability: values.recoverability,
        };
        onSaved(await createPropertyExpense(organizationId, payload));
      }
    } catch (reason) {
      setFieldError(propertyExpenseError(reason, 'The property expense could not be saved.').message);
    }
  }

  return (
    <form className="lease-form rent-schedule-form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={saving}>
        <legend>{isEdit ? 'Edit property expense' : 'Record property expense'}</legend>
        <p className="lease-field-note">
          Expenses remain separate from tenant obligations. Recoverable expenses are flagged for manual review and allocation decisions.
        </p>
        {!isEdit && loadingAssets ? <p role="status">Loading authorised property hierarchy…</p> : null}
        {assetError ? <p className="lease-form-error" role="alert">{assetError}</p> : null}
        <div className="lease-form-grid">
          {!isEdit && (
            <>
              <label>
                Asset level
                <select
                  value={values.asset_level}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      asset_level: event.target.value as PropertyExpenseAssetLevel,
                    }))}
                >
                  {EXPENSE_ASSET_LEVELS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                Portfolio
                <select
                  aria-label="Expense portfolio"
                  value={values.portfolio_id}
                  onChange={(event) => setValues((current) => ({ ...current, portfolio_id: event.target.value }))}
                >
                  <option value="">Choose portfolio</option>
                  {portfolios.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              {values.asset_level !== 'portfolio' && (
                <label>
                  Site
                  <select
                    aria-label="Expense site"
                    value={values.site_id}
                    disabled={!values.portfolio_id}
                    onChange={(event) => setValues((current) => ({ ...current, site_id: event.target.value }))}
                  >
                    <option value="">Choose site</option>
                    {sites.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {(values.asset_level === 'building' || values.asset_level === 'unit') && (
                <label>
                  Building
                  <select
                    aria-label="Expense building"
                    value={values.building_id}
                    disabled={!values.site_id}
                    onChange={(event) => setValues((current) => ({ ...current, building_id: event.target.value }))}
                  >
                    <option value="">Choose building</option>
                    {buildings.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {values.asset_level === 'unit' && (
                <label>
                  Unit
                  <select
                    aria-label="Expense unit"
                    value={values.unit_id}
                    disabled={!values.building_id}
                    onChange={(event) => setValues((current) => ({ ...current, unit_id: event.target.value }))}
                  >
                    <option value="">Choose active unit</option>
                    {units.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}{item.unit_code ? ` (${item.unit_code})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          <label>
            Category
            <select
              value={values.category}
              onChange={(event) => setValues((current) => ({ ...current, category: event.target.value as PropertyExpenseCategory }))}
            >
              {EXPENSE_CATEGORIES.map((category) => (
                <option key={category} value={category}>{expenseCategoryLabel(category)}</option>
              ))}
            </select>
          </label>
          <label>
            Description
            <input
              required
              maxLength={250}
              value={values.description}
              onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))}
            />
          </label>
          <label>
            Amount
            <input
              required
              inputMode="decimal"
              value={values.amount}
              onChange={(event) => setValues((current) => ({ ...current, amount: event.target.value }))}
            />
          </label>
          <label>
            Currency
            <select
              value={values.currency}
              onChange={(event) => setValues((current) => ({ ...current, currency: event.target.value as Lease['currency'] }))}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>{currency}</option>
              ))}
            </select>
          </label>
          <label>
            Expense date
            <input
              type="date"
              required
              value={values.expense_date}
              onChange={(event) => setValues((current) => ({ ...current, expense_date: event.target.value }))}
            />
          </label>
          <label>
            Recoverability
            <select
              value={values.recoverability}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  recoverability: event.target.value as 'recoverable' | 'non_recoverable',
                }))}
            >
              <option value="recoverable">Potentially recoverable (manual review)</option>
              <option value="non_recoverable">Non-recoverable</option>
            </select>
          </label>
        </div>
      </fieldset>
      {fieldError ? <p className="lease-form-error" role="alert">{fieldError}</p> : null}
      <div className="lease-form-actions">
        <button className="bow-era-button" type="submit" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save expense changes' : 'Record expense'}
        </button>
        <button className="bow-era-button bow-era-button-secondary" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PropertyExpensesPanel({
  organizationId,
  defaultCurrency,
  canUpdate,
}: {
  organizationId: string;
  defaultCurrency: Lease['currency'];
  canUpdate: boolean;
}) {
  const [expenses, setExpenses] = useState<PropertyExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingExpense, setEditingExpense] = useState<PropertyExpense | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setExpenses(await fetchPropertyExpenses(organizationId));
    } catch (reason) {
      setError(propertyExpenseError(reason, 'Property expenses could not be loaded.').message);
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function finishSave(saved: PropertyExpense): Promise<void> {
    setSaving(true);
    setError('');
    try {
      await refresh();
      setEditingExpense(null);
      setCreating(false);
      setExpenses((current) => {
        if (current.some((item) => item.id === saved.id)) return current;
        return [saved, ...current];
      });
    } catch (reason) {
      setError(propertyExpenseError(reason, 'Property expense updates could not be verified.').message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="lease-rent-schedules" aria-labelledby="property-expenses-heading">
      <div className="lease-section-heading">
        <h3 id="property-expenses-heading">Property expense register</h3>
        {canUpdate && !creating && !editingExpense ? (
          <button className="bow-era-button bow-era-button-secondary" type="button" onClick={() => setCreating(true)}>
            Record property expense
          </button>
        ) : null}
      </div>
      <p className="lease-field-note">
        Recoverable expenses are flagged for manual review. This register does not create tenant charge schedules, invoices or payment records automatically.
      </p>
      {loading ? <p role="status">Loading property expenses…</p> : null}
      {error ? <p className="lease-form-error" role="alert">{error}</p> : null}
      {!loading && expenses.length === 0 && !creating ? <p>No property expenses are recorded for this organisation.</p> : null}
      {expenses.map((expense) => (
        <article className="lease-rent-schedule" key={expense.id}>
          <div className="lease-section-heading">
            <h4>{expenseCategoryLabel(expense.category)} · {expense.recoverability.replaceAll('_', ' ')}</h4>
            {canUpdate && !creating && !editingExpense ? (
              <button className="bow-era-button bow-era-button-secondary" type="button" onClick={() => setEditingExpense(expense)} disabled={saving}>
                Edit expense
              </button>
            ) : null}
          </div>
          <dl className="lease-detail-grid rent-schedule-grid">
            <div><dt>Expense date</dt><dd>{formatDate(expense.expense_date)}</dd></div>
            <div><dt>Amount</dt><dd>{expense.currency} {expense.amount}</dd></div>
            <div><dt>Asset</dt><dd>{expenseAssetLabel(expense)}</dd></div>
            <div><dt>Description</dt><dd>{expense.description}</dd></div>
          </dl>
          {expense.manual_review_reasons.length > 0 ? (
            <p className="lease-form-error" role="note">
              Manual review required: {expense.manual_review_reasons.map((reason) =>
                reason === 'allocation_not_configured'
                  ? 'allocation not configured'
                  : 'recovery terms not verified').join(', ')}.
            </p>
          ) : null}
          <ul className="lease-audit-list">
            {expense.audit_events.map((event, index) => (
              <li key={`${expense.id}-${event.occurred_at}-${index}`}>
                <strong>{event.event_type === 'created' ? 'Expense recorded' : 'Expense updated'}</strong>
                <time dateTime={event.occurred_at}>{formatTimestamp(event.occurred_at)}</time>
                <span>Changed: {event.changed_fields.join(', ')}</span>
              </li>
            ))}
          </ul>
          {editingExpense?.id === expense.id ? (
            <PropertyExpenseForm
              organizationId={organizationId}
              defaultCurrency={defaultCurrency}
              expense={expense}
              saving={saving}
              onCancel={() => setEditingExpense(null)}
              onSaved={(value) => { void finishSave(value); }}
            />
          ) : null}
        </article>
      ))}
      {creating ? (
        <PropertyExpenseForm
          organizationId={organizationId}
          defaultCurrency={defaultCurrency}
          saving={saving}
          onCancel={() => setCreating(false)}
          onSaved={(value) => { void finishSave(value); }}
        />
      ) : null}
    </section>
  );
}

function LeaseDetail({
  organizationId,
  lease,
  canUpdate,
  onEdit,
  onLeaseUpdated,
}: {
  organizationId: string;
  lease: Lease;
  canUpdate: boolean;
  onEdit: () => void;
  onLeaseUpdated: (lease: Lease) => void;
}) {
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
      <RentSchedulesPanel
        organizationId={organizationId}
        lease={lease}
        canUpdate={canUpdate}
        onLeaseUpdated={onLeaseUpdated}
      />
      <PropertyExpensesPanel
        organizationId={organizationId}
        defaultCurrency={lease.currency}
        canUpdate={canUpdate}
      />
      <section aria-labelledby="lease-audit-heading">
        <h3 id="lease-audit-heading">Change history</h3>
        {lease.audit_events.length === 0 ? <p>No audit history is available.</p> : (
          <ol className="lease-audit-list">
            {lease.audit_events.map((event, index) => (
              <li key={`${event.occurred_at}-${index}`}>
                <strong>
                  {event.event_type === 'created'
                    ? 'Lease recorded'
                    : event.event_type === 'updated'
                      ? 'Lease updated'
                      : event.event_type === 'rent_schedule_created' || event.event_type === 'charge_created'
                        ? 'Rent schedule created'
                        : event.event_type === 'rent_schedule_activated' || event.event_type === 'charge_activated'
                          ? 'Rent schedule activated'
                          : event.event_type === 'rent_schedule_generated' || event.event_type === 'charge_generated'
                            ? 'Expected instalments generated'
                            : 'Rent schedule updated'}
                </strong>
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
              organizationId={organizationId ?? ''}
              lease={lease}
              canUpdate={Boolean(permissions?.can_update || (mode === 'new' && permissions?.can_create))}
              onEdit={() => { setNotice(''); setEditing(true); }}
              onLeaseUpdated={setLease}
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
