// secret_share: the model hands a secret over, the human presses a button that
// works exactly once, and nothing sealed survives the reveal.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createHost, get, post } from './helpers.mjs';

const LABEL = 'Router password';

function sealedRows(host) {
  const db = new DatabaseSync(host.database);
  const secret = db.prepare('SELECT COUNT(*) AS n FROM share_secret').get().n;
  const key = db.prepare('SELECT COUNT(*) AS n FROM share_key').get().n;
  const share = db.prepare('SELECT status FROM share').all().map((row) => ({ status: row.status }));
  db.close();
  return { secret, key, share };
}

async function shareFile(host, contents = 'hunter2') {
  const file = join(host.dir, 'secret.txt');
  await writeFile(file, contents);
  return host.call('secret_share', { label: LABEL, file });
}

test('a share page reveals the secret once and then stops working', async () => {
  const host = createHost();
  const created = await shareFile(host);
  assert.match(created.url, /\/secret\/[A-Za-z0-9_-]+$/);
  assert.equal(created.length, 7);

  const page = await get(host, created.url);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Show the secret/);
  assert.equal(page.body.includes('hunter2'), false, 'the page must not carry the value');

  const revealed = await post(host, created.url, { action: 'reveal' });
  assert.equal(revealed.statusCode, 200);
  assert.match(revealed.body, /hunter2/);
  assert.match(revealed.body, /id="copy"/);
  assert.equal(revealed.headers['Cache-Control'], 'no-store');

  // The link is burnt, and nothing sealed is left to read.
  const again = await post(host, created.url, { action: 'reveal' });
  assert.equal(again.statusCode, 410);
  const reopened = await get(host, created.url);
  assert.equal(reopened.statusCode, 200);
  assert.match(reopened.body, /already shown/);
  assert.deepEqual(sealedRows(host), { secret: 0, key: 0, share: [{ status: 'revealed' }] });

  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.type, 'share');
  assert.equal(result.status, 'revealed');
  assert.equal(JSON.stringify(result).includes('hunter2'), false);
  host.close();
});

test('the link can be opened many times before the button is pressed', async () => {
  const host = createHost();
  const created = await shareFile(host);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = await get(host, created.url);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Show the secret/);
  }
  const pending = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.views, 3);
  host.close();
});

test('a post that is not the reveal button does not burn the link', async () => {
  const host = createHost();
  const created = await shareFile(host);
  const wrong = await post(host, created.url, { action: 'save' });
  assert.equal(wrong.statusCode, 400);
  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'pending');
  host.close();
});

test('a share can take its value from a credential reference', async () => {
  const host = createHost({
    credentials: {
      async set() {},
      async resolve(ref) {
        return ref === 'ROUTER_PASSWORD' ? { value: 'from-the-store', source: 'file' } : undefined;
      },
    },
  });
  const created = await host.call('secret_share', { label: LABEL, credential: 'ROUTER_PASSWORD' });
  assert.equal(created.source, 'credential');
  const revealed = await post(host, created.url, { action: 'reveal' });
  assert.match(revealed.body, /from-the-store/);
  host.close();
});

test('a summary names exactly one source', async () => {
  const host = createHost();
  await assert.rejects(host.call('secret_share', { label: LABEL }), /exactly one source/);
  await assert.rejects(
    host.call('secret_share', { label: LABEL, file: '/etc/hostname', credential: 'TOKEN' }),
    /exactly one source/,
  );
  host.close();
});

test('a binary or oversized file is refused instead of truncated', async () => {
  const host = createHost();
  const binary = join(host.dir, 'blob.bin');
  await writeFile(binary, Buffer.from([0x00, 0x01, 0x02]));
  await assert.rejects(host.call('secret_share', { label: LABEL, file: binary }), /binary/);

  const big = join(host.dir, 'big.txt');
  await writeFile(big, 'x'.repeat(300 * 1024));
  await assert.rejects(host.call('secret_share', { label: LABEL, file: big }), /at most/);
  host.close();
});

test('an expired share deletes its sealed value and shows the expiry notice', async () => {
  const host = createHost();
  const created = await shareFile(host);
  const db = new DatabaseSync(host.database);
  db.prepare('UPDATE share SET expires_at = ? WHERE uuid = ?').run(Date.now() - 1000, created.uuid);
  db.close();

  const page = await get(host, created.url);
  assert.match(page.body, /expired/);
  const posted = await post(host, created.url, { action: 'reveal' });
  assert.equal(posted.statusCode, 410);
  assert.equal(posted.body.includes('hunter2'), false);
  const rows = sealedRows(host);
  assert.equal(rows.secret, 0);
  assert.equal(rows.key, 0);
  assert.equal(rows.share[0].status, 'expired');
  host.close();
});

test('secret_cancel deletes the sealed value of a pending share', async () => {
  const host = createHost();
  const created = await shareFile(host);
  const cancelled = await host.call('secret_cancel', { uuid: created.uuid });
  assert.equal(cancelled.status, 'cancelled');
  const rows = sealedRows(host);
  assert.equal(rows.secret, 0);
  assert.equal(rows.key, 0);
  const posted = await post(host, created.url, { action: 'reveal' });
  assert.equal(posted.statusCode, 410);
  host.close();
});

test('secret_list reports both kinds with their own type', async () => {
  const host = createHost();
  await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  await shareFile(host);
  const list = await host.call('secret_list');
  assert.deepEqual(list.map((row) => row.type), ['form', 'share']);
  assert.equal(list[0].status, 'pending');
  assert.equal(list[1].status, 'pending');
  assert.equal(JSON.stringify(list).includes('hunter2'), false);
  host.close();
});

test('a share survives a restart and can still be revealed once', async () => {
  const host = createHost();
  const created = await shareFile(host, 'restart-me');
  const database = host.database;
  host.close();

  const second = createHost({ config: { database } });
  const revealed = await post(second, created.url, { action: 'reveal' });
  assert.equal(revealed.statusCode, 200);
  assert.match(revealed.body, /restart-me/);
  const again = await post(second, created.url, { action: 'reveal' });
  assert.equal(again.statusCode, 410);
  second.close();
});

test('the reveal page posts back to its own link', async () => {
  const host = createHost();
  const created = await shareFile(host);
  const path = new URL(created.url).pathname;
  const page = await get(host, created.url);
  assert.ok(page.body.includes(`action="${path}"`), 'the button must post to the link that was opened');
  host.close();
});
