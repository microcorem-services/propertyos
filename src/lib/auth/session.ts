import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import {
  getConfiguredSessionStore,
  type SessionStore,
  type StoredSession,
} from './session-store';

const DEFAULT_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_IDLE_TTL_SECONDS = 30 * 60;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type Session = {
  id: string;
  data: Record<string, string>;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
  cookieMaxAgeSeconds: number;
};

export type SessionManagerOptions = {
  absoluteTtlSeconds?: number;
  idleTtlSeconds?: number;
  now?: () => number;
};

export class InvalidSessionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionConfigurationError';
  }
}

function validateData(data: Record<string, string>): Record<string, string> {
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.getPrototypeOf(data) !== Object.prototype ||
    Object.values(data).some((value) => typeof value !== 'string')
  ) {
    throw new TypeError('Session data must be a plain object of string values.');
  }
  return { ...data };
}

function isValidRecord(record: StoredSession): boolean {
  return (
    record !== null &&
    typeof record === 'object' &&
    Number.isSafeInteger(record.createdAt) &&
    Number.isSafeInteger(record.lastSeenAt) &&
    Number.isSafeInteger(record.absoluteExpiresAt) &&
    record.createdAt <= record.lastSeenAt &&
    record.lastSeenAt <= record.absoluteExpiresAt &&
    record.data !== null &&
    typeof record.data === 'object' &&
    !Array.isArray(record.data) &&
    Object.getPrototypeOf(record.data) === Object.prototype &&
    Object.values(record.data).every((value) => typeof value === 'string')
  );
}

function sessionKey(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

function createId(): string {
  return randomBytes(32).toString('base64url');
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function createSessionManager(
  store: SessionStore,
  options: SessionManagerOptions = {},
) {
  const absoluteTtlSeconds =
    options.absoluteTtlSeconds ?? DEFAULT_ABSOLUTE_TTL_SECONDS;
  const idleTtlSeconds = options.idleTtlSeconds ?? DEFAULT_IDLE_TTL_SECONDS;
  const now = options.now ?? Date.now;

  if (
    !Number.isSafeInteger(absoluteTtlSeconds) ||
    absoluteTtlSeconds <= 0 ||
    !Number.isSafeInteger(idleTtlSeconds) ||
    idleTtlSeconds <= 0 ||
    idleTtlSeconds > absoluteTtlSeconds
  ) {
    throw new InvalidSessionConfigurationError(
      'Session idle and absolute lifetimes must be positive whole seconds, with idle no longer than absolute.',
    );
  }

  function isExpired(record: StoredSession, at: number): boolean {
    return (
      at >= record.absoluteExpiresAt ||
      at - record.lastSeenAt >= idleTtlSeconds * 1000
    );
  }

  function toSession(id: string, record: StoredSession, at: number): Session {
    const idleExpiresAt = Math.min(
      record.lastSeenAt + idleTtlSeconds * 1000,
      record.absoluteExpiresAt,
    );
    return {
      id,
      data: { ...record.data },
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      absoluteExpiresAt: record.absoluteExpiresAt,
      idleExpiresAt,
      cookieMaxAgeSeconds: Math.max(0, Math.floor((idleExpiresAt - at) / 1000)),
    };
  }

  async function loadActive(id: string): Promise<StoredSession | null> {
    if (!isSessionId(id)) return null;
    const key = sessionKey(id);
    const record = await store.get(key);
    if (!record) return null;
    if (!isValidRecord(record)) {
      await store.delete(key);
      return null;
    }
    if (isExpired(record, now())) {
      await store.delete(key);
      return null;
    }
    return record;
  }

  return {
    async create(data: Record<string, string> = {}): Promise<Session> {
      const safeData = validateData(data);
      const createdAt = now();
      const record: StoredSession = {
        data: safeData,
        createdAt,
        lastSeenAt: createdAt,
        absoluteExpiresAt: createdAt + absoluteTtlSeconds * 1000,
      };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const id = createId();
        if (await store.create(sessionKey(id), record)) {
          return toSession(id, record, createdAt);
        }
      }
      throw new Error('Unable to allocate a unique session identifier.');
    },

    async retrieve(id: string): Promise<Session | null> {
      const record = await loadActive(id);
      if (!record) return null;
      const at = now();
      if (isExpired(record, at)) {
        await store.delete(sessionKey(id));
        return null;
      }
      const updated: StoredSession = { ...record, lastSeenAt: at };
      if (!(await store.update(sessionKey(id), updated))) return null;
      return toSession(id, updated, at);
    },

    async rotate(
      currentId: string,
      data?: Record<string, string>,
    ): Promise<Session | null> {
      const current = await loadActive(currentId);
      if (!current) return null;
      const at = now();
      if (isExpired(current, at)) {
        await store.delete(sessionKey(currentId));
        return null;
      }
      const nextRecord: StoredSession = {
        data: data === undefined ? { ...current.data } : validateData(data),
        createdAt: current.createdAt,
        lastSeenAt: at,
        absoluteExpiresAt: current.absoluteExpiresAt,
      };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const nextId = createId();
        if (
          await store.rotate(
            sessionKey(currentId),
            sessionKey(nextId),
            nextRecord,
          )
        ) {
          return toSession(nextId, nextRecord, at);
        }
      }
      throw new Error('Unable to rotate the session identifier.');
    },

    async revoke(id: string): Promise<void> {
      if (isSessionId(id)) {
        await store.delete(sessionKey(id));
      }
    },
  };
}

export function getSessionManager() {
  return createSessionManager(getConfiguredSessionStore());
}

function cookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? '__Host-propertyos_session'
    : 'propertyos_session';
}

function cookieSecure(): boolean {
  const configured = process.env.SESSION_COOKIE_SECURE;
  if (configured !== undefined && configured !== 'true' && configured !== 'false') {
    throw new InvalidSessionConfigurationError(
      'SESSION_COOKIE_SECURE must be true or false.',
    );
  }
  if (process.env.NODE_ENV === 'production' && configured === 'false') {
    throw new InvalidSessionConfigurationError(
      'Session cookies must be Secure in production.',
    );
  }
  return process.env.NODE_ENV === 'production' || configured === 'true';
}

export function serializeSessionCookie(id: string, maxAgeSeconds: number): string {
  if (!isSessionId(id)) {
    throw new TypeError('Invalid session identifier.');
  }
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new TypeError('Cookie lifetime must be a positive whole number of seconds.');
  }

  const attributes = [
    `${cookieName()}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (cookieSecure()) attributes.push('Secure');
  return attributes.join('; ');
}

export function serializeClearedSessionCookie(): string {
  const attributes = [
    `${cookieName()}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (cookieSecure()) attributes.push('Secure');
  return attributes.join('; ');
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const name = cookieName();
  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const id = matches[0].slice(name.length + 1);
  return isSessionId(id) ? id : null;
}
