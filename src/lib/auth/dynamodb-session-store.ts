import 'server-only';

import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SessionStoreNotConfiguredError,
  type SessionStore,
  type StoredSession,
} from './session-store';

const DEFAULT_IDLE_TTL_SECONDS = 30 * 60;
const DEFAULT_CONNECTION_TIMEOUT_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const SESSION_KEY_PATTERN = /^[a-f0-9]{64}$/;

export type DynamoDbSessionStoreOptions = {
  client: DynamoDBDocumentClient;
  tableName: string;
  idleTtlSeconds: number;
  now?: () => number;
};

export class InvalidDynamoDbSessionRecordError extends Error {
  constructor() {
    super('DynamoDB returned an invalid session record.');
    this.name = 'InvalidDynamoDbSessionRecordError';
  }
}

export class InvalidDynamoDbSessionStoreConfigurationError extends Error {
  constructor() {
    super('DynamoDB session-store configuration is invalid.');
    this.name = 'InvalidDynamoDbSessionStoreConfigurationError';
  }
}

function isPlainStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isStoredSession(value: unknown): value is StoredSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isPlainStringRecord(record.data) &&
    Number.isSafeInteger(record.createdAt) &&
    Number.isSafeInteger(record.lastSeenAt) &&
    Number.isSafeInteger(record.absoluteExpiresAt) &&
    (record.createdAt as number) <= (record.lastSeenAt as number) &&
    (record.lastSeenAt as number) <= (record.absoluteExpiresAt as number)
  );
}

function hasActiveLifetime(
  session: StoredSession,
  at: number,
  idleTtlSeconds: number,
): boolean {
  return (
    at < session.absoluteExpiresAt &&
    at < session.lastSeenAt + idleTtlSeconds * 1000
  );
}

function getRecord(item: Record<string, unknown> | undefined): StoredSession | null {
  if (item === undefined) return null;
  const session = {
    data: item.data,
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
    absoluteExpiresAt: item.absoluteExpiresAt,
  };
  if (!isStoredSession(session)) {
    throw new InvalidDynamoDbSessionRecordError();
  }
  return session;
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'ConditionalCheckFailedException'
  );
}

function isConditionalTransactionFailure(error: unknown): boolean {
  if (
    error === null ||
    typeof error !== 'object' ||
    !('name' in error) ||
    error.name !== 'TransactionCanceledException' ||
    !('CancellationReasons' in error) ||
    !Array.isArray(error.CancellationReasons)
  ) {
    return false;
  }
  return error.CancellationReasons.some(
    (reason) =>
      reason !== null &&
      typeof reason === 'object' &&
      'Code' in reason &&
      reason.Code === 'ConditionalCheckFailed',
  );
}

