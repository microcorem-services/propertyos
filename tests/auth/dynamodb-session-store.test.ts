import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  createConfiguredDynamoDbSessionStore,
  createDynamoDbSessionStore,
  InvalidDynamoDbSessionRecordError,
  type DynamoDbSessionStoreOptions,
} from '../../src/lib/auth/dynamodb-session-store';
import type { StoredSession } from '../../src/lib/auth/session-store';

type DynamoCommand =
  | DeleteCommand
  | GetCommand
  | PutCommand
  | TransactWriteCommand
  | UpdateCommand;

function mockClient(
  send: (command: DynamoCommand) => Promise<unknown>,
): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function makeStore(
  send: (command: DynamoCommand) => Promise<unknown>,
  overrides: Partial<DynamoDbSessionStoreOptions> = {},
) {
  return createDynamoDbSessionStore({
    client: mockClient(send),
    tableName: 'sessions',
    idleTtlSeconds: 30,
    now: () => 100_000,
    ...overrides,
  });
}

function record(
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return {
    data: { accessToken: 'server-only-token' },
    createdAt: 80_000,
    lastSeenAt: 90_000,
    absoluteExpiresAt: 200_000,
    ...overrides,
  };
}

const validKey = 'a'.repeat(64);
const anotherKey = 'b'.repeat(64);

test('reads a strongly consistent record and returns only the stored session fields', async () => {
  let captured: DynamoCommand | undefined;
  const store = makeStore(async (command) => {
    captured = command;
    return {
      Item: {
        sessionKey: validKey,
        ...record(),
        expiresAt: 120,
      },
    };
  });

  assert.deepEqual(await store.get(validKey), record());
  assert.ok(captured instanceof GetCommand);
  assert.equal(captured.input.ConsistentRead, true);
  assert.deepEqual(captured.input.Key, { sessionKey: validKey });
});

test('enforces absolute and idle expiry without depending on DynamoDB TTL deletion', async () => {
  const items = [
    { sessionKey: validKey, ...record({ absoluteExpiresAt: 99_999 }) },
    {
      sessionKey: validKey,
      ...record({ createdAt: 60_000, lastSeenAt: 69_999 }),
    },
  ];
  const store = makeStore(async () => ({ Item: items.shift() }));

  assert.equal(await store.get(validKey), null);
  assert.equal(await store.get(validKey), null);
});

test('fails closed on malformed stored session records', async () => {
  const store = makeStore(async () => ({
    Item: {
      sessionKey: validKey,
      ...record(),
      data: { accessToken: 12 },
    },
  }));

  await assert.rejects(store.get(validKey), InvalidDynamoDbSessionRecordError);
});

test('creates conditionally and sets TTL to the earlier idle or absolute expiry', async () => {
  let captured: DynamoCommand | undefined;
  const store = makeStore(async (command) => {
    captured = command;
    return {};
  });

  assert.equal(await store.create(validKey, record()), true);
  assert.ok(captured instanceof PutCommand);
  assert.equal(
    captured.input.ConditionExpression,
    'attribute_not_exists(#sessionKey)',
  );
  assert.deepEqual(captured.input.Item, {
    sessionKey: validKey,
    ...record(),
    expiresAt: 120,
  });
});

test('returns a conflict for conditional create failure and propagates other failures', async () => {
  const conflict = Object.assign(new Error('conditional'), {
    name: 'ConditionalCheckFailedException',
  });
  const conflictStore = makeStore(async () => {
    throw conflict;
  });
  assert.equal(await conflictStore.create(validKey, record()), false);

  const unavailable = new Error('DynamoDB unavailable');
  const failingStore = makeStore(async () => {
    throw unavailable;
  });
  await assert.rejects(failingStore.create(validKey, record()), unavailable);
});

