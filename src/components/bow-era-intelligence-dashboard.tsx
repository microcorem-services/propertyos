'use client';

import * as Dialog from '@radix-ui/react-dialog';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
} from '@tanstack/react-table';
import { useMemo, useRef, useState } from 'react';
import {
  DEMO_ASSESSMENTS,
  summarizeAssessments,
  type IntelligenceAssessment,
} from '../lib/intelligence/demo-assessments';
import { Button, PageHeading, Wordmark } from './bow-era-ui';

const TABLE_DATA: IntelligenceAssessment[] = [...DEMO_ASSESSMENTS];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function formatRule(ruleId: string): string {
  const labels: Record<string, string> = {
    'unit.vacant': 'Vacant unit',
    'lease.expiring_within_90_days': 'Lease expires within 90 days',
    'maintenance.outstanding': 'Outstanding maintenance',
  };
  return labels[ruleId] ?? 'Risk indicator';
}

function PriorityBadge({
  priority,
}: {
  priority: IntelligenceAssessment['assessment']['priority'];
}) {
  return (
    <span className={`intelligence-priority intelligence-priority-${priority}`}>
      <span aria-hidden="true">{priority === 'high' ? '!' : priority === 'medium' ? '•' : '–'}</span>
      {priority[0].toUpperCase() + priority.slice(1)}
    </span>
  );
}

