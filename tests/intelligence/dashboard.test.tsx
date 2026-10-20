import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntelligenceDashboard } from '../../src/components/bow-era-intelligence-dashboard';
import {
  DEMO_ASSESSMENTS,
  summarizeAssessments,
} from '../../src/lib/intelligence/demo-assessments';
import { dom } from './dom-setup';

afterEach(() => {
  cleanup();
  dom.window.document.body.innerHTML = '';
});

test('demo assessments are calculated by risk-v1 with synthetic organization identity', () => {
  assert.equal(DEMO_ASSESSMENTS.length, 7);
  assert.deepEqual(
    DEMO_ASSESSMENTS.map(({ assessment }) => assessment.score),
    [0, 40, 70, 20, 30, 0, 0],
  );
  assert.ok(
    DEMO_ASSESSMENTS.every(
      ({ assessment }) =>
        assessment.organizationId ===
          '00000000-0000-4000-8000-000000000001' &&
        assessment.algorithmVersion === 'risk-v1',
    ),
  );
  assert.equal(
    DEMO_ASSESSMENTS[5].assessment.dataCompleteness.isComplete,
    false,
  );
  assert.equal(DEMO_ASSESSMENTS[6].assessment.expiredLeaseDays, 15);
});

test('summary counts match the full set of displayed synthetic assessments', () => {
  assert.deepEqual(summarizeAssessments(DEMO_ASSESSMENTS), {
    unitsAssessed: 7,
    highPriority: 1,
    mediumPriority: 2,
    incompleteData: 2,
  });
  render(<IntelligenceDashboard />);
  assert.equal(screen.getByText('Units assessed').parentElement?.textContent, 'Units assessed7');
  assert.equal(screen.getByText('High priority').parentElement?.textContent, 'High priority1');
  assert.equal(screen.getByText('Medium priority').parentElement?.textContent, 'Medium priority2');
  assert.equal(screen.getByText('Incomplete data').parentElement?.textContent, 'Incomplete data2');
});

test('priority and data-completeness filters narrow the table', async () => {
  const user = userEvent.setup();
  render(<IntelligenceDashboard />);
  const priorityFilter = screen.getByLabelText('Priority');
  for (const [priority, rowCount] of [
    ['high', 2],
    ['medium', 3],
    ['low', 5],
  ] as const) {
    await user.selectOptions(priorityFilter, priority);
    assert.equal(screen.getAllByRole('row').length, rowCount);
  }

  await user.selectOptions(priorityFilter, 'all');
  await user.selectOptions(screen.getByLabelText('Data completeness'), 'false');
  assert.equal(screen.getAllByRole('row').length, 3);
  assert.match(
    screen.getByRole('row', { name: /Demo Unit 302/ }).textContent ?? '',
    /Incomplete inputs — not a low-risk conclusion/,
  );
  assert.ok(screen.getByRole('row', { name: /Demo Unit 202/ }));
});

test('search matches unit, building and rule labels', async () => {
  const user = userEvent.setup();
  render(<IntelligenceDashboard />);
  await user.type(screen.getByRole('searchbox', { name: 'Search assessments' }), 'Demo House South');
  assert.equal(screen.getAllByRole('row').length, 3);
  assert.ok(screen.getByRole('row', { name: /Demo Unit 201/ }));
  assert.ok(screen.getByRole('row', { name: /Demo Unit 202/ }));

  await user.clear(screen.getByRole('searchbox', { name: 'Search assessments' }));
  await user.type(screen.getByRole('searchbox', { name: 'Search assessments' }), 'Vacant unit');
  assert.ok(screen.getByRole('row', { name: /Demo Unit 102/ }));
});

test('sorting orders assessment scores', async () => {
  const user = userEvent.setup();
  render(<IntelligenceDashboard />);
  const table = screen.getByRole('table');
  const scoreHeader = screen.getByRole('columnheader', { name: /Risk score/ });
  await user.click(screen.getByRole('button', { name: 'Sort by Risk score' }));
  assert.equal(scoreHeader.getAttribute('aria-sort'), 'descending');
  assert.match(within(table).getAllByRole('row')[1].textContent ?? '', /Demo Unit 201/);
  await user.click(screen.getByRole('button', { name: 'Sort by Risk score' }));
  assert.equal(scoreHeader.getAttribute('aria-sort'), 'ascending');
  assert.match(within(table).getAllByRole('row')[1].textContent ?? '', /Demo Unit 101/);
});

test('pagination uses stable unit identifiers for later pages', async () => {
  const user = userEvent.setup();
  render(<IntelligenceDashboard />);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  assert.ok(screen.getByText('Page 2 of 2 · 7 assessments'));
  assert.ok(screen.getByRole('row', { name: /Demo Unit 302/ }));
  assert.ok(screen.getByRole('row', { name: /Demo Unit 401/ }));
  assert.equal(screen.queryByRole('row', { name: /Demo Unit 101/ }), null);
});

test('empty search results provide a clear status message', async () => {
  const user = userEvent.setup();
  render(<IntelligenceDashboard />);
  await user.type(screen.getByRole('searchbox', { name: 'Search assessments' }), 'no matching synthetic record');
  assert.ok(screen.getByRole('status'));
  assert.ok(screen.getByText('No assessments match these filters'));
  assert.equal(screen.queryByRole('navigation', { name: 'Assessment pagination' }), null);
});

test('accessible detail dialog explains triggered rules and unknown data', async () => {
  const user = userEvent.setup();
  render(<IntelligenceDashboard />);
  await user.click(screen.getByRole('button', { name: 'Inspect assessment for Demo Unit 201' }));
  const dialog = screen.getByRole('dialog', { name: 'Demo Unit 201' });
  assert.ok(within(dialog).getByText('70 / 90'));
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(within(dialog).getByText('Vacant unit (+40)'));
  assert.ok(within(dialog).getByText('Lease expires within 90 days (+30)'));
  await user.keyboard('{Escape}');
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(
    document.activeElement,
    screen.getByRole('button', { name: 'Inspect assessment for Demo Unit 201' }),
  );

  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Inspect assessment for Demo Unit 302' }));
  const incompleteDialog = screen.getByRole('dialog', { name: 'Demo Unit 302' });
  assert.ok(within(incompleteDialog).getByText('Incomplete inputs: this score is not a low-risk conclusion.'));
  assert.ok(within(incompleteDialog).getByText('isVacant'));
  assert.ok(within(incompleteDialog).getByText('leaseExpiryDays'));
  assert.ok(within(incompleteDialog).getByText('hasOutstandingMaintenance'));

  await user.click(within(incompleteDialog).getByRole('button', { name: 'Close assessment' }));
  await user.click(screen.getByRole('button', { name: 'Inspect assessment for Demo Unit 401' }));
  const expiredDialog = screen.getByRole('dialog', { name: 'Demo Unit 401' });
  assert.ok(within(expiredDialog).getByText(/Lease expired 15 days/));
});

test('search and filter combinations can be reset to the full table', async () => {
  const user = userEvent.setup();
  render(<IntelligenceDashboard />);
  await user.selectOptions(screen.getByLabelText('Priority'), 'low');
  await user.selectOptions(screen.getByLabelText('Data completeness'), 'false');
  assert.ok(screen.getByRole('row', { name: /Demo Unit 302/ }));

  await user.selectOptions(screen.getByLabelText('Priority'), 'all');
  await user.selectOptions(screen.getByLabelText('Data completeness'), 'all');
  assert.equal(screen.getAllByRole('row').length, 6);
});
