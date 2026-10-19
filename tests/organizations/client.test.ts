import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchOrganizationsPage,
  organizationSelectionHref,
  parseOrganizationsPage,
  OrganizationsRequestError,
} from '../../src/lib/organizations/client';

const organizationId = '00000000-0000-4000-8000-000000000001';
const validPage = {
  organizations: [{ id: organizationId, name: 'Fictional Test Organization' }],
  next_cursor: null,
};

test('validates organization pages and rejects unexpected private fields', () => {
  assert.deepEqual(parseOrganizationsPage(validPage), validPage);
  for (const payload of [
    { ...validPage, subject: 'private-subject' },
    {
      organizations: [{ ...validPage.organizations[0], role: 'owner' }],
      next_cursor: null,
    },
    { organizations: [{ id: 'not-a-uuid', name: 'Test' }], next_cursor: null },
    { organizations: [validPage.organizations[0], validPage.organizations[0]], next_cursor: null },
    { organizations: [], next_cursor: 'invalid.cursor' },
    { organizations: 'invalid', next_cursor: null },
  ]) {
    assert.throws(() => parseOrganizationsPage(payload), TypeError);
  }
});

test('organization selection is represented only by a validated URL parameter', () => {
  assert.equal(
    organizationSelectionHref(organizationId),
    `/organizations?organizationId=${organizationId}`,
  );
  assert.equal(
    organizationSelectionHref(null, `?organizationId=${organizationId}&view=list`),
    '/organizations?view=list',
  );
  assert.throws(() => organizationSelectionHref('not-a-uuid'), TypeError);
});

test('fetches only the same-origin endpoint with no-store credentials', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestOptions: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestOptions = init;
    return Response.json(validPage);
  };
  try {
    assert.deepEqual(await fetchOrganizationsPage(null), validPage);
    assert.equal(requestedUrl, '/api/organizations?limit=100');
    assert.equal(requestOptions?.credentials, 'same-origin');
    assert.equal(requestOptions?.cache, 'no-store');
    assert.equal(requestOptions?.method, 'GET');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps authentication and upstream failures to safe UI errors', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ error: 'Authentication required.' }, { status: 401 });
    await assert.rejects(
      fetchOrganizationsPage(null),
      (error: unknown) =>
        error instanceof OrganizationsRequestError && error.status === 401,
    );

    globalThis.fetch = async () =>
      Response.json({ error: 'Internal host and token details' }, { status: 503 });
    await assert.rejects(
      fetchOrganizationsPage(null),
      (error: unknown) =>
        error instanceof OrganizationsRequestError &&
        !error.message.includes('Internal host'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
