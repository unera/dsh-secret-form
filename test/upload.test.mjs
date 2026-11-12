// kind=file: the human uploads a file, the model learns the facts and never the
// bytes. The target directory is always the one the model named.
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createHost, get, postMultipart } from './helpers.mjs';

async function fileForm(host, extra = {}) {
  const dir = join(host.dir, 'inbox');
  const created = await host.call('secret_create', {
    label: 'Upload the log',
    kind: 'file',
    upload: { dir },
    ...extra,
  });
  return { created, dir };
}

test('a file form asks for a file and stores it under the requested directory', async () => {
  const host = createHost();
  const { created, dir } = await fileForm(host);

  const page = await get(host, created.url);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /type="file"/);
  assert.match(page.body, /enctype="multipart\/form-data"/);

  const posted = await postMultipart(host, created.url, {
    fields: { action: 'save', lang: 'en' },
    files: [{ name: 'file', filename: 'app.log', data: 'line one\nline two\n' }],
  });
  assert.equal(posted.statusCode, 200);
  assert.match(posted.body, /File received/);

  const stored = join(dir, 'app.log');
  assert.equal(await readFile(stored, 'utf8'), 'line one\nline two\n');
  const mode = (await stat(stored)).mode & 0o777;
  assert.equal(mode, 0o600);

  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'saved');
  assert.equal(result.fileName, 'app.log');
  assert.equal(result.size, 18);
  assert.equal(result.path, stored);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  host.close();
});

test('upload.name wins over the name the browser sent, and a path in it is stripped', async () => {
  const host = createHost();
  const { created, dir } = await fileForm(host, { upload: { dir: join(host.dir, 'inbox'), name: '../escape.txt' } });

  const posted = await postMultipart(host, created.url, {
    files: [{ name: 'file', filename: '../../etc/passwd', data: 'not even close' }],
  });
  assert.equal(posted.statusCode, 200);

  const stored = join(dir, 'escape.txt');
  assert.equal(await readFile(stored, 'utf8'), 'not even close');
  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.path, stored);
  host.close();
});

test('a submission without a file part reports the missing file and stays pending', async () => {
  const host = createHost();
  const { created } = await fileForm(host);

  const posted = await postMultipart(host, created.url, { fields: { action: 'save' } });
  assert.equal(posted.statusCode, 422);
  assert.match(posted.body, /No file was received/);

  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'pending');
  host.close();
});

test('a refused write leaves the file form pending', async () => {
  const host = createHost();
  const { created, dir } = await fileForm(host);
  // A directory where the file has to go: the atomic write cannot rename over it.
  await mkdir(join(dir, 'blocked.txt'), { recursive: true });

  const posted = await postMultipart(host, created.url, {
    files: [{ name: 'file', filename: 'blocked.txt', data: 'x' }],
  });
  assert.equal(posted.statusCode, 500);
  const result = await host.call('secret_result', { uuid: created.uuid });
  assert.equal(result.status, 'pending');
  host.close();
});

test('a body over the configured limit is refused with 413', async () => {
  const host = createHost({ config: { maxUploadBytes: 4096 } });
  const { created } = await fileForm(host);
  const posted = await postMultipart(host, created.url, {
    files: [{ name: 'file', filename: 'big.bin', data: Buffer.alloc(8192, 7) }],
  });
  assert.equal(posted.statusCode, 413);
  host.close();
});

test('a file form refuses a relative directory at creation time', async () => {
  const host = createHost();
  await assert.rejects(
    host.call('secret_create', { label: 'Upload the log', kind: 'file', upload: { dir: 'relative/dir' } }),
    /absolute path/,
  );
  host.close();
});

test('the uploaded file is never echoed into the answer', async () => {
  const host = createHost();
  const { created } = await fileForm(host);
  const secret = 'TOP-SECRET-FILE-BYTES';
  await postMultipart(host, created.url, {
    files: [{ name: 'file', filename: 'keys.txt', data: secret }],
  });
  const result = JSON.stringify(await host.call('secret_result', { uuid: created.uuid }));
  assert.equal(result.includes(secret), false);
  const listed = JSON.stringify(await host.call('secret_list'));
  assert.equal(listed.includes(secret), false);
  host.close();
});

test('a file target keeps the form pending after a restart until it is filled', async () => {
  const host = createHost();
  const { created } = await fileForm(host);
  const database = host.database;
  const dir = join(host.dir, 'inbox');
  host.close();
  const second = createHost({ config: { database } });
  const posted = await postMultipart(second, created.url, {
    fields: { action: 'save' },
    files: [{ name: 'file', filename: 'late.txt', data: 'after restart' }],
  });
  assert.equal(posted.statusCode, 200);
  assert.equal(await readFile(join(dir, 'late.txt'), 'utf8'), 'after restart');
  second.close();
});
