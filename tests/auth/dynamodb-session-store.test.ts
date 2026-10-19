import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
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
  | TransactWriteCommand;

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
const sessionItem = (key = validKey, value = record()) => ({
  sessionKey: key,
  familyKey: validKey,
  ...value,
  expiresAt: 120,
});

function makeRaceStore(
  beforeTransaction?: (kind: 'rotate' | 'revoke') => Promise<void>,
) {
  const items = new Map<string, Record<string, unknown>>([
    [validKey, sessionItem()],
  ]);
  const store = makeStore(async (command) => {
    if (command instanceof GetCommand) {
      const key = String(command.input.Key?.sessionKey);
      const item = items.get(key);
      return item ? { Item: structuredClone(item) } : {};
    }
    if (command instanceof TransactWriteCommand) {
      const operations = command.input.TransactItems ?? [];
      const rotation = operations.some((operation) => 'Update' in operation);
      const kind = rotation ? 'rotate' : 'revoke';
      await beforeTransaction?.(kind);

      const put = operations[0]?.Put?.Item as Record<string, unknown> | undefined;
      const sourceOperation = rotation
        ? operations[1]?.Update
        : operations[1]?.Delete;
      const sourceKey = String(sourceOperation?.Key?.sessionKey);
      const source = items.get(sourceKey);
      const familyKey = String(put?.familyKey ?? source?.familyKey);
      const markerKey = `revoked#${familyKey}`;
      if (
        !put ||
        !source ||
        items.has(markerKey) ||
        (rotation && source.status === 'rotated') ||
        (!rotation && source.status === 'rotated') ||
        (!rotation && source.familyKey !== familyKey)
      ) {
        throw Object.assign(new Error('conditional transaction conflict'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        });
      }

      if (rotation) {
        const nextKey = String(put.sessionKey);
        if (items.has(nextKey)) {
          throw Object.assign(new Error('conditional transaction conflict'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          });
        }
        items.set(sourceKey, {
          ...source,
          status: 'rotated',
          data: {},
          expiresAt: Math.floor(Number(source.absoluteExpiresAt) / 1000),
        });
        items.set(nextKey, structuredClone(put));
      } else {
        if (items.has(markerKey)) {
          throw Object.assign(new Error('conditional transaction conflict'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          });
        }
        const marker = operations[0]?.Put?.Item as Record<string, unknown>;
        items.set(String(marker.sessionKey), structuredClone(marker));
        items.delete(sourceKey);
      }
      return {};
    }
    return {};
  });
  return { store, items };
}

test('reads a strongly consistent record and returns only the stored session fields', async () => {
  const commands: DynamoCommand[] = [];
  const store = makeStore(async (command) => {
    commands.push(command);
    if (
      command instanceof GetCommand &&
      command.input.Key?.sessionKey === validKey
    ) {
      return {
        Item: sessionItem(),
      };
    }
    return {};
  });

  assert.deepEqual(await store.get(validKey), record());
  assert.ok(commands[0] instanceof GetCommand);
  assert.equal(commands[0].input.ConsistentRead, true);
  assert.deepEqual(commands[0].input.Key, { sessionKey: validKey });
  assert.ok(commands[1] instanceof GetCommand);
  assert.deepEqual(commands[1].input.Key, { sessionKey: `revoked#${validKey}` });
});

