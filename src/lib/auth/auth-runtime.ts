import 'server-only';

import { createConfiguredDynamoDbSessionStore } from './dynamodb-session-store';
import { createSessionManager } from './session';
import {
  configureSessionStore,
  type SessionStore,
} from './session-store';

const LOGIN_TRANSACTION_TTL_SECONDS = 10 * 60;

export type AuthSessionManagers = {
  authenticated: ReturnType<typeof createSessionManager>;
  transactions: ReturnType<typeof createSessionManager>;
};

let sessionStore: SessionStore | undefined;
let managers: AuthSessionManagers | undefined;

export function getAuthSessionManagers(): AuthSessionManagers {
  if (!managers) {
    sessionStore ??= createConfiguredDynamoDbSessionStore();
    configureSessionStore(sessionStore);
    managers = {
      authenticated: createSessionManager(sessionStore),
      transactions: createSessionManager(sessionStore, {
        absoluteTtlSeconds: LOGIN_TRANSACTION_TTL_SECONDS,
        idleTtlSeconds: LOGIN_TRANSACTION_TTL_SECONDS,
      }),
    };
  }
  return managers;
}
