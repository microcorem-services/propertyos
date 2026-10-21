import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoiceWorkspace } from '../../src/components/bow-era-invoice-workspace';
import type {
  EligibleInstallment,
  Invoice,
  LeaseSummary,
  Payment,
} from '../../src/lib/leases/client';
import { dom } from '../intelligence/dom-setup';

const organizationId = '00000000-0000-4000-8000-000000000001';
const leaseId = '00000000-0000-4000-8000-000000000101';
const invoiceId = '00000000-0000-4000-8000-000000000201';

const lease: LeaseSummary = {
  id: leaseId,
  organization_id: organizationId,
  lease_reference: 'LEASE-2026-001',
  start_date: '2026-01-01',
  expiry_date: '2030-12-31',
  break_date: null,
  rent_amount: '1000.00',
  currency: 'GBP',
  payment_frequency: 'monthly',
  status: 'active',
  units: [],
  parties: [],
  created_at: '2026-01-01T10:00:00Z',
  updated_at: '2026-01-01T10:00:00Z',
};

function makeInvoice(status: Invoice['status'] = 'draft'): Invoice {
  return {
    id: invoiceId,
    organization_id: organizationId,
    lease_id: leaseId,
    lease_reference: lease.lease_reference,
    invoice_number: 'INV-2026-001',
    issue_date: '2026-01-01',
    due_date: '2026-01-31',
    currency: 'GBP',
    subtotal: '27.76',
    total: '27.76',
    allocated_amount: status === 'issued' ? '0.00' : '0.00',
    outstanding_balance: status === 'issued' ? '27.76' : '27.76',
    status,
    receivable_status: status === 'issued' ? 'overdue' : 'draft',
    issued_at: status === 'issued' ? '2026-01-01T10:00:00Z' : null,
    lines: [{
      id: '00000000-0000-4000-8000-000000000202',
      description: 'Service charge',
      quantity: '2.000',
      unit_amount: '13.88',
      line_total: '27.76',
      source_installment_id: null,
    }],
    audit_events: [{
      actor_id: '00000000-0000-4000-8000-000000000301',
      event_type: status === 'issued' ? 'issued' : 'created',
      changed_fields: ['lines'],
      occurred_at: '2026-01-01T10:00:00Z',
    }],
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:00:00Z',
  };
}

const eligible: EligibleInstallment = {
  id: '00000000-0000-4000-8000-000000000401',
  lease_id: leaseId,
  schedule_id: '00000000-0000-4000-8000-000000000402',
  description: 'Quarterly base rent',
  charge_category: 'base_rent',
  due_date: '2026-07-01',
  amount: '1000.00',
  currency: 'GBP',
};

function setup(initialInvoice: Invoice, canCreate = true) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  let currentInvoice = initialInvoice;
  const payment: Payment = {
    id: '00000000-0000-4000-8000-000000000501',
    organization_id: organizationId,
    reference: 'RECEIPT-2026-001',
    received_on: '2026-07-02',
    currency: 'GBP',
    amount: '10.00',
    method_description: 'User-reported transfer',
    allocations: [{ invoice_id: invoiceId, invoice_number: currentInvoice.invoice_number, amount: '10.00' }],
    audit_events: [{
      actor_id: '00000000-0000-4000-8000-000000000301',
      event_type: 'recorded',
      changed_fields: ['amount'],
      occurred_at: '2026-07-02T10:00:00Z',
    }],
    created_at: '2026-07-02T10:00:00Z',
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url: url.href, method, body });
    if (url.pathname === '/api/leases/permissions') {
      return Response.json({ can_read: true, can_create: canCreate, can_update: canCreate });
    }
    if (url.pathname === '/api/invoices' && method === 'GET') {
      return Response.json([currentInvoice]);
    }
    if (url.pathname === '/api/invoices' && method === 'POST') {
      currentInvoice = {
        ...makeInvoice(),
        ...body,
        lease_id: String(body?.lease_id),
        invoice_number: String(body?.invoice_number),
        id: invoiceId,
        organization_id: organizationId,
        lease_reference: lease.lease_reference,
        subtotal: '1000.00',
        total: '1000.00',
        outstanding_balance: '1000.00',
        allocated_amount: '0.00',
        status: 'draft',
        receivable_status: 'draft',
        lines: (body?.lines as Invoice['lines'])?.map((line, index) => ({
          ...line,
          id: `00000000-0000-4000-8000-${String(600 + index).padStart(12, '0')}`,
          line_total: '1000.00',
        })) ?? [],
      } as Invoice;
      return Response.json(currentInvoice, { status: 201 });
    }
    if (url.pathname === `/api/invoices/${invoiceId}` && method === 'PATCH') {
      currentInvoice = {
        ...currentInvoice,
        ...body,
        lines: (body?.lines as Invoice['lines'])?.map((line, index) => ({
          ...line,
          id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, '0')}`,
          line_total: '27.76',
        })) ?? currentInvoice.lines,
        audit_events: [
          ...currentInvoice.audit_events,
          {
            actor_id: '00000000-0000-4000-8000-000000000301',
            event_type: 'updated',
            changed_fields: ['invoice_number'],
            occurred_at: '2026-01-02T10:00:00Z',
          },
        ],
      } as Invoice;
      return Response.json(currentInvoice);
    }
    if (url.pathname === `/api/invoices/${invoiceId}` && method === 'GET') {
      return Response.json(currentInvoice);
    }
    if (url.pathname === `/api/invoices/${invoiceId}/issue`) {
      currentInvoice = {
        ...currentInvoice,
        status: 'issued',
        receivable_status: 'overdue',
        issued_at: '2026-01-01T10:00:00Z',
      };
      return Response.json(currentInvoice);
    }
    if (url.pathname === '/api/payments' && method === 'GET') return Response.json([]);
    if (url.pathname === '/api/payments' && method === 'POST') {
      currentInvoice = {
        ...currentInvoice,
        allocated_amount: '10.00',
        outstanding_balance: '17.76',
      };
      return Response.json(payment, { status: 201 });
    }
    if (url.pathname === '/api/leases') {
      return Response.json({ items: [lease], total: 1, limit: 100, offset: 0 });
    }
    if (url.pathname === `/api/leases/${leaseId}/eligible-installments`) {
      return Response.json([eligible]);
    }
    return Response.json({ detail: 'not found' }, { status: 404 });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

afterEach(() => {
  cleanup();
  dom.window.document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

test('invoice workspace creates drafts from explicitly selected scheduled obligations', async () => {
  const context = setup(makeInvoice());
  window.history.replaceState({}, '', `/invoices?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<InvoiceWorkspace />);
    await screen.findByRole('table', { name: 'Invoices and receivables for this organisation' });
    await user.click(screen.getByRole('button', { name: 'Create draft invoice' }));
    await user.selectOptions(screen.getByLabelText('Lease'), leaseId);
    await user.clear(screen.getByLabelText('Invoice number'));
    await user.type(screen.getByLabelText('Invoice number'), 'INV-NEW');
    const scheduled = await screen.findByLabelText(/Quarterly base rent/);
    await user.click(scheduled);
    await user.click(screen.getByRole('button', { name: 'Remove line 1' }));
    await user.click(screen.getByRole('button', { name: 'Save draft invoice' }));

    await screen.findByText('Draft invoice created.');
    const createCall = context.calls.find((call) => call.url.includes('/api/invoices?') && call.method === 'POST');
    assert.ok(createCall);
    const bodyLines = createCall.body?.lines as { source_installment_id: string }[];
    assert.equal(bodyLines[0].source_installment_id, eligible.id);
    assert.ok(screen.getAllByText('INV-NEW').length > 0);
  } finally {
    context.restore();
  }
});

