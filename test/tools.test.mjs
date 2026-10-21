import assert from 'node:assert/strict';
import test from 'node:test';

import { createHost, get, post } from './helpers.mjs';

const LABEL = 'OpenAI key';

test('a created form returns an absolute url and lists as pending', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  assert.match(created.url, /^http:\/\/127\.0\.0\.1:3080\/secret\/[A-Za-z0-9_-]+$/);
  assert.match(created.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(typeof created.expiresAt, 'string');

  const list = await host.call('secret_list');
  assert.equal(list.length, 1);
  assert.equal(list[0].uuid, created.uuid);
  assert.equal(list[0].ref, 'OPENAI_API_KEY');
  assert.equal(list[0].label, LABEL);
  assert.equal(list[0].status, 'pending');
  assert.ok(list[0].createdAt.endsWith('Z'));
  assert.ok(list[0].expiresAt.endsWith('Z'));
});

test('submitting stores the value in the credential store and reports saved', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });

  const page = await post(host, created.url, { value: '  sk-test-123\n ', action: 'save' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Saved/);

  assert.deepEqual(host.writes, [['OPENAI_API_KEY', 'sk-test-123']]);
  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'saved');
  assert.equal(result.length, 11);
  assert.equal(result.lines, 1);
  assert.equal(result.trimmed, true);
  assert.equal(result.ref, 'OPENAI_API_KEY');
});

test('a multi-line value keeps its internal newlines and counts lines', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'DEPLOY_KEY', label: 'Deploy key', kind: 'multi' });
  await post(host, created.url, { value: 'line one\nline two\n\nline four\n', action: 'save' });

  const [written] = host.writes;
  assert.deepEqual(written, ['DEPLOY_KEY', 'line one\nline two\n\nline four']);
  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.lines, 4);
  assert.equal(result.trimmed, true);
});

test('no tool result ever contains the submitted value', async () => {
  const secret = 'sk-live-VERYSECRETVALUE-0123456789';
  const host = createHost();
  const created = await host.call('secret_create', {
    ref: 'OPENAI_API_KEY',
    label: LABEL,
    kind: 'single',
    expect: '^sk-live-',
    data: { ticket: 'A-17' },
  });
  await post(host, created.url, { value: secret, action: 'save' });

  const results = [
    created,
    await host.call('secret_list'),
    await host.call('secret_result', { uuid: created.uuid }),
    await host.call('secret_cancel', { uuid: created.uuid }),
  ];
  for (const result of results) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('a second submit on the same token reports the link as used and writes nothing', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  await post(host, created.url, { value: 'sk-first', action: 'save' });

  const second = await post(host, created.url, { value: 'sk-second', action: 'save' });
  assert.equal(second.statusCode, 410);
  assert.match(second.body, /already been used/);
  assert.deepEqual(host.writes, [['OPENAI_API_KEY', 'sk-first']]);
});

test('cancelling from the page reports cancelled and closes the token', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });

  const cancelled = await post(host, created.url, { value: '', action: 'cancel' });
  assert.equal(cancelled.statusCode, 200);
  assert.match(cancelled.body, /Cancelled/);
  assert.equal((await host.call('secret_result', { uuid: created.uuid })).status, 'cancelled');

  const late = await post(host, created.url, { value: 'sk-late', action: 'save' });
  assert.equal(late.statusCode, 410);
  assert.match(late.body, /Cancelled/);
  assert.deepEqual(host.writes, []);
});

test('secret_cancel cancels a pending form and leaves a finished one unchanged', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });

  const first = await host.call('secret_cancel', { uuid: created.uuid });
  assert.equal(first.status, 'cancelled');
  const second = await host.call('secret_cancel', { uuid: created.uuid });
  assert.equal(second.status, 'cancelled');
  assert.deepEqual(host.writes, []);
});

test('an expired form reports expired and its link says so', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const host = createHost();
  const created = await host.call('secret_create', {
    ref: 'OPENAI_API_KEY',
    label: LABEL,
    kind: 'single',
    ttlSeconds: 30,
  });

  t.mock.timers.tick(29_000);
  assert.equal((await host.call('secret_result', { uuid: created.uuid })).status, 'pending');
  t.mock.timers.tick(2_000);

  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'expired');
  const page = await get(host, created.url);
  assert.match(page.body, /expired/);
  const late = await post(host, created.url, { value: 'sk-late', action: 'save' });
  assert.equal(late.statusCode, 410);
  assert.deepEqual(host.writes, []);
});

test('ttlSeconds is clamped into 30..3600 seconds', async () => {
  const host = createHost({ config: { defaultTtlSeconds: 900 } });
  const short = await host.call('secret_create', { ref: 'A_KEY', label: 'Short one', kind: 'single', ttlSeconds: 1 });
  const long = await host.call('secret_create', { ref: 'B_KEY', label: 'Long one', kind: 'single', ttlSeconds: 99_999 });
  const byDefault = await host.call('secret_create', { ref: 'C_KEY', label: 'Default ttl', kind: 'single' });

  const list = await host.call('secret_list');
  const spanOf = (uuid) => {
    const row = list.find((entry) => entry.uuid === uuid);
    return Date.parse(row.expiresAt) - Date.parse(row.createdAt);
  };
  assert.equal(spanOf(short.uuid), 30_000);
  assert.equal(spanOf(long.uuid), 3_600_000);
  assert.equal(spanOf(byDefault.uuid), 900_000);
});

