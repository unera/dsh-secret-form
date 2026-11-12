// A form is filled in by a human minutes later, so the session that asked is
// woken with a note. The note is placed through the schedule service — the same
// route the graceful-restart plugin uses — and it survives a restart.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createHost, createSchedule, post, postMultipart } from './helpers.mjs';

const LABEL = 'OpenAI key';

async function waitFor(check, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => {
      const timer = setTimeout(done, 10);
      timer.unref?.();
    });
  }
  throw new Error('the condition did not become true in time');
}

function pendingNotes(host) {
  const db = new DatabaseSync(host.database);
  const notes = db.prepare('SELECT kind, session_id, title, prompt FROM note').all()
    .map((row) => ({ ...row }));
  db.close();
  return notes;
}

test('filling in a form wakes the session that created it', async () => {
  const schedule = createSchedule();
  const host = createHost({ schedule });
  const created = await host.callAs('session-1', 'secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  await post(host, created.url, { value: 'sk-abc', action: 'save' });

  await waitFor(() => schedule.calls.length === 1);
  const [note] = schedule.calls;
  assert.equal(note.sessionId, 'session-1');
  assert.equal(note.request.after_seconds, 1);
  assert.equal(note.request.title, 'Secret received');
  assert.ok(note.request.prompt.includes(created.uuid));
  assert.ok(note.request.prompt.includes('credential store'));
  assert.equal(note.request.prompt.includes('sk-abc'), false);
  assert.deepEqual(pendingNotes(host), []);
  host.close();
});

test('notify=false leaves the session alone', async () => {
  const schedule = createSchedule();
  const host = createHost({ schedule });
  const created = await host.callAs('session-1', 'secret_create', {
    ref: 'OPENAI_API_KEY',
    label: LABEL,
    kind: 'single',
    notify: false,
  });
  await post(host, created.url, { value: 'sk-abc', action: 'save' });
  assert.deepEqual(schedule.calls, []);
  host.close();
});

test('an upload and a cancelled form each produce their own note', async () => {
  const schedule = createSchedule();
  const host = createHost({ schedule });
  const upload = await host.callAs('session-1', 'secret_create', {
    label: 'Upload the log',
    kind: 'file',
    upload: { dir: join(host.dir, 'inbox') },
  });
  await postMultipart(host, upload.url, {
    files: [{ name: 'file', filename: 'app.log', data: 'hello' }],
  });
  await waitFor(() => schedule.calls.length === 1);
  assert.equal(schedule.calls[0].request.title, 'File received');
  assert.ok(schedule.calls[0].request.prompt.includes('app.log'));
  assert.ok(schedule.calls[0].request.prompt.includes(join(host.dir, 'inbox', 'app.log')));

  const form = await host.callAs('session-1', 'secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  await post(host, form.url, { action: 'cancel' });
  await waitFor(() => schedule.calls.length === 2);
  assert.equal(schedule.calls[1].request.title, 'Form cancelled');
  host.close();
});

test('a collected secret wakes the session with its own note', async () => {
  const schedule = createSchedule();
  const host = createHost({ schedule });
  const file = join(host.dir, 'password.txt');
  await writeFile(file, 'hunter2');
  const share = await host.callAs('session-2', 'secret_share', { label: 'Router password', file });
  await post(host, share.url, { action: 'reveal' });

  await waitFor(() => schedule.calls.length === 1);
  assert.equal(schedule.calls[0].sessionId, 'session-2');
  assert.equal(schedule.calls[0].request.title, 'Secret collected');
  assert.ok(schedule.calls[0].request.prompt.includes(share.uuid));
  assert.equal(schedule.calls[0].request.prompt.includes('hunter2'), false);
  host.close();
});

test('the note is kept in the database until a schedule service can take it', async () => {
  // No schedule service at mount: the note has to wait instead of being lost.
  const first = createHost();
  const created = await first.callAs('session-1', 'secret_create', { ref: 'OPENAI_API_KEY', label: LABEL, kind: 'single' });
  await post(first, created.url, { value: 'sk-abc', action: 'save' });
  await waitFor(() => pendingNotes(first).length === 1);
  assert.equal(pendingNotes(first)[0].session_id, 'session-1');
  const database = first.database;
  first.close();

  const schedule = createSchedule();
  const second = createHost({ config: { database }, schedule });
  await waitFor(() => schedule.calls.length === 1);
  assert.equal(schedule.calls[0].sessionId, 'session-1');
  await waitFor(() => pendingNotes(second).length === 0);
  second.close();
});

test('the note follows the configured language', async () => {
  const schedule = createSchedule();
  const host = createHost({ schedule, config: { language: 'ru', defaultLocale: 'ru' } });
  const created = await host.callAs('session-1', 'secret_create', { ref: 'OPENAI_API_KEY', label: 'Ключ OpenAI', kind: 'single' });
  await post(host, created.url, { value: 'sk-abc', action: 'save' });
  await waitFor(() => schedule.calls.length === 1);
  assert.equal(schedule.calls[0].request.title, 'Секрет получен');
  assert.ok(schedule.calls[0].request.prompt.includes('Ключ OpenAI'));
  host.close();
});
