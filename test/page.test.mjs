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

test('a single form renders a one-row textarea instead of a password input', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const page = await get(host, created.url);
  // Firefox offers its password manager for input[type=password], and for text
  // inputs it reads as login fields; a textarea is never treated as one.
  assert.equal(page.body.includes('type="password"'), false, 'no field may attract the password manager');
  assert.match(page.body, /<textarea id="value" name="value" rows="1" class="single masked"/);
  assert.match(page.body, /id="mask"/);
  assert.match(page.body, /id="reveal"/);
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

test('the Accept-Language header picks the page language', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const page = await get(host, created.url, { headers: { 'accept-language': 'de' } });
  assert.match(page.body, /<html lang="de">/);
  assert.match(page.body, /<button class="save" type="submit" name="action" value="save">Speichern<\/button>/);
  assert.match(page.body, /<button class="cancel" type="submit" name="action" value="cancel" formnovalidate>Abbrechen<\/button>/);
  // The reveal toggle is read from the markup and rewritten from the inline
  // script, so both copies have to be translated.
  assert.match(page.body, /id="reveal" aria-pressed="false">Anzeigen<\/button>/);
  assert.match(page.body, /hidden \? "Anzeigen" : "Ausblenden"/);

  const saved = await post(host, created.url, { value: 'sk-abc', action: 'save', lang: 'de' });
  assert.match(saved.body, /<title>Gespeichert<\/title>/);

  // The second visit is the used page, also in German.
  const used = await get(host, created.url, { headers: { 'accept-language': 'de' } });
  assert.match(used.body, /<h1>Link schon benutzt<\/h1>/);
});

test('q-values rank the languages and an unsupported one falls back to English', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const ranked = await get(host, created.url, { headers: { 'accept-language': 'fr;q=0.4, de-AT;q=0.9, en;q=0.5' } });
  assert.match(ranked.body, /<html lang="de">/);
  assert.match(ranked.body, />Speichern<\/button>/);

  const unsupported = await get(host, created.url, { headers: { 'accept-language': 'fi-FI, sv;q=0.8' } });
  assert.match(unsupported.body, /<html lang="en">/);
  assert.match(unsupported.body, />Save<\/button>/);
});

test('an explicit lang query parameter wins over the header', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const page = await get(host, `${created.url}?lang=zh-CN`, { headers: { 'accept-language': 'de' } });
  assert.match(page.body, /<html lang="zh">/);
  assert.match(page.body, />保存<\/button>/);
  assert.match(page.body, /<input type="hidden" name="lang" value="zh">/);
});

test('the hidden lang field keeps the outcome page in the same language', async () => {
  const host = createHost();
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const page = await get(host, `${created.url}?lang=de`);
  assert.match(page.body, /<input type="hidden" name="lang" value="de">/);

  // The browser's next request claims English, the form says German: the form wins.
  const outcome = await post(
    host,
    created.url,
    { value: 'sk-abc', action: 'save', lang: 'de' },
    { headers: { 'accept-language': 'en' } },
  );
  assert.equal(outcome.statusCode, 200);
  assert.match(outcome.body, /<html lang="de">/);
  assert.match(outcome.body, /<h1>Gespeichert<\/h1>/);
});

test('defaultLocale applies when the request names no language', async () => {
  const host = createHost({ config: { defaultLocale: 'ru' } });
  const created = await host.call('secret_create', { ref: 'OPENAI_API_KEY', label: 'OpenAI key', kind: 'single' });
  const page = await get(host, created.url);
  assert.match(page.body, /<html lang="ru">/);
  assert.match(page.body, />Сохранить<\/button>/);
});

test('an unsupported defaultLocale is refused at mount time', () => {
  assert.throws(() => createHost({ config: { defaultLocale: 'klingon' } }), /defaultLocale must be one of/);
});

test('Russian renders all three plural forms of the remaining time', async () => {
  const host = createHost();
  const render = async (ttlSeconds) => {
    const created = await host.call('secret_create', {
      ref: 'A_KEY',
      label: 'Test form',
      kind: 'single',
      ttlSeconds,
    });
    const page = await get(host, `${created.url}?lang=ru`);
    return page.body;
  };
  assert.match(await render(30), /меньше чем через минуту/);
  assert.match(await render(60), /через 1 минуту/);
  assert.match(await render(180), /через 3 минуты/);
  assert.match(await render(300), /через 5 минут/);
});

test('an expect pattern cannot break out of the inline script', async () => {
  const host = createHost();
  const created = await host.call('secret_create', {
    ref: 'OPENAI_API_KEY',
    label: 'OpenAI key',
    kind: 'single',
    expect: '^sk-.*</script><b>alert(1)</b>',
  });
  const page = await get(host, created.url);
  assert.equal(page.body.includes('</script><b>'), false);
  assert.equal(page.body.includes('<b>alert(1)</b>'), false);
  assert.match(page.body, /\\u003c\/script>/);
  // The reveal toggle and the expect hint share one inline script; a second tag
  // would mean the pattern closed the element it lives in.
  assert.equal(page.body.match(/<script>/g).length, 1);
  assert.equal(page.body.match(/<\/script>/g).length, 1);
});