test('waitSeconds returns as soon as the form finishes', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  const started = Date.now();
  const waiting = host.call('secret_result', { uuid: created.uuid, waitSeconds: 5 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await post(host, created.url, { value: 'sk-fast', action: 'save' });
  const result = await waiting;
  assert.equal(result.status, 'saved');
  assert.ok(Date.now() - started < 3_000, `waited ${Date.now() - started}ms`);
});

test('waitSeconds gives up at the deadline while the form stays pending', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  const started = Date.now();
  const result = await host.call('secret_result', { uuid: created.uuid, waitSeconds: 1 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'pending');
  assert.ok(elapsed >= 950, `returned after ${elapsed}ms`);
  assert.ok(elapsed < 3_000, `returned after ${elapsed}ms`);
});

test('an empty submit is refused when allowEmpty is false', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  const response = await post(host, created.url, { value: '   \n ', action: 'save' });
  assert.equal(response.statusCode, 422);
  assert.match(response.body, /cannot be empty/);
  assert.equal((await host.call('secret_result', { uuid: created.uuid })).status, 'pending');
  assert.deepEqual(host.writes, []);
});

test('an empty submit is accepted as empty when allowEmpty is true', async () => {
  const host = createHost();
  const created = await host.call('secret_create', {
    ref: 'OPENAI_API_KEY',
    label: LABEL,
    kind: 'single',
    allowEmpty: true,
  });
  const response = await post(host, created.url, { value: '', action: 'save' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Nothing stored/);
  assert.deepEqual(host.writes, []);
  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'empty');
  assert.equal(result.length, 0);
  assert.equal(result.lines, 0);
});

test('expect reports matchesExpect and never blocks the save', async () => {
  const host = createHost();
  const matching = await host.call('secret_create', {
    ref: 'OPENAI_API_KEY',
    label: LABEL,
    kind: 'single',
    expect: '^sk-[a-z]+$',
  });
  await post(host, matching.url, { value: 'sk-abc', action: 'save' });
  assert.equal((await host.call('secret_result', { uuid: matching.uuid })).matchesExpect, true);

  const mismatching = await host.call('secret_create', {
    ref: 'OPENAI_API_KEY',
    label: LABEL,
    kind: 'single',
    expect: '^sk-[a-z]+$',
  });
  const page = await post(host, mismatching.url, { value: 'definitely-wrong', action: 'save' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /did not match the expected format/);
  const result = await host.call('secret_result', { uuid: mismatching.uuid });
  assert.equal(result.status, 'saved');
  assert.equal(result.matchesExpect, false);
  assert.equal(host.writes.length, 2);
});

test('data round-trips through create, list and result', async () => {
  const host = createHost();
  const data = { ticket: 'A-17', nested: { attempt: 2 } };
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single', data });
  assert.deepEqual(created.data, data);

  const [row] = await host.call('secret_list');
  assert.deepEqual(row.data, data);
  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.deepEqual(result.data, data);
});

test('data is refused when it does not fit in 1 KB', async () => {
  const host = createHost();
  await assert.rejects(
    () => host.call('secret_create', {
      ref: 'OPENAI_API_KEY',
      label: LABEL,
      kind: 'single',
      data: { blob: 'x'.repeat(2048) },
    }),
    /at most 1024 bytes/,
  );
});

test('an unknown uuid is refused by secret_result and secret_cancel', async () => {
  const host = createHost();
  await assert.rejects(() => host.call('secret_result', { uuid: 'missing' }), /unknown secret form/);
  await assert.rejects(() => host.call('secret_cancel', { uuid: 'missing' }), /unknown secret form/);
});

test('a failed write leaves the form pending and reports the reason', async () => {
  const host = createHost({
    credentials: {
      async set() {
        throw new Error('credentials-local: disk is read-only');
      },
    },
  });
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  const response = await post(host, created.url, { value: 'sk-abc', action: 'save' });
  assert.equal(response.statusCode, 500);
  assert.match(response.body, /disk is read-only/);
  assert.equal((await host.call('secret_result', { uuid: created.uuid })).status, 'pending');
});

test('a configured public URL wins over the loopback listener origin', async () => {
  const host = createHost({ config: { publicUrl: 'https://dsh.example.org/' } });
  const created = await host.call('secret_create', { ref: 'SMOKE_KEY', label: 'Smoke key', kind: 'single' });
  assert.match(created.url, /^https:\/\/dsh\.example\.org\/secret\/[A-Za-z0-9_-]+$/,
    'the link must be reachable from a phone, not from loopback');
});