export function createDynamoDbSessionStore(
  options: DynamoDbSessionStoreOptions,
): SessionStore {
  const { client, tableName, idleTtlSeconds } = options;
  const now = options.now ?? Date.now;
  if (
    !tableName.trim() ||
    !Number.isSafeInteger(idleTtlSeconds) ||
    idleTtlSeconds <= 0
  ) {
    throw new InvalidDynamoDbSessionStoreConfigurationError();
  }

  function assertKey(key: string): void {
    if (!SESSION_KEY_PATTERN.test(key)) {
      throw new TypeError('Session store key is invalid.');
    }
  }

  function toItem(key: string, session: StoredSession): Record<string, unknown> {
    assertKey(key);
    if (!isStoredSession(session)) {
      throw new TypeError('Session record is invalid.');
    }
    return {
      sessionKey: key,
      data: { ...session.data },
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      expiresAt: Math.floor(
        Math.min(
          session.absoluteExpiresAt,
          session.lastSeenAt + idleTtlSeconds * 1000,
        ) / 1000,
      ),
    };
  }

  async function read(key: string): Promise<StoredSession | null> {
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { sessionKey: key },
        ConsistentRead: true,
      }),
    );
    const session = getRecord(result.Item);
    if (!session || !hasActiveLifetime(session, now(), idleTtlSeconds)) {
      return null;
    }
    return session;
  }

  return {
    async create(key, session) {
      const item = toItem(key, session);
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(#sessionKey)',
            ExpressionAttributeNames: { '#sessionKey': 'sessionKey' },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async get(key) {
      assertKey(key);
      return read(key);
    },

    async update(key, session) {
      assertKey(key);
      if (!isStoredSession(session)) {
        throw new TypeError('Session record is invalid.');
      }
      const at = now();
      const idleCutoff = at - idleTtlSeconds * 1000;
      const expiresAt = Math.floor(
        Math.min(
          session.absoluteExpiresAt,
          session.lastSeenAt + idleTtlSeconds * 1000,
        ) / 1000,
      );
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { sessionKey: key },
            UpdateExpression: 'SET #lastSeenAt = :lastSeenAt, #expiresAt = :expiresAt',
            ConditionExpression:
              'attribute_exists(#sessionKey) AND #absoluteExpiresAt > :now AND #lastSeenAt > :idleCutoff AND #lastSeenAt <= :newLastSeenAt',
            ExpressionAttributeNames: {
              '#sessionKey': 'sessionKey',
              '#lastSeenAt': 'lastSeenAt',
              '#absoluteExpiresAt': 'absoluteExpiresAt',
              '#expiresAt': 'expiresAt',
            },
            ExpressionAttributeValues: {
              ':lastSeenAt': session.lastSeenAt,
              ':newLastSeenAt': session.lastSeenAt,
              ':expiresAt': expiresAt,
              ':now': at,
              ':idleCutoff': idleCutoff,
            },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async rotate(currentKey, nextKey, session) {
      assertKey(currentKey);
      assertKey(nextKey);
      const item = toItem(nextKey, session);
      const current = await read(currentKey);
      if (!current) return false;

      const at = now();
      const idleCutoff = at - idleTtlSeconds * 1000;
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: item,
                  ConditionExpression: 'attribute_not_exists(#sessionKey)',
                  ExpressionAttributeNames: {
                    '#sessionKey': 'sessionKey',
                  },
                },
              },
              {
                Delete: {
                  TableName: tableName,
                  Key: { sessionKey: currentKey },
                  ConditionExpression:
                    'attribute_exists(#sessionKey) AND #lastSeenAt = :expectedLastSeenAt AND #absoluteExpiresAt > :now AND #lastSeenAt > :idleCutoff',
                  ExpressionAttributeNames: {
                    '#sessionKey': 'sessionKey',
                    '#lastSeenAt': 'lastSeenAt',
                    '#absoluteExpiresAt': 'absoluteExpiresAt',
                  },
                  ExpressionAttributeValues: {
                    ':expectedLastSeenAt': current.lastSeenAt,
                    ':now': at,
                    ':idleCutoff': idleCutoff,
                  },
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalTransactionFailure(error)) return false;
        throw error;
      }
    },

    async delete(key) {
      assertKey(key);
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { sessionKey: key },
        }),
      );
    },
  };
}

function requiredEnvironmentValue(
  environment: Record<string, string | undefined>,
  key: string,
): string {
  const value = environment[key]?.trim();
  if (!value) throw new SessionStoreNotConfiguredError();
  return value;
}

export function createConfiguredDynamoDbSessionStore(
  environment: Record<string, string | undefined> = process.env,
): SessionStore {
  const tableName = requiredEnvironmentValue(
    environment,
    'SESSION_DYNAMODB_TABLE',
  );
  const region = requiredEnvironmentValue(environment, 'AWS_REGION');
  const configuredIdleTtl = environment.SESSION_IDLE_TTL_SECONDS;
  const idleTtlSeconds =
    configuredIdleTtl === undefined
      ? DEFAULT_IDLE_TTL_SECONDS
      : Number(configuredIdleTtl);
  if (!Number.isSafeInteger(idleTtlSeconds) || idleTtlSeconds <= 0) {
    throw new InvalidDynamoDbSessionStoreConfigurationError();
  }

  const clientConfig: DynamoDBClientConfig = {
    region,
    maxAttempts: 2,
    requestHandler: {
      connectionTimeout: DEFAULT_CONNECTION_TIMEOUT_MS,
      requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
    },
  };
  const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
    marshallOptions: { removeUndefinedValues: false },
  });
  return createDynamoDbSessionStore({ client, tableName, idleTtlSeconds });
}
