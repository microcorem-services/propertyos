import 'server-only';

export type StoredSession = {
  data: Record<string, string>;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
};

export interface SessionStore {
  /** Insert only if the key is unused. */
  create(key: string, session: StoredSession): Promise<boolean>;
  get(key: string): Promise<StoredSession | null>;
  /** Update only an existing key; do not recreate a concurrently revoked session. */
  update(key: string, session: StoredSession): Promise<boolean>;
  /** Atomically replace currentKey with nextKey, invalidating the former. */
  rotate(
    currentKey: string,
    nextKey: string,
    session: StoredSession,
  ): Promise<boolean>;
  delete(key: string): Promise<void>;
}

let configuredStore: SessionStore | undefined;

export class SessionStoreNotConfiguredError extends Error {
  constructor() {
    super('A shared server-side session store has not been configured.');
    this.name = 'SessionStoreNotConfiguredError';
  }
}

export function configureSessionStore(store: SessionStore): void {
  if (configuredStore && configuredStore !== store) {
    throw new Error('The session store has already been configured.');
  }
  configuredStore = store;
}

export function getConfiguredSessionStore(): SessionStore {
  if (!configuredStore) {
    throw new SessionStoreNotConfiguredError();
  }
  return configuredStore;
}
