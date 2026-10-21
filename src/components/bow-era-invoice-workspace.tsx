'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  EmptyState,
  ErrorMessage,
  LoadingState,
  PageHeading,
  Wordmark,
} from '@/components/bow-era-ui';
import {
  createInvoice,
  createPayment,
  fetchEligibleInstallments,
  fetchInvoice,
  fetchInvoices,
  fetchLeasePermissions,
  fetchLeases,
  fetchPayments,
  issueInvoice,
  updateInvoice,
  LeaseRequestError,
  type EligibleInstallment,
  type Invoice,
  type InvoiceLineFields,
  type InvoiceReceivableStatus,
  type LeaseSummary,
  type Payment,
} from '@/lib/leases/client';

type LineDraft = InvoiceLineFields & { key: string };
type DraftValues = {
  lease_id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  lines: LineDraft[];
};

const RECEIVABLE_FILTERS: (InvoiceReceivableStatus | 'all')[] = [
  'all',
  'draft',
  'due',
  'overdue',
  'paid',
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function newKey(): string {
  return secureUuid();
}

function secureUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure random number generation is unavailable.');
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function newDraft(leaseId = ''): DraftValues {
  const date = today();
  return {
    lease_id: leaseId,
    invoice_number: '',
    issue_date: date,
    due_date: date,
    lines: [{ key: newKey(), description: '', quantity: '1.000', unit_amount: '' }],
  };
}

function invoiceDraft(invoice: Invoice): DraftValues {
  return {
    lease_id: invoice.lease_id,
    invoice_number: invoice.invoice_number,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    lines: invoice.lines.map((line) => ({
      key: line.id,
      description: line.description,
      quantity: line.quantity,
      unit_amount: line.unit_amount,
      source_installment_id: line.source_installment_id,
    })),
  };
}

function money(currency: string, amount: string): string {
  return `${currency} ${amount}`;
}

export function InvoiceWorkspace() {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [organizationChecked, setOrganizationChecked] = useState(false);
  const [permissions, setPermissions] = useState<{
    can_read: boolean;
    can_create: boolean;
    can_update: boolean;
  } | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [leases, setLeases] = useState<LeaseSummary[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [receivableFilter, setReceivableFilter] = useState<InvoiceReceivableStatus | 'all'>('all');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LeaseRequestError | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<DraftValues | null>(null);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [eligible, setEligible] = useState<EligibleInstallment[]>([]);
  const [selectedInstallments, setSelectedInstallments] = useState<string[]>([]);
  const [paymentForm, setPaymentForm] = useState({
    reference: '',
    received_on: today(),
    amount: '',
    method_description: '',
  });
  const [saving, setSaving] = useState(false);
  const selectedInvoice = invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? null;
  const selectedLease = leases.find((lease) => lease.id === draft?.lease_id);
  const returnHref = organizationId
    ? `/invoices?organizationId=${encodeURIComponent(organizationId)}`
    : '/invoices';

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get('organizationId');
    if (candidate && UUID_PATTERN.test(candidate)) setOrganizationId(candidate);
    setOrganizationChecked(true);
  }, []);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const [access, invoiceRecords, leasePage, paymentRecords] = await Promise.all([
        fetchLeasePermissions(organizationId),
        fetchInvoices(
          organizationId,
          receivableFilter === 'all' ? {} : { receivableStatus: receivableFilter },
        ),
        fetchLeases({ organizationId, limit: 100, offset: 0 }),
        fetchPayments(organizationId),
      ]);
      if (!access.can_read) {
        setError(new LeaseRequestError('Organisation access denied.', 403));
        return;
      }
      setPermissions(access);
      setInvoices(invoiceRecords);
      setLeases(leasePage.items);
      setPayments(paymentRecords);
      setSelectedInvoiceId((current) =>
        invoiceRecords.some((invoice) => invoice.id === current)
          ? current
          : invoiceRecords[0]?.id ?? '',
      );
    } catch (caught) {
      setError(
        caught instanceof LeaseRequestError
          ? caught
          : new LeaseRequestError('Financial records could not be loaded.', 502),
      );
    } finally {
      setLoading(false);
    }
  }, [organizationId, receivableFilter]);

  useEffect(() => {
    if (organizationId) void load();
  }, [load, organizationId]);

  useEffect(() => {
    if (!draft?.lease_id || !organizationId) {
      setEligible([]);
      return;
    }
    let active = true;
    void fetchEligibleInstallments(organizationId, draft.lease_id)
      .then((items) => {
        if (active) setEligible(items);
      })
      .catch((caught: unknown) => {
        if (active) {
          setActionError(
            caught instanceof Error
              ? caught.message
              : 'Scheduled charges could not be loaded.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [draft?.lease_id, organizationId]);

  const overdueInvoices = useMemo(
    () => invoices.filter((invoice) => invoice.receivable_status === 'overdue'),
    [invoices],
  );

  function startCreate(): void {
    setActionError('');
    setNotice('');
    setEditingInvoiceId(null);
    setSelectedInstallments([]);
    setDraft(newDraft(leases[0]?.id ?? ''));
  }

  function startEdit(invoice: Invoice): void {
    setActionError('');
    setNotice('');
    setSelectedInstallments([]);
    setEditingInvoiceId(invoice.id);
    setDraft(invoiceDraft(invoice));
  }

  function closeDraft(): void {
    setDraft(null);
    setEditingInvoiceId(null);
    setSelectedInstallments([]);
    setActionError('');
  }

  function updateLine(key: string, updates: Partial<LineDraft>): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            lines: current.lines.map((line) =>
              line.key === key ? { ...line, ...updates } : line,
            ),
          }
        : current,
    );
  }

  function removeLine(key: string): void {
    const line = draft?.lines.find((item) => item.key === key);
    if (line?.source_installment_id) {
      setSelectedInstallments((current) =>
        current.filter((id) => id !== line.source_installment_id),
      );
    }
    setDraft((current) =>
      current
        ? { ...current, lines: current.lines.filter((item) => item.key !== key) }
        : current,
    );
  }

  function toggleInstallment(installment: EligibleInstallment, checked: boolean): void {
    setSelectedInstallments((current) =>
      checked
        ? [...current, installment.id]
        : current.filter((id) => id !== installment.id),
    );
    if (checked) {
      setDraft((current) =>
        current
          ? {
              ...current,
              lines: [
                ...current.lines,
                {
                  key: newKey(),
                  description: installment.description,
                  quantity: '1.000',
                  unit_amount: installment.amount,
                  source_installment_id: installment.id,
                },
              ],
            }
          : current,
      );
    } else {
      setDraft((current) =>
        current
          ? {
              ...current,
              lines: current.lines.filter(
                (line) => line.source_installment_id !== installment.id,
              ),
            }
          : current,
      );
    }
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!organizationId || !draft || saving) return;
    setSaving(true);
    setActionError('');
    setNotice('');
    try {
      const lines = draft.lines.filter(
        (line) => line.description.trim() && line.unit_amount.trim(),
      ).map(({ description, quantity, unit_amount, source_installment_id }) => ({
        description: description.trim(),
        quantity,
        unit_amount,
        source_installment_id: source_installment_id ?? null,
      }));
      if (lines.length === 0) {
        setActionError('Add at least one complete invoice line or select a scheduled obligation.');
        return;
      }
      const saved = editingInvoiceId
        ? await updateInvoice(organizationId, editingInvoiceId, {
            invoice_number: draft.invoice_number.trim(),
            issue_date: draft.issue_date,
            due_date: draft.due_date,
            lines,
          })
        : await createInvoice(organizationId, {
            lease_id: draft.lease_id,
            invoice_number: draft.invoice_number.trim(),
            issue_date: draft.issue_date,
            due_date: draft.due_date,
            currency: selectedLease?.currency ?? 'GBP',
            lines,
          });
      setSelectedInvoiceId(saved.id);
      closeDraft();
      setNotice(editingInvoiceId ? 'Draft invoice updated.' : 'Draft invoice created.');
      await load();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'Invoice could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function issueSelectedInvoice(): Promise<void> {
    if (!organizationId || !selectedInvoice || saving) return;
    setSaving(true);
    setActionError('');
    try {
      const issued = await issueInvoice(organizationId, selectedInvoice.id);
      setSelectedInvoiceId(issued.id);
      setNotice('Invoice issued. Its financial content is now immutable.');
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Invoice could not be issued.');
    } finally {
      setSaving(false);
    }
  }

  async function recordPayment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!organizationId || !selectedInvoice || saving) return;
    setSaving(true);
    setActionError('');
    try {
      await createPayment(organizationId, {
        idempotency_key: secureUuid(),
        reference: paymentForm.reference.trim(),
        received_on: paymentForm.received_on,
        currency: selectedInvoice.currency,
        amount: paymentForm.amount,
        method_description: paymentForm.method_description.trim(),
        allocations: [{ invoice_id: selectedInvoice.id, amount: paymentForm.amount }],
      });
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'Payment record could not be saved.',
      );
      setSaving(false);
      return;
    }
    setPaymentForm({
      reference: '',
      received_on: today(),
      amount: '',
      method_description: '',
    });
    setNotice('Manual payment record saved. This is not a bank-verified transaction.');
    setReceivableFilter('all');
    try {
      const [refreshed, invoiceRecords, paymentRecords] = await Promise.all([
        fetchInvoice(organizationId, selectedInvoice.id),
        fetchInvoices(organizationId),
        fetchPayments(organizationId),
      ]);
      setSelectedInvoiceId(refreshed.id);
      setInvoices(
        invoiceRecords.map((invoice) =>
          invoice.id === refreshed.id ? refreshed : invoice,
        ),
      );
      setPayments(paymentRecords);
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? `Payment was recorded, but financial records could not be refreshed: ${caught.message}`
          : 'Payment was recorded, but financial records could not be refreshed.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (!organizationChecked || (organizationId && loading && !permissions)) {
    return <main className="bowera-portfolio-main bow-era-frame lease-main"><LoadingState label="Loading invoices and checking organisation permissions…" /></main>;
  }
  if (!organizationId) {
    return (
      <main className="bowera-portfolio-main bow-era-frame lease-main">
        <ErrorMessage title="Choose an organisation" action={<Link className="bow-era-button" href="/organizations">Choose organisation</Link>}>
          Select an organisation before opening its invoice register.
        </ErrorMessage>
      </main>
    );
  }

  return (
    <div className="bow-era-page bowera-portfolio-page">
      <header className="bow-era-topbar bow-era-frame lease-topbar">
        <Link href="/organizations" aria-label="BOWERA organisations home"><Wordmark /></Link>
        <Link className="bowera-portfolio-back" href={`/leases?organizationId=${encodeURIComponent(organizationId)}`}>Back to leases</Link>
      </header>
      <main className="bowera-portfolio-main bow-era-frame lease-main">
        <nav className="bowera-detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/organizations">Organisations</Link><span aria-hidden="true">/</span>
          <Link href={`/leases?organizationId=${encodeURIComponent(organizationId)}`}>Lease register</Link><span aria-hidden="true">/</span>
          <span aria-current="page">Invoices &amp; receivables</span>
        </nav>
        <PageHeading
          eyebrow="Property operations"
          title="Invoices & receivables"
          description="Create and issue invoices from user-entered obligations, then record manually reported payments."
        />
        <p className="lease-legal-note" role="note">
          Expected rent and service charges are not invoices. Payment records are user-entered and are not bank-verified.
          No taxes, legal billing rules or expense recoveries are inferred.
        </p>
        {notice && <p className="lease-success" role="status">{notice}</p>}
        {error ? (
          <ErrorMessage
            title={error.status === 401 ? 'Your session has expired' : error.status === 403 ? 'Invoice access is not available' : 'Financial records could not be loaded'}
          >
            {error.message}
          </ErrorMessage>
        ) : (
          <>
            <div className="lease-toolbar invoice-toolbar">
              <label>
                <span>Receivable status</span>
                <select
                  aria-label="Filter invoices by receivable status"
                  value={receivableFilter}
                  onChange={(event) => setReceivableFilter(event.target.value as InvoiceReceivableStatus | 'all')}
                >
                  {RECEIVABLE_FILTERS.map((filter) => (
                    <option key={filter} value={filter}>{filter === 'all' ? 'All invoices' : filter}</option>
                  ))}
                </select>
              </label>
              {permissions?.can_create && (
                <button className="bow-era-button lease-create-button" type="button" onClick={startCreate}>
                  Create draft invoice
                </button>
              )}
            </div>
            {loading ? <LoadingState label="Refreshing financial records…" /> : invoices.length === 0 ? (
              <EmptyState title="No invoices in this view">
                Select another receivable status or create a draft invoice.
              </EmptyState>
            ) : (
              <div className="lease-table-wrap invoice-table-wrap">
                <table className="lease-table invoice-table">
                  <caption className="sr-only">Invoices and receivables for this organisation</caption>
                  <thead>
                    <tr>
                      <th scope="col">Invoice</th><th scope="col">Lease</th><th scope="col">Issue date</th>
                      <th scope="col">Due date</th><th scope="col">Status</th><th scope="col">Total</th>
                      <th scope="col">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((invoice) => (
                      <tr key={invoice.id} className={invoice.id === selectedInvoiceId ? 'invoice-row-selected' : undefined}>
                        <td><button className="lease-reference-link invoice-select" type="button" onClick={() => { setDraft(null); setSelectedInvoiceId(invoice.id); setActionError(''); }}>{invoice.invoice_number}</button></td>
                        <td>{invoice.lease_reference}</td><td>{invoice.issue_date}</td><td>{invoice.due_date}</td>
                        <td><span className={`lease-status lease-status-${invoice.receivable_status}`}>{invoice.receivable_status}</span></td>
                        <td>{money(invoice.currency, invoice.total)}</td>
                        <td>{money(invoice.currency, invoice.outstanding_balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {overdueInvoices.length > 0 && (
              <section className="invoice-overdue" aria-labelledby="invoice-overdue-heading">
                <h2 id="invoice-overdue-heading">Overdue receivables</h2>
                <p>Issued invoices past their due date with an outstanding balance.</p>
                <ul>
                  {overdueInvoices.map((invoice) => (
                    <li key={invoice.id}>
                      <button type="button" className="lease-reference-link invoice-select" onClick={() => setSelectedInvoiceId(invoice.id)}>
                        {invoice.invoice_number} · {invoice.lease_reference}
                      </button>
                      <span>Due {invoice.due_date} · {money(invoice.currency, invoice.outstanding_balance)} outstanding</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {selectedInvoice && (
              <section className="lease-detail invoice-detail" aria-labelledby="invoice-detail-heading">
                <div className="lease-detail-heading">
                  <div>
                    <p className="bowera-section-eyebrow">Invoice details</p>
                    <h2 id="invoice-detail-heading">{selectedInvoice.invoice_number}</h2>
                    <p>{selectedInvoice.lease_reference} · {selectedInvoice.issue_date} to {selectedInvoice.due_date}</p>
                  </div>
                  <span className={`lease-status lease-status-${selectedInvoice.receivable_status}`}>{selectedInvoice.receivable_status}</span>
                </div>
                <dl className="lease-detail-grid">
                  <div><dt>Subtotal</dt><dd>{money(selectedInvoice.currency, selectedInvoice.subtotal)}</dd></div>
                  <div><dt>Total (no tax calculation)</dt><dd>{money(selectedInvoice.currency, selectedInvoice.total)}</dd></div>
                  <div><dt>Allocated payments</dt><dd>{money(selectedInvoice.currency, selectedInvoice.allocated_amount)}</dd></div>
                  <div><dt>Outstanding balance</dt><dd>{money(selectedInvoice.currency, selectedInvoice.outstanding_balance)}</dd></div>
                </dl>
                <div className="lease-table-wrap invoice-lines-wrap">
                  <table className="lease-table invoice-lines-table">
                    <caption>Invoice lines</caption>
                    <thead><tr><th scope="col">Description</th><th scope="col">Quantity</th><th scope="col">Unit amount</th><th scope="col">Line total</th><th scope="col">Source</th></tr></thead>
                    <tbody>{selectedInvoice.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.description}</td><td>{line.quantity}</td><td>{money(selectedInvoice.currency, line.unit_amount)}</td>
                        <td>{money(selectedInvoice.currency, line.line_total)}</td><td>{line.source_installment_id ? 'Scheduled charge' : 'Manual line'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {selectedInvoice.status === 'draft' && permissions?.can_update && (
                  <div className="lease-form-actions">
                    <button className="bow-era-button" type="button" onClick={() => startEdit(selectedInvoice)}>Edit draft</button>
                    <button className="bow-era-button" type="button" disabled={saving} onClick={() => void issueSelectedInvoice()}>{saving ? 'Issuing…' : 'Issue invoice'}</button>
                  </div>
                )}
                {selectedInvoice.status === 'issued' && selectedInvoice.outstanding_balance !== '0.00' && permissions?.can_create && (
                  <form className="lease-form invoice-payment-form" onSubmit={(event) => void recordPayment(event)}>
                    <fieldset>
                      <legend>Record a manual payment</legend>
                      <p className="lease-field-note">This creates a user-entered record, not a verified bank transaction. Allocations cannot exceed the payment or invoice balance.</p>
                      <div className="lease-form-grid">
                        <label>Payment reference<input required maxLength={100} value={paymentForm.reference} onChange={(event) => setPaymentForm({ ...paymentForm, reference: event.target.value })} /></label>
                        <label>Receipt date<input required type="date" value={paymentForm.received_on} onChange={(event) => setPaymentForm({ ...paymentForm, received_on: event.target.value })} /></label>
                        <label>Amount ({selectedInvoice.currency})<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" value={paymentForm.amount} onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })} /></label>
                        <label>Method description<input required maxLength={100} value={paymentForm.method_description} onChange={(event) => setPaymentForm({ ...paymentForm, method_description: event.target.value })} placeholder="For example, user-reported bank transfer" /></label>
                      </div>
                      <div className="lease-form-actions"><button className="bow-era-button" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Record payment'}</button></div>
                    </fieldset>
                  </form>
                )}
                <section className="invoice-audit" aria-labelledby="invoice-audit-heading">
                  <h3 id="invoice-audit-heading">Invoice history</h3>
                  <ul className="lease-audit-list">
                    {selectedInvoice.audit_events.map((event, index) => (
                      <li key={`${event.occurred_at}-${index}`}><strong>{event.event_type}</strong><span>{event.changed_fields.join(', ')}</span><time dateTime={event.occurred_at}>{event.occurred_at}</time></li>
                    ))}
                  </ul>
                </section>
              </section>
            )}
            {payments.length > 0 && (
              <section className="invoice-payments" aria-labelledby="invoice-payments-heading">
                <h2 id="invoice-payments-heading">Recent manual payment records</h2>
                <div className="lease-table-wrap">
                  <table className="lease-table invoice-payments-table">
                    <caption className="sr-only">Payments recorded by users, not verified by a bank</caption>
                    <thead><tr><th scope="col">Reference</th><th scope="col">Date received</th><th scope="col">Amount</th><th scope="col">Method description</th><th scope="col">Allocated invoices</th></tr></thead>
                    <tbody>{payments.map((payment) => (
                      <tr key={payment.id}><td>{payment.reference}</td><td>{payment.received_on}</td><td>{money(payment.currency, payment.amount)}</td><td>{payment.method_description}</td><td>{payment.allocations.map((allocation) => allocation.invoice_number).join(', ')}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
        {draft && permissions && (
          <form className="lease-form invoice-draft-form" onSubmit={(event) => void saveDraft(event)}>
            <fieldset>
              <legend>{editingInvoiceId ? 'Edit draft invoice' : 'Create draft invoice'}</legend>
              <div className="lease-form-grid">
                {!editingInvoiceId && (
                  <label>Lease
                    <select required value={draft.lease_id} onChange={(event) => setDraft({ ...draft, lease_id: event.target.value })}>
                      <option value="">Select a lease</option>
                      {leases.map((lease) => <option key={lease.id} value={lease.id}>{lease.lease_reference} · {lease.currency}</option>)}
                    </select>
                  </label>
                )}
                <label>Invoice number<input required maxLength={100} value={draft.invoice_number} onChange={(event) => setDraft({ ...draft, invoice_number: event.target.value })} /></label>
                <label>Issue date<input required type="date" value={draft.issue_date} onChange={(event) => setDraft({ ...draft, issue_date: event.target.value })} /></label>
                <label>Due date<input required type="date" value={draft.due_date} onChange={(event) => setDraft({ ...draft, due_date: event.target.value })} /></label>
                <p className="lease-field-note">Currency: {editingInvoiceId ? selectedInvoice?.currency : selectedLease?.currency ?? 'Choose a lease'}. Each line is rounded to two decimal places by the backend before subtotaling.</p>
              </div>
              {eligible.length > 0 && (
                <fieldset className="invoice-schedule-picker">
                  <legend>Select scheduled obligations (optional)</legend>
                  <p className="lease-field-note">Only explicitly selected eligible rent or service-charge instalments are included. Expenses are not invoiceable here.</p>
                  {eligible.map((item) => (
                    <label className="invoice-schedule-option" key={item.id}>
                      <input type="checkbox" checked={selectedInstallments.includes(item.id)} onChange={(event) => toggleInstallment(item, event.target.checked)} />
                      <span>{item.description} · due {item.due_date} · {money(item.currency, item.amount)}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <fieldset className="invoice-line-editor">
                <legend>Invoice lines</legend>
                {draft.lines.map((line, index) => (
                  <div className="invoice-line-row" key={line.key}>
                    <label>Description<input required maxLength={250} value={line.description} onChange={(event) => updateLine(line.key, { description: event.target.value })} /></label>
                    <label>Quantity<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,3})?" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} /></label>
                    <label>Unit amount<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" value={line.unit_amount} onChange={(event) => updateLine(line.key, { unit_amount: event.target.value })} /></label>
                    <button className="invoice-remove-line" type="button" aria-label={`Remove line ${index + 1}`} onClick={() => removeLine(line.key)}>Remove</button>
                    {line.source_installment_id && <span className="lease-field-note">Linked scheduled obligation</span>}
                  </div>
                ))}
                <button className="bow-era-button" type="button" onClick={() => setDraft({ ...draft, lines: [...draft.lines, { key: newKey(), description: '', quantity: '1.000', unit_amount: '' }] })}>Add invoice line</button>
              </fieldset>
              {actionError && <p className="lease-form-error" role="alert">{actionError}</p>}
              <div className="lease-form-actions">
                <button className="bow-era-button" type="submit" disabled={saving || !draft.lease_id}>{saving ? 'Saving…' : 'Save draft invoice'}</button>
                <button className="bow-era-button invoice-secondary-button" type="button" disabled={saving} onClick={closeDraft}>Cancel</button>
              </div>
            </fieldset>
          </form>
        )}
        {actionError && !draft && <p className="lease-form-error" role="alert">{actionError}</p>}
      </main>
    </div>
  );
}
