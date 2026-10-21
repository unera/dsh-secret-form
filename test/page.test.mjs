import assert from 'node:assert/strict';
import test from 'node:test';

import { createHost, get, post } from './helpers.mjs';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

test('the page escapes a label containing markup', async () => {
  const host = createHost();
  const created = await host.call('secret_create', {
    ref: 'OPENAI_API_KEY',
    label: 'Paste <script>alert(1)</script> key',
    kind: 'single',
  });
  const page = await get(host, created.url);
  assert.equal(page.statusCode, 200);
  assert.equal(page.body.includes('<script>alert(1)</script>'), false);
  assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('the page escapes a description containing markup', async () => {
  const host = createHost();
  const created = await host.call('secret_create', {
    ref: 'OPENAI_API_KEY',
    label: 'OpenAI key',
    kind: 'single',
    description: 'Find it at <b>platform.example</b>',
  });
  const page = await get(host, created.url);
  assert.equal(page.body.includes('<b>platform.example</b>'), false);
  assert.match(page.body, /&lt;b&gt;platform\.example&lt;\/b&gt;/);
});

test('both responses carry the security headers and a strict policy', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });

  for (const response of [await get(host, created.url), await post(host, created.url, { action: 'cancel' })]) {
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(response.headers['Content-Security-Policy'], CSP);
    assert.match(response.headers['Content-Type'], /^text\/html; charset=utf-8$/);
  }
});

test('the page is self-contained, mobile-first and theme aware', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const page = await get(host, created.url);
  assert.match(page.body, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(page.body, /max-width: 420px/);
  assert.match(page.body, /prefers-color-scheme: dark/);
  assert.match(page.body, /font-size: 16px/);
  assert.equal(/<(?:script|link)[^>]+(?:src|href)=/.test(page.body), false);
});

test('a single form renders a password field with a reveal toggle', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const page = await get(host, created.url);
  assert.match(page.body, /<input id="value" name="value" type="password"/);
  assert.match(page.body, /id="reveal"/);
  assert.equal(page.body.includes('<textarea'), false);
  assert.match(page.body, /<button class="save" type="submit" name="action" value="save">Save<\/button>/);
  assert.match(page.body, /name="action" value="cancel"/);
});

test('a multi form renders a monospace textarea', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'DEPLOY_KEY', label: 'Deploy key', kind: 'multi' });
  const page = await get(host, created.url);
  assert.match(page.body, /<textarea id="value" name="value"/);
  assert.match(page.body, /font-family: ui-monospace/);
  assert.equal(page.body.includes('type="password"'), false);
});

test('an unknown token answers 404 with its own wording', async () => {
  const host = createHost();
  const response = await get(host, 'http://127.0.0.1:3080/secret/not-a-real-token');
  assert.equal(response.statusCode, 404);
  assert.match(response.body, /does not match any open form/);
});

test('used, cancelled and expired links have distinct wording', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const host = createHost();
  const used = await host.call('secret_create', { ref: 'A_KEY', label: 'First form', kind: 'single' });
  await post(host, used.url, { value: 'sk-abc', action: 'save' });
  const usedPage = await get(host, used.url);

  const cancelled = await host.call('secret_create', { ref: 'B_KEY', label: 'Second form', kind: 'single' });
  await host.call('secret_cancel', { uuid: cancelled.uuid });
  const cancelledPage = await get(host, cancelled.url);

  const expired = await host.call('secret_create', {
    ref: 'C_KEY',
    label: 'Third form',
    kind: 'single',
    ttlSeconds: 30,
  });
  t.mock.timers.tick(31_000);
  const expiredPage = await get(host, expired.url);

  assert.match(usedPage.body, /already been used/);
  assert.match(cancelledPage.body, /Cancelled/);
  assert.match(expiredPage.body, /expired/);
  assert.notEqual(usedPage.body, cancelledPage.body);
  assert.notEqual(usedPage.body, expiredPage.body);
  assert.notEqual(cancelledPage.body, expiredPage.body);
});

test('only GET, HEAD and POST reach a form', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const response = await get(host, created.url, 'PUT');
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'GET, HEAD, POST');
});

test('a form post without the form content type is refused', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const response = await get(host, created.url, 'POST');
  assert.equal(response.statusCode, 415);
});