test('updates only active records, conditionally advances last-seen and refreshes TTL', async () => {
  let captured: DynamoCommand | undefined;
  const store = makeStore(async (command) => {
    captured = command;
    return {};
  });

  assert.equal(
    await store.update(validKey, record({ lastSeenAt: 100_000 })),
    true,
  );
  assert.ok(captured instanceof UpdateCommand);
  assert.match(captured.input.ConditionExpression ?? '', /#absoluteExpiresAt > :now/);
  assert.match(captured.input.ConditionExpression ?? '', /#lastSeenAt > :idleCutoff/);
  assert.match(captured.input.ConditionExpression ?? '', /#lastSeenAt <= :newLastSeenAt/);
  assert.equal(captured.input.ExpressionAttributeValues?.[':expiresAt'], 130);
});

test('returns false when a conditional update loses a race', async () => {
  const conflict = Object.assign(new Error('conditional'), {
    name: 'ConditionalCheckFailedException',
  });
  const store = makeStore(async () => {
    throw conflict;
  });

  assert.equal(
    await store.update(validKey, record({ lastSeenAt: 100_000 })),
    false,
  );
});

test('rotates using one atomic transaction and conditions on the source version', async () => {
  const commands: DynamoCommand[] = [];
  const store = makeStore(async (command) => {
    commands.push(command);
    if (command instanceof GetCommand) {
      return {
        Item: { sessionKey: validKey, ...record(), expiresAt: 120 },
      };
    }
    return {};
  });

  assert.equal(
    await store.rotate(validKey, anotherKey, record({ lastSeenAt: 100_000 })),
    true,
  );
  assert.equal(commands.length, 2);
  assert.ok(commands[0] instanceof GetCommand);
  assert.equal(commands[0].input.ConsistentRead, true);
  assert.ok(commands[1] instanceof TransactWriteCommand);
  const operations = commands[1].input.TransactItems;
  assert.equal(operations?.length, 2);
  assert.ok('Put' in operations![0]);
  assert.ok('Delete' in operations![1]);
  assert.equal(
    operations![0].Put?.ConditionExpression,
    'attribute_not_exists(#sessionKey)',
  );
  assert.match(operations![1].Delete?.ConditionExpression ?? '', /#lastSeenAt = :expectedLastSeenAt/);
});

test('returns false on a transaction conditional conflict and propagates non-conditional cancellation', async () => {
  const conditionalConflict = Object.assign(new Error('transaction canceled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  });
  let failTransaction = true;
  const store = makeStore(async (command) => {
    if (command instanceof GetCommand) {
      return { Item: { sessionKey: validKey, ...record(), expiresAt: 120 } };
    }
    if (failTransaction) throw conditionalConflict;
    throw Object.assign(new Error('transaction canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }],
    });
  });

  assert.equal(
    await store.rotate(validKey, anotherKey, record({ lastSeenAt: 100_000 })),
    false,
  );
  failTransaction = false;
  await assert.rejects(
    store.rotate(validKey, anotherKey, record({ lastSeenAt: 100_000 })),
    { name: 'TransactionCanceledException' },
  );
});

test('does not attempt rotation for an expired or missing source record', async () => {
  let sendCount = 0;
  const store = makeStore(async () => {
    sendCount += 1;
    return {};
  });

  assert.equal(
    await store.rotate(validKey, anotherKey, record({ lastSeenAt: 100_000 })),
    false,
  );
  assert.equal(sendCount, 1);
});

test('revokes idempotently and propagates DynamoDB failures', async () => {
  let captured: DynamoCommand | undefined;
  const store = makeStore(async (command) => {
    captured = command;
    return {};
  });
  await store.delete(validKey);
  assert.ok(captured instanceof DeleteCommand);
  assert.deepEqual(captured.input.Key, { sessionKey: validKey });

  const unavailable = new Error('DynamoDB unavailable');
  await assert.rejects(
    makeStore(async () => {
      throw unavailable;
    }).delete(validKey),
    unavailable,
  );
});

test('rejects invalid keys and store configuration', async () => {
  const store = makeStore(async () => ({}));
  await assert.rejects(store.get('not-a-hash'), TypeError);
  await assert.rejects(store.delete('not-a-hash'), TypeError);
  assert.throws(
    () =>
      createDynamoDbSessionStore({
        client: mockClient(async () => ({})),
        tableName: 'sessions',
        idleTtlSeconds: 0,
      }),
    { name: 'InvalidDynamoDbSessionStoreConfigurationError' },
  );
});

test('requires table and region configuration without requiring static credentials', () => {
  assert.throws(
    () => createConfiguredDynamoDbSessionStore({}),
    { name: 'SessionStoreNotConfiguredError' },
  );
  assert.throws(
    () =>
      createConfiguredDynamoDbSessionStore({
        AWS_REGION: 'eu-west-2',
      }),
    { name: 'SessionStoreNotConfiguredError' },
  );
});
