import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSessionManager,
  getSessionManager,
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../../src/lib/auth/session';
import type {
  SessionStore,
  StoredSession,
} from '../../src/lib/auth/session-store';

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else Reflect.set(process.env, name, value);
}

class TestSessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  async create(key: string, session: StoredSession): Promise<boolean> {
    if (this.sessions.has(key)) return false;
    this.sessions.set(key, structuredClone(session));
    return true;
  }

  async get(key: string): Promise<StoredSession | null> {
    const session = this.sessions.get(key);
    return session ? structuredClone(session) : null;
  }

  async update(key: string, session: StoredSession): Promise<boolean> {
    if (!this.sessions.has(key)) return false;
    this.sessions.set(key, structuredClone(session));
    return true;
  }

  async rotate(
    currentKey: string,
    nextKey: string,
    session: StoredSession,
  ): Promise<boolean> {
    if (!this.sessions.has(currentKey) || this.sessions.has(nextKey)) return false;
    this.sessions.delete(currentKey);
    this.sessions.set(nextKey, structuredClone(session));
    return true;
  }

  async delete(key: string): Promise<void> {
    this.sessions.delete(key);
  }

  get size(): number {
    return this.sessions.size;
  }
}

test('creates an opaque session identifier and stores session data server-side', async () => {
  const store = new TestSessionStore();
  const manager = createSessionManager(store);
  const session = await manager.create({ accessToken: 'test-token' });

  assert.match(session.id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.data.accessToken, 'test-token');
  assert.equal(store.size, 1);
  assert.equal(session.cookieMaxAgeSeconds, 30 * 60);
});

test('retrieval slides idle expiry without extending absolute expiry', async () => {
  const store = new TestSessionStore();
  let clock = 1_000;
  const manager = createSessionManager(store, {
    absoluteTtlSeconds: 60,
    idleTtlSeconds: 10,
    now: () => clock,
  });
  const created = await manager.create();

  clock += 5_000;
  const retrieved = await manager.retrieve(created.id);
  assert.equal(retrieved?.lastSeenAt, clock);
  assert.equal(retrieved?.cookieMaxAgeSeconds, 10);
  assert.equal(retrieved?.absoluteExpiresAt, 61_000);

  clock = 61_000;
  assert.equal(await manager.retrieve(created.id), null);
  assert.equal(store.size, 0);
});

test('expires a session after its idle lifetime', async () => {
  const store = new TestSessionStore();
  let clock = 10_000;
  const manager = createSessionManager(store, {
    absoluteTtlSeconds: 60,
    idleTtlSeconds: 10,
    now: () => clock,
  });
  const created = await manager.create();

  clock += 10_000;
  assert.equal(await manager.retrieve(created.id), null);
  assert.equal(store.size, 0);
});

test('does not revive a session that expires while retrieval is in progress', async () => {
  const store = new TestSessionStore();
  const clockValues = [0, 9_999, 10_000];
  const manager = createSessionManager(store, {
    absoluteTtlSeconds: 60,
    idleTtlSeconds: 10,
    now: () => clockValues.shift() ?? 10_000,
  });
  const created = await manager.create();

  assert.equal(await manager.retrieve(created.id), null);
  assert.equal(store.size, 0);
});

test('rotates identifiers atomically while preserving the absolute deadline', async () => {
  const store = new TestSessionStore();
  let clock = 0;
  const manager = createSessionManager(store, {
    absoluteTtlSeconds: 60,
    idleTtlSeconds: 10,
    now: () => clock,
  });
  const created = await manager.create({ refreshToken: 'server-side-only' });

  clock = 5_000;
  const rotated = await manager.rotate(created.id);

  assert.ok(rotated);
  assert.notEqual(rotated.id, created.id);
  assert.equal(rotated.data.refreshToken, 'server-side-only');
  assert.equal(rotated.createdAt, created.createdAt);
  assert.equal(rotated.absoluteExpiresAt, created.absoluteExpiresAt);
  assert.equal(await manager.retrieve(created.id), null);
  assert.equal(
    (await manager.retrieve(rotated.id))?.data.refreshToken,
    'server-side-only',
  );
  assert.equal(store.size, 1);
});

test('revokes a session and rejects later retrieval', async () => {
  const store = new TestSessionStore();
  const manager = createSessionManager(store);
  const created = await manager.create();

  await manager.revoke(created.id);
  assert.equal(await manager.retrieve(created.id), null);
  assert.equal(store.size, 0);
});

test('refuses to construct the configured manager without a shared store', () => {
  assert.throws(getSessionManager, { name: 'SessionStoreNotConfiguredError' });
});

test('sets a production-only Secure host cookie and never includes session data', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecure = process.env.SESSION_COOKIE_SECURE;
  setEnvironment('NODE_ENV', 'production');
  setEnvironment('SESSION_COOKIE_SECURE', undefined);

  try {
    const cookie = serializeSessionCookie('a'.repeat(43), 300);
    assert.match(cookie, /^__Host-propertyos_session=/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\//);
    assert.doesNotMatch(cookie, /test-token|refreshToken/);
  } finally {
    setEnvironment('NODE_ENV', originalNodeEnv);
    setEnvironment('SESSION_COOKIE_SECURE', originalSecure);
  }
});

test('allows insecure cookies only outside production and rejects insecure production config', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecure = process.env.SESSION_COOKIE_SECURE;
  setEnvironment('NODE_ENV', 'development');
  setEnvironment('SESSION_COOKIE_SECURE', 'false');
  try {
    assert.doesNotMatch(serializeSessionCookie('b'.repeat(43), 300), /; Secure/);
    setEnvironment('NODE_ENV', 'production');
    assert.throws(
      () => serializeSessionCookie('b'.repeat(43), 300),
      { name: 'InvalidSessionConfigurationError' },
    );
  } finally {
    setEnvironment('NODE_ENV', originalNodeEnv);
    setEnvironment('SESSION_COOKIE_SECURE', originalSecure);
  }
});

test('parses only one well-formed session cookie and can clear it safely', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  setEnvironment('NODE_ENV', 'development');
  try {
    const id = 'c'.repeat(43);
    assert.equal(readSessionCookie(`other=x; propertyos_session=${id}`), id);
    assert.equal(
      readSessionCookie(`propertyos_session=${id}; propertyos_session=${id}`),
      null,
    );
    assert.equal(readSessionCookie('propertyos_session=bad'), null);
    assert.match(serializeClearedSessionCookie(), /; HttpOnly; SameSite=Lax; Max-Age=0/);
  } finally {
    setEnvironment('NODE_ENV', originalNodeEnv);
  }
});

test('rejects invalid session lifetime configuration', () => {
  assert.throws(
    () => createSessionManager(new TestSessionStore(), {
      absoluteTtlSeconds: 10,
      idleTtlSeconds: 11,
    }),
    { name: 'InvalidSessionConfigurationError' },
  );
});