test('enforces absolute and idle expiry without depending on DynamoDB TTL deletion', async () => {
  const items = [
    { ...sessionItem(), absoluteExpiresAt: 99_999 },
    {
      ...sessionItem(validKey, record({ createdAt: 60_000, lastSeenAt: 69_999 })),
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
      familyKey: validKey,
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
  assert.ok(captured instanceof TransactWriteCommand);
  assert.equal(captured.input.TransactItems?.length, 2);
  assert.equal(
    captured.input.TransactItems?.[0].Put?.ConditionExpression,
    'attribute_not_exists(#sessionKey)',
  );
  assert.deepEqual(captured.input.TransactItems?.[0].Put?.Item, {
    sessionKey: validKey,
    familyKey: validKey,
    ...record(),
    expiresAt: 120,
  });
  assert.equal(
    captured.input.TransactItems?.[1].ConditionCheck?.Key?.sessionKey,
    `revoked#${validKey}`,
  );
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
    if (command instanceof GetCommand) {
      return command.input.Key?.sessionKey === validKey
        ? { Item: sessionItem() }
        : {};
    }
    return {};
  });

  assert.equal(
    await store.update(validKey, record({ lastSeenAt: 100_000 })),
    true,
  );
  assert.ok(captured instanceof TransactWriteCommand);
  const update = captured.input.TransactItems?.[0].Update;
  assert.match(update?.ConditionExpression ?? '', /#absoluteExpiresAt > :now/);
  assert.match(update?.ConditionExpression ?? '', /#lastSeenAt > :idleCutoff/);
  assert.match(update?.ConditionExpression ?? '', /#lastSeenAt <= :newLastSeenAt/);
  assert.match(update?.ConditionExpression ?? '', /#familyKey = :familyKey/);
  assert.equal(update?.ExpressionAttributeValues?.[':expiresAt'], 130);
  assert.equal(captured.input.TransactItems?.[1].ConditionCheck?.Key?.sessionKey, `revoked#${validKey}`);
});

test('returns false when a conditional update loses a race', async () => {
  const conflict = Object.assign(new Error('transaction canceled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  });
  const store = makeStore(async (command) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.sessionKey === validKey
        ? { Item: sessionItem() }
        : {};
    }
    throw conflict;
  });

  assert.equal(
    await store.update(validKey, record({ lastSeenAt: 100_000 })),
    false,
  );
});

test('descendant updates check the root family revocation marker transactionally', async () => {
  const descendantKey = 'c'.repeat(64);
  let captured: DynamoCommand | undefined;
  const store = makeStore(async (command) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.sessionKey === descendantKey
        ? {
            Item: {
              ...sessionItem(descendantKey),
              familyKey: validKey,
              lastSeenAt: 100_000,
            },
          }
        : {};
    }
    captured = command;
    return {};
  });

  assert.equal(
    await store.update(descendantKey, record({ lastSeenAt: 100_000 })),
    true,
  );
  assert.ok(captured instanceof TransactWriteCommand);
  assert.equal(
    captured.input.TransactItems?.[1].ConditionCheck?.Key?.sessionKey,
    `revoked#${validKey}`,
  );
  assert.equal(
    captured.input.TransactItems?.[0].Update?.ExpressionAttributeValues?.[':familyKey'],
    validKey,
  );
});

test('rotates using one atomic transaction and conditions on the source version', async () => {
  const commands: DynamoCommand[] = [];
  const store = makeStore(async (command) => {
    commands.push(command);
    if (command instanceof GetCommand) {
      return command.input.Key?.sessionKey === validKey
        ? { Item: sessionItem() }
        : {};
    }
    return {};
  });

  assert.equal(
    await store.rotate(validKey, anotherKey, record({ lastSeenAt: 100_000 })),
    true,
  );
  assert.equal(commands.length, 3);
  assert.ok(commands[0] instanceof GetCommand);
  assert.equal(commands[0].input.ConsistentRead, true);
  assert.ok(commands[1] instanceof GetCommand);
  assert.ok(commands[2] instanceof TransactWriteCommand);
  const operations = commands[2].input.TransactItems;
  assert.equal(operations?.length, 3);
  assert.ok('Put' in operations![0]);
  assert.ok('Update' in operations![1]);
  assert.ok('ConditionCheck' in operations![2]);
  assert.equal(operations![0].Put?.Item?.familyKey, validKey);
  assert.equal(
    operations![0].Put?.ConditionExpression,
    'attribute_not_exists(#sessionKey)',
  );
  assert.match(operations![1].Update?.ConditionExpression ?? '', /#lastSeenAt = :expectedLastSeenAt/);
  assert.equal(operations![2].ConditionCheck?.Key?.sessionKey, `revoked#${validKey}`);
  assert.deepEqual(
    operations![1].Update?.ExpressionAttributeValues?.[':emptyData'],
    {},
  );
  assert.equal(
    operations![1].Update?.ExpressionAttributeValues?.[':absoluteExpiresAt'],
    260,
  );
});

test('returns false on a transaction conditional conflict and propagates non-conditional cancellation', async () => {
  const conditionalConflict = Object.assign(new Error('transaction canceled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  });
  let failTransaction = true;
  const store = makeStore(async (command) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.sessionKey === validKey
        ? { Item: sessionItem() }
        : {};
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

test('deletes one record without revoking its session family', async () => {
  const commands: DynamoCommand[] = [];
  const store = makeStore(async (command) => {
    commands.push(command);
    if (
      command instanceof GetCommand &&
      command.input.Key?.sessionKey === validKey
    ) {
      return { Item: sessionItem() };
    }
    return {};
  });
  await store.delete(validKey);
  assert.ok(commands[0] instanceof GetCommand);
  assert.ok(commands[1] instanceof DeleteCommand);
  assert.equal(commands[1].input.Key?.sessionKey, validKey);
  assert.equal(commands[1].input.ConditionExpression, '#familyKey = :familyKey');

  const unavailable = new Error('DynamoDB unavailable');
  await assert.rejects(
    makeStore(async (command) => {
      if (command instanceof GetCommand) return { Item: sessionItem() };
      throw unavailable;
    }).delete(validKey),
    unavailable,
  );
});

test('revokes the family with an atomic marker and retains it past millisecond expiry', async () => {
  const commands: DynamoCommand[] = [];
  const store = makeStore(async (command) => {
    commands.push(command);
    if (
      command instanceof GetCommand &&
      command.input.Key?.sessionKey === validKey
    ) {
      return {
        Item: sessionItem(validKey, record({ absoluteExpiresAt: 200_999 })),
      };
    }
    return {};
  });

  await store.revoke(validKey);
  assert.ok(commands[1] instanceof TransactWriteCommand);
  assert.equal(
    commands[1].input.TransactItems?.[0].Put?.Item?.sessionKey,
    `revoked#${validKey}`,
  );
  assert.equal(
    commands[1].input.TransactItems?.[1].Delete?.ConditionExpression,
    '#familyKey = :familyKey AND attribute_not_exists(#status) AND #absoluteExpiresAt > :now AND #lastSeenAt > :idleCutoff',
  );
  assert.equal(
    commands[1].input.TransactItems?.[0].Put?.ConditionExpression,
    'attribute_not_exists(#sessionKey)',
  );
  assert.equal(commands[1].input.TransactItems?.[0].Put?.Item?.expiresAt, 261);
  assert.ok(commands[1].input.TransactItems?.[0].Put?.Item?.expiresAt > 201);
});

test('old rotated-record cleanup preserves descendants and stale-cookie logout fails', async () => {
  const race = makeRaceStore();
  assert.equal(
    await race.store.rotate(validKey, anotherKey, record({ lastSeenAt: 100_000 })),
    true,
  );
  await race.store.delete(validKey);
  assert.equal(race.items.has(validKey), true);
  assert.deepEqual(await race.store.get(anotherKey), record({ lastSeenAt: 100_000 }));

  assert.equal(await race.store.revoke(validKey), false);
  assert.deepEqual(await race.store.get(anotherKey), record({ lastSeenAt: 100_000 }));
});

test('revocation marker invalidates a descendant even when created by a prior rotation', async () => {
  const descendantCommands: DynamoCommand[] = [];
  const descendantStore = makeStore(async (command) => {
    descendantCommands.push(command);
    if (
      command instanceof GetCommand &&
      command.input.Key?.sessionKey === anotherKey
    ) {
      return {
        Item: { ...sessionItem(anotherKey), familyKey: validKey },
      };
    }
    if (
      command instanceof GetCommand &&
      command.input.Key?.sessionKey === `revoked#${validKey}`
    ) {
      return { Item: { sessionKey: `revoked#${validKey}` } };
    }
    return {};
  });
  assert.equal(await descendantStore.get(anotherKey), null);
  assert.equal(descendantCommands.length, 2);
});

test('revocation transaction conflicts report whether the family is already revoked', async () => {
  const conditionalConflict = Object.assign(new Error('transaction canceled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  });
  const markerPresent = makeStore(async (command) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.sessionKey === validKey
        ? { Item: sessionItem() }
        : { Item: { sessionKey: `revoked#${validKey}` } };
    }
    throw conditionalConflict;
  });
  assert.equal(await markerPresent.revoke(validKey), true);

  const markerAbsent = makeStore(async (command) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.sessionKey === validKey
        ? { Item: sessionItem() }
        : {};
    }
    throw conditionalConflict;
  });
  assert.equal(await markerAbsent.revoke(validKey), false);

  const unavailable = new Error('DynamoDB unavailable');
  await assert.rejects(
    makeStore(async (command) => {
      if (command instanceof GetCommand) return { Item: sessionItem() };
      throw unavailable;
    }).revoke(validKey),
    unavailable,
  );
});

test('logout racing rotation fails closed in either transaction order', async (t) => {
  await t.test('logout wins before rotation', async () => {
    let releaseRotation!: () => void;
    let signalRotationWaiting!: () => void;
    const rotationGate = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const rotationWaiting = new Promise<void>((resolve) => {
      signalRotationWaiting = resolve;
    });
    const race = makeRaceStore(async (kind) => {
      if (kind === 'rotate') {
        signalRotationWaiting();
        await rotationGate;
      }
    });

    const rotation = race.store.rotate(
      validKey,
      anotherKey,
      record({ lastSeenAt: 100_000 }),
    );
    await rotationWaiting;
    assert.equal(await race.store.revoke(validKey), true);
    releaseRotation();
    assert.equal(await rotation, false);
    assert.equal(race.items.has(anotherKey), false);
    assert.equal(race.items.has(`revoked#${validKey}`), true);
  });

  await t.test('rotation wins before logout', async () => {
    let releaseLogout!: () => void;
    let signalLogoutWaiting!: () => void;
    const logoutGate = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    const logoutWaiting = new Promise<void>((resolve) => {
      signalLogoutWaiting = resolve;
    });
    const race = makeRaceStore(async (kind) => {
      if (kind === 'revoke') {
        signalLogoutWaiting();
        await logoutGate;
      }
    });

    const logout = race.store.revoke(validKey);
    await logoutWaiting;
    assert.equal(
      await race.store.rotate(validKey, anotherKey, record({ lastSeenAt: 100_000 })),
      true,
    );
    releaseLogout();
    assert.equal(await logout, false);
    assert.deepEqual(await race.store.get(anotherKey), record({ lastSeenAt: 100_000 }));
    assert.equal(race.items.has(`revoked#${validKey}`), false);
  });
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