function AssessmentDetails({
  item,
  onRestoreFocus,
}: {
  item: IntelligenceAssessment | null;
  onRestoreFocus: () => void;
}) {
  if (!item) return null;
  const { assessment } = item;

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="intelligence-dialog-overlay" />
      <Dialog.Content
        aria-modal="true"
        aria-describedby="intelligence-dialog-description"
        className="intelligence-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <div className="intelligence-dialog-heading">
          <div>
            <p className="bow-era-eyebrow">Synthetic assessment</p>
            <Dialog.Title className="intelligence-dialog-title">
              {item.unitName}
            </Dialog.Title>
            <p className="intelligence-dialog-building">{item.buildingName}</p>
          </div>
          <Dialog.Close asChild>
            <button className="intelligence-dialog-close" aria-label="Close assessment">
              ×
            </button>
          </Dialog.Close>
        </div>
        <p id="intelligence-dialog-description" className="intelligence-dialog-note">
          Demonstration only. This assessment is calculated from synthetic fixture
          values and is not customer or investment advice.
        </p>
        <div className="intelligence-score-panel">
          <div>
            <span className="intelligence-detail-label">Risk score</span>
            <strong>{assessment.score} / {assessment.maximumScore}</strong>
          </div>
          <PriorityBadge priority={assessment.priority} />
          {!assessment.dataCompleteness.isComplete && (
            <p className="intelligence-incomplete-warning" role="note">
              Incomplete inputs: this score is not a low-risk conclusion.
            </p>
          )}
        </div>
        <dl className="intelligence-detail-list">
          <div>
            <dt>Algorithm version</dt>
            <dd>{assessment.algorithmVersion}</dd>
          </div>
          <div>
            <dt>Data observed</dt>
            <dd><time dateTime={assessment.dataObservedAt}>{formatDate(assessment.dataObservedAt)} UTC</time></dd>
          </div>
          <div>
            <dt>Evaluated as of</dt>
            <dd><time dateTime={assessment.evaluatedAsOf}>{formatDate(assessment.evaluatedAsOf)} UTC</time></dd>
          </div>
          <div>
            <dt>Data completeness</dt>
            <dd>{assessment.dataCompleteness.isComplete ? 'Complete' : 'Incomplete'}</dd>
          </div>
        </dl>
        {assessment.dataCompleteness.missingFields.length > 0 && (
          <section className="intelligence-detail-section" aria-labelledby="missing-fields-title">
            <h3 id="missing-fields-title">Unknown input fields</h3>
            <ul>
              {assessment.dataCompleteness.missingFields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </section>
        )}
        {assessment.expiredLeaseDays !== null && (
          <p className="intelligence-expired-warning" role="note">
            Lease expired {assessment.expiredLeaseDays} days before the evaluation
            date. The current algorithm does not score this condition.
          </p>
        )}
        <section className="intelligence-detail-section" aria-labelledby="triggered-rules-title">
          <h3 id="triggered-rules-title">Triggered indicators</h3>
          {assessment.findings.length === 0 ? (
            <p>No indicators were triggered by the known inputs.</p>
          ) : (
            <ul>
              {assessment.findings.map((finding) => (
                <li key={finding.ruleId}>
                  <strong>{formatRule(finding.ruleId)} (+{finding.points})</strong>
                  <span>{finding.explanation}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <Dialog.Close asChild>
          <Button variant="secondary">Close details</Button>
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

export function IntelligenceDashboard() {
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState('all');
  const [completeness, setCompleteness] = useState('all');
  const [selected, setSelected] = useState<IntelligenceAssessment | null>(null);
  const inspectButtonRef = useRef<HTMLButtonElement | null>(null);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 5,
  });
  const summary = useMemo(() => summarizeAssessments(DEMO_ASSESSMENTS), []);
  const columnFilters = useMemo(
    () => [
      ...(priority === 'all' ? [] : [{ id: 'priority', value: priority }]),
      ...(completeness === 'all'
        ? []
        : [{ id: 'completeness', value: completeness }]),
    ],
    [completeness, priority],
  );
  const columns = useMemo<ColumnDef<IntelligenceAssessment>[]>(
    () => [
      {
        id: 'unit',
        header: 'Unit',
        accessorFn: (row) => row.unitName,
        cell: ({ row }) => (
          <div className="intelligence-unit-cell">
            <strong>{row.original.unitName}</strong>
            <code>{row.original.assessment.unitId}</code>
          </div>
        ),
      },
      {
        id: 'building',
        header: 'Building',
        accessorFn: (row) => row.buildingName,
      },
      {
        id: 'score',
        header: 'Risk score',
        accessorFn: (row) => row.assessment.score,
        cell: ({ row }) => {
          const { assessment } = row.original;
          return (
            <div className="intelligence-score-cell">
              <strong>{assessment.score} / {assessment.maximumScore}</strong>
              {!assessment.dataCompleteness.isComplete && (
                <span>Incomplete inputs — not a low-risk conclusion</span>
              )}
            </div>
          );
        },
      },
      {
        id: 'priority',
        header: 'Priority',
        accessorFn: (row) => row.assessment.priority,
        cell: ({ row }) => <PriorityBadge priority={row.original.assessment.priority} />,
        filterFn: (row, _columnId, filterValue: string) =>
          filterValue === 'all' || row.original.assessment.priority === filterValue,
      },
      {
        id: 'rules',
        header: 'Triggered rules',
        accessorFn: (row) =>
          row.assessment.findings.map((finding) => formatRule(finding.ruleId)).join(' '),
        cell: ({ row }) =>
          row.original.assessment.findings.length
            ? row.original.assessment.findings.map((finding) => formatRule(finding.ruleId)).join(', ')
            : 'None',
      },
      {
        id: 'completeness',
        header: 'Data completeness',
        accessorFn: (row) => row.assessment.dataCompleteness.isComplete,
        cell: ({ row }) =>
          row.original.assessment.dataCompleteness.isComplete
            ? 'Complete'
            : 'Incomplete',
        filterFn: (row, _columnId, filterValue: string) =>
          filterValue === 'all' ||
          String(row.original.assessment.dataCompleteness.isComplete) === filterValue,
      },
      {
        id: 'assessedAt',
        header: 'Assessment date',
        accessorFn: (row) => row.assessment.evaluatedAsOf,
        cell: ({ row }) => (
          <time dateTime={row.original.assessment.evaluatedAsOf}>
            {formatDate(row.original.assessment.evaluatedAsOf)}
          </time>
        ),
      },
      {
        id: 'action',
        header: 'Assessment',
        enableSorting: false,
        cell: ({ row }) => (
          <Dialog.Trigger asChild>
            <button
              className="intelligence-inspect"
              onClick={(event) => {
                inspectButtonRef.current = event.currentTarget;
                setSelected(row.original);
              }}
              aria-label={`Inspect assessment for ${row.original.unitName}`}
            >
              Inspect
            </button>
          </Dialog.Trigger>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({
    data: TABLE_DATA,
    columns,
    state: {
      globalFilter: search,
      pagination,
      columnFilters,
    },
    onGlobalFilterChange: (value) => setSearch(String(value ?? '')),
    onPaginationChange: setPagination,
    globalFilterFn: (row, _columnId, filterValue) => {
      const query = String(filterValue).trim().toLocaleLowerCase();
      return [
        row.original.unitName,
        row.original.buildingName,
        row.original.assessment.unitId,
        ...row.original.assessment.findings.map((finding) =>
          formatRule(finding.ruleId),
        ),
      ].some((value) => value.toLocaleLowerCase().includes(query));
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.assessment.unitId,
  });
  const filteredCount = table.getFilteredRowModel().rows.length;

  return (
    <Dialog.Root
      open={selected !== null}
      onOpenChange={(open) => !open && setSelected(null)}
    >
    <div className="bow-era-page intelligence-page">
      <header className="bow-era-topbar bow-era-frame">
        <a href="/organizations" aria-label="BOWERA organisations home">
          <Wordmark />
        </a>
        <span className="intelligence-demo-label">Synthetic demonstration</span>
      </header>
      <main className="bow-era-frame intelligence-main">
        <PageHeading
          eyebrow="Property intelligence · M0.8-B"
          title="Intelligence overview"
          description="A transparent demonstration of deterministic risk indicators across synthetic unit data."
        />
        <section className="intelligence-demo-notice" aria-label="Demo data notice">
          <strong>Demo data only</strong>
          <span aria-live="polite">
            Every unit and assessment below is synthetic. No real organisation,
            Registry, lease or maintenance data is accessed.
          </span>
        </section>

        <section aria-labelledby="intelligence-summary-title">
          <div className="intelligence-section-heading">
            <h2 id="intelligence-summary-title">Demo portfolio snapshot</h2>
            <p>Counts are based on all {summary.unitsAssessed} synthetic assessments.</p>
          </div>
          <div className="intelligence-summary-grid">
            <article className="intelligence-summary-card">
              <span>Units assessed</span><strong>{summary.unitsAssessed}</strong>
            </article>
            <article className="intelligence-summary-card">
              <span>High priority</span><strong>{summary.highPriority}</strong>
            </article>
            <article className="intelligence-summary-card">
              <span>Medium priority</span><strong>{summary.mediumPriority}</strong>
            </article>
            <article className="intelligence-summary-card">
              <span>Incomplete data</span><strong>{summary.incompleteData}</strong>
            </article>
          </div>
        </section>

        <section className="intelligence-table-section" aria-labelledby="assessments-title">
          <div className="intelligence-section-heading">
            <h2 id="assessments-title">Unit assessments</h2>
            <p>Risk scores are illustrative and do not represent investment or compliance advice.</p>
          </div>
          <div className="intelligence-controls">
            <label>
              <span>Search assessments</span>
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  table.setPageIndex(0);
                }}
                placeholder="Search unit, building or indicator"
              />
            </label>
            <label>
              <span>Priority</span>
              <select
                value={priority}
                onChange={(event) => {
                  setPriority(event.target.value);
                  table.setPageIndex(0);
                }}
              >
                <option value="all">All priorities</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label>
              <span>Data completeness</span>
              <select
                value={completeness}
                onChange={(event) => {
                  setCompleteness(event.target.value);
                  table.setPageIndex(0);
                }}
              >
                <option value="all">All data states</option>
                <option value="true">Complete</option>
                <option value="false">Incomplete</option>
              </select>
            </label>
          </div>
          <div className="intelligence-table-wrap">
            <table className="intelligence-table">
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          header.column.getIsSorted() === 'asc'
                            ? 'ascending'
                            : header.column.getIsSorted() === 'desc'
                              ? 'descending'
                              : undefined
                        }
                      >
                        {header.isPlaceholder ? null : header.column.getCanSort() ? (
                          <button
                            className="intelligence-sort"
                            onClick={header.column.getToggleSortingHandler()}
                            aria-label={`Sort by ${String(header.column.columnDef.header)}`}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <span aria-hidden="true">
                              {{ asc: ' ↑', desc: ' ↓' }[header.column.getIsSorted() as 'asc' | 'desc'] ?? ''}
                            </span>
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
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredCount === 0 && (
              <div className="intelligence-empty" role="status">
                <strong>No assessments match these filters</strong>
                <span>Try a different search term or clear a filter.</span>
              </div>
            )}
          </div>
          {filteredCount > 0 && (
            <nav className="intelligence-pagination" aria-label="Assessment pagination">
              <span>
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
                {' · '}{filteredCount} assessments
              </span>
              <div>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setPagination((current) => ({
                      ...current,
                      pageIndex: Math.max(0, current.pageIndex - 1),
                    }))
                  }
                  disabled={!table.getCanPreviousPage()}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setPagination((current) => ({
                      ...current,
                      pageIndex: Math.min(
                        table.getPageCount() - 1,
                        current.pageIndex + 1,
                      ),
                    }))
                  }
                  disabled={!table.getCanNextPage()}
                >
                  Next
                </Button>
              </div>
            </nav>
          )}
        </section>
      </main>
      <AssessmentDetails
        item={selected}
        onRestoreFocus={() => inspectButtonRef.current?.focus()}
      />
    </div>
    </Dialog.Root>
  );
}