test('invoice workspace records a manual payment and labels it unverified', async () => {
  const context = setup(makeInvoice('issued'));
  window.history.replaceState({}, '', `/invoices?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<InvoiceWorkspace />);
    await screen.findByRole('heading', { name: 'INV-2026-001' });
    assert.ok(screen.getAllByText(/not bank-verified/).length > 0);
    await user.type(screen.getByLabelText('Payment reference'), 'RECEIPT-2026-001');
    await user.type(screen.getByLabelText('Amount (GBP)'), '10.00');
    await user.type(screen.getByLabelText('Method description'), 'User-reported transfer');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => assert.ok(context.calls.some((call) => call.url.includes('/api/payments?') && call.method === 'POST')));
    assert.equal(
      context.calls.find((call) => call.url.includes('/api/payments?') && call.method === 'POST')?.body?.amount,
      '10.00',
    );
    assert.ok(await screen.findByText(/Manual payment record saved/));
    assert.ok(screen.getAllByText('GBP 17.76').length > 0);
  } finally {
    context.restore();
  }
});

test('draft invoices can be edited and issued, then lose edit controls', async () => {
  const context = setup(makeInvoice());
  window.history.replaceState({}, '', `/invoices?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<InvoiceWorkspace />);
    await screen.findByRole('heading', { name: 'INV-2026-001' });
    await user.click(screen.getByRole('button', { name: 'Edit draft' }));
    await user.clear(screen.getByLabelText('Invoice number'));
    await user.type(screen.getByLabelText('Invoice number'), 'INV-EDITED');
    await user.click(screen.getByRole('button', { name: 'Save draft invoice' }));
    await screen.findByText('Draft invoice updated.');
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }));
    await screen.findByText('Invoice issued. Its financial content is now immutable.');
    assert.ok(context.calls.some((call) => call.url.includes(`/api/invoices/${invoiceId}?`) && call.method === 'PATCH'));
    assert.ok(context.calls.some((call) => call.url.includes(`/api/invoices/${invoiceId}/issue?`) && call.method === 'POST'));
    assert.equal(screen.queryByRole('button', { name: 'Edit draft' }), null);
  } finally {
    context.restore();
  }
});

test('draft edits can release a scheduled obligation back to eligibility', async () => {
  const invoice = makeInvoice();
  invoice.lines[0].source_installment_id = eligible.id;
  const context = setup(invoice);
  window.history.replaceState({}, '', `/invoices?organizationId=${organizationId}`);
  const user = userEvent.setup();
  try {
    render(<InvoiceWorkspace />);
    await screen.findByRole('heading', { name: invoice.invoice_number });
    await user.click(screen.getByRole('button', { name: 'Edit draft' }));
    await user.click(screen.getByRole('button', { name: 'Remove line 1' }));
    await user.click(screen.getByRole('button', { name: 'Add invoice line' }));
    await user.type(screen.getByLabelText('Description'), 'Replacement manual line');
    await user.type(screen.getByLabelText('Unit amount'), '2.50');
    await user.click(screen.getByRole('button', { name: 'Save draft invoice' }));
    await screen.findByText('Draft invoice updated.');
    const update = context.calls.find((call) => call.url.includes(`/api/invoices/${invoiceId}?`) && call.method === 'PATCH');
    assert.ok(update);
    const lines = update.body?.lines as { source_installment_id: string | null }[];
    assert.equal(lines[0].source_installment_id, null);
  } finally {
    context.restore();
  }
});
