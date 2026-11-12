// The plugin became durable in 0.4.0: a form created in one process life has to
// accept its submission in the next one, while the token itself stays out of the
// database file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createHost, get, post } from './helpers.mjs';

const LABEL = 'OpenAI key';

function tokenOf(url) {
  return url.slice(url.lastIndexOf('/') + 1);
}

test('a pending form survives a restart and still accepts its value', async () => {
  const first = createHost();
  const created = await first.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  const database = first.database;
  first.close();

  // A second `apply()` on the same file is what a restart looks like from here.
  const second = createHost({ config: { database } });
  const page = await get(second, created.url);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /OpenAI key/);

  const posted = await post(second, created.url, { value: 'sk-restart-1', action: 'save' });
  assert.equal(posted.statusCode, 200);
  const result = await second.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'saved');
  assert.equal(result.length, 12);
  second.close();
});

test('the database holds no usable token and no submitted value', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  await post(host, created.url, { value: 'sk-never-on-disk', action: 'save' });

  const raw = readFileSync(host.database);
  assert.equal(raw.includes(Buffer.from(tokenOf(created.url), 'utf8')), false, 'the token must not be stored');
  assert.equal(raw.includes(Buffer.from('sk-never-on-disk', 'utf8')), false, 'the value must not be stored');

  // The hash is what was written instead.
  const db = new DatabaseSync(host.database);
  const rows = db.prepare('SELECT token_hash, status FROM form').all();
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'saved');
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  host.close();
});

test('expiry is evaluated from the clock, not from the previous process', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  const db = new DatabaseSync(host.database);
  db.prepare('UPDATE form SET expires_at = ? WHERE uuid = ?').run(Date.now() - 1000, created.uuid);
  db.close();

  const page = await get(host, created.url);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /expired|истекла/i);
  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'expired');
  host.close();
});

test('the note table and both stores share one file', async () => {
  const host = createHost();
  await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  const db = new DatabaseSync(host.database);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map((row) => row.name);
  db.close();
  for (const table of ['form', 'note', 'share', 'share_key', 'share_secret']) {
    assert.ok(tables.includes(table), `${table} is missing from ${join(host.dir, 'store.sqlite')}`);
  }
  host.close();
});

test('the page posts back to its own link, never to "undefined"', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  const path = new URL(created.url).pathname;
  const page = await get(host, created.url);
  assert.ok(page.body.includes(`action="${path}"`), 'the fresh page must carry its own action');

  // The record read from the database carries no token, which is the case the
  // browser hit when the action was taken from the row instead of the request.
  const database = host.database;
  const second = createHost({ config: { database } });
  const afterRestart = await get(second, created.url);
  assert.ok(afterRestart.body.includes(`action="${path}"`), 'the reloaded page must carry its own action');
  const posted = await post(second, created.url, { value: 'sk-from-the-page', action: 'save' });
  assert.equal(posted.statusCode, 200);
  second.close();
});

test('a file form page posts back to its own link too', async () => {
  const host = createHost();
  const created = await host.call('secret_create', {
    label: 'Upload the log',
    kind: 'file',
    upload: { dir: join(host.dir, 'inbox') },
  });
  const path = new URL(created.url).pathname;
  const page = await get(host, created.url);
  assert.ok(page.body.includes(`action="${path}"`));
  host.close();
});
