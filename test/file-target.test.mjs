import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHost, post } from './helpers.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'secret-form-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })));
  return directory;
}

async function submitFile(host, path, { ref, value, extra = {} }) {
  const created = await host.call('secret_create', {
    ref,
    label: 'Some secret',
    kind: 'single',
    save: { kind: 'file', path },
    ...extra,
  });
  const response = await post(host, created.url, { value, action: 'save' });
  return { created, response };
}

test('.env target replaces an existing key and appends a new one', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'app.env');
  await writeFile(file, 'EXISTING=keep-me\nTOKEN=old\n# a comment\n', 'utf8');
  const host = createHost();

  const replaced = await submitFile(host, file, { ref: 'TOKEN', value: 'new-value' });
  assert.equal(replaced.response.statusCode, 200);
  const appended = await submitFile(host, file, { ref: 'OPENAI_API_KEY', value: 'sk-abcd' });
  assert.equal(appended.response.statusCode, 200);

  const text = await readFile(file, 'utf8');
  assert.equal(text, 'EXISTING=keep-me\nTOKEN=new-value\n# a comment\nOPENAI_API_KEY=sk-abcd\n');
});

test('.env target quotes a value that would break the line', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'app.env');
  const host = createHost();
  const { response } = await submitFile(host, file, {
    ref: 'MULTILINE',
    value: 'first line\nsecond "quoted" line',
    extra: { kind: 'multi' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(await readFile(file, 'utf8'), 'MULTILINE="first line\\nsecond \\"quoted\\" line"\n');
});

test('.json target sets a nested dotted path and keeps unrelated keys', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'settings.json');
  await writeFile(file, `${JSON.stringify({ model: 'deepseek', provider: { name: 'deepseek', retries: 2 } }, null, 2)}\n`, 'utf8');
  const host = createHost();

  const { response } = await submitFile(host, file, { ref: 'provider.apiKey', value: 'sk-json' });
  assert.equal(response.statusCode, 200);

  const document = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(document, {
    model: 'deepseek',
    provider: { name: 'deepseek', retries: 2, apiKey: 'sk-json' },
  });
});

test('.json target creates the file and the nested objects it needs', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'nested', 'deeper', 'settings.json');
  const host = createHost();

  const { response } = await submitFile(host, file, { ref: 'a.b.c', value: 'deep' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: { b: { c: 'deep' } } });
});

test('.yaml target sets a nested path and keeps the spelling of other values', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'config.yaml');
  await writeFile(file, 'model: deepseek\nport: 8080\nprovider:\n  name: deepseek\n  retries: 2\n', 'utf8');
  const host = createHost();

  const { response } = await submitFile(host, file, { ref: 'provider.apiKey', value: 'sk-yaml' });
  assert.equal(response.statusCode, 200);

  assert.equal(
    await readFile(file, 'utf8'),
    'model: deepseek\nport: 8080\nprovider:\n  name: deepseek\n  retries: 2\n  apiKey: sk-yaml\n',
  );
});

test('.yml extension is read as YAML and an empty document starts one', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'config.yml');
  const host = createHost();

  const { response } = await submitFile(host, file, { ref: 'token', value: 'abc def' });
  assert.equal(response.statusCode, 200);
  assert.equal(await readFile(file, 'utf8'), 'token: "abc def"\n');
});

test('a written document is created with 0600 and its parent directories', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'private', 'deep', 'secrets.env');
  const host = createHost();

  const { response } = await submitFile(host, file, { ref: 'TOKEN', value: 'value' });
  assert.equal(response.statusCode, 200);
  const info = await stat(file);
  assert.equal(info.mode & 0o777, 0o600);
});

test('an unknown extension is rejected when the form is created', async (t) => {
  const directory = await workspace(t);
  const host = createHost();
  await assert.rejects(
    () => host.call('secret_create', {
      ref: 'TOKEN',
      label: 'Some secret',
      kind: 'single',
      save: { kind: 'file', path: join(directory, 'secrets.txt') },
    }),
    /must end in \.yaml, \.yml, \.json or \.env/,
  );
});

test('a yaml document this writer does not understand is refused, not rewritten', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'config.yaml');
  const original = 'services:\n  - name: web\n';
  await writeFile(file, original, 'utf8');
  const host = createHost();

  const { created, response } = await submitFile(host, file, { ref: 'token', value: 'abc' });
  assert.equal(response.statusCode, 500);
  assert.match(response.body, /not supported as a YAML target/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await host.call('secret_result', { uuid: created.uuid })).status, 'pending');
});

test('an unparseable json document is refused, not rewritten', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'settings.json');
  await writeFile(file, '{ not json', 'utf8');
  const host = createHost();

  const { response } = await submitFile(host, file, { ref: 'token', value: 'abc' });
  assert.equal(response.statusCode, 500);
  assert.match(response.body, /is not valid JSON/);
  assert.equal(await readFile(file, 'utf8'), '{ not json');
});

test('a ref that would reach a prototype is rejected', async (t) => {
  const directory = await workspace(t);
  const host = createHost();
  await assert.rejects(
    () => host.call('secret_create', {
      ref: '__proto__.polluted',
      label: 'Some secret',
      kind: 'single',
      save: { kind: 'file', path: join(directory, 'settings.json') },
    }),
    /names a prototype member/,
  );
});

test('a .env ref must be a variable name', async (t) => {
  const directory = await workspace(t);
  const host = createHost();
  await assert.rejects(
    () => host.call('secret_create', {
      ref: 'a.b',
      label: 'Some secret',
      kind: 'single',
      save: { kind: 'file', path: join(directory, 'app.env') },
    }),
    /must be a variable name/,
  );
});

test('an empty value is written to a file target', async (t) => {
  const directory = await workspace(t);
  const file = join(directory, 'app.env');
  const host = createHost();

  const created = await host.call('secret_create', {
    ref: 'EMPTY_KEY',
    label: 'Some secret',
    kind: 'single',
    allowEmpty: true,
    save: { kind: 'file', path: file },
  });
  const response = await post(host, created.url, { value: '', action: 'save' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Nothing stored/);
  assert.equal(await readFile(file, 'utf8'), 'EMPTY_KEY=\n');
  assert.equal((await host.call('secret_result', { uuid: created.uuid })).status, 'empty');
});
