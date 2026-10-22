import assert from 'node:assert/strict';
import test from 'node:test';
import { isPreviewRequestAllowed } from '../../src/lib/preview-route-policy';

test('only the preview home and unavailable-state pages are accessible', () => {
  for (const pathname of ['/', '/properties', '/preview-unavailable']) {
    assert.equal(isPreviewRequestAllowed(pathname, 'GET'), true, pathname);
    assert.equal(isPreviewRequestAllowed(pathname, 'HEAD'), true, pathname);
  }

  for (const pathname of [
    '/intelligence',
    '/leases',
    '/finance',
    '/login',
    '/properties/',
    '/properties/123',
    '/api',
    '/api/',
    '/api/auth/callback',
    '/api/properties',
    '/api%2fauth%2flogin',
    '/%61pi/auth/login',
  ]) {
    assert.equal(isPreviewRequestAllowed(pathname, 'GET'), false, pathname);
  }
});

test('only read-only document methods are allowed', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(isPreviewRequestAllowed('/', method), false, method);
    assert.equal(isPreviewRequestAllowed('/properties', method), false, method);
  }
});
