// The one page a human ever sees.
//
// Self-contained by requirement: no assets, no frameworks, no requests beyond
// the form post itself. The markup is written once and lays out the same on a
// phone and on a desktop, because the person opening this link is usually
// holding a phone and already annoyed.
//
// Every interpolated string (label, description) comes from the model and is
// untrusted HTML; the page's own wording comes from the locale table in
// lib/i18n.mjs and is rendered through the same escaping path.

import { FALLBACK_LOCALE, format, messagesFor, normalizeLocale } from './i18n.mjs';

/** Headers that apply to every response, form pages and outcome pages alike. */
export const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
});

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f4f5f7;
  --card: #ffffff;
  --fg: #16181d;
  --muted: #5b6270;
  --line: #d5d9e0;
  --accent: #2a63d4;
  --accent-fg: #ffffff;
  --danger: #b4232a;
  --warn-bg: #fff4e0;
  --warn-fg: #7a4a00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --card: #1c1f26;
    --fg: #e8eaee;
    --muted: #9aa1ae;
    --line: #333842;
    --accent: #6b9bff;
    --accent-fg: #10141c;
    --danger: #ff8b8b;
    --warn-bg: #3a2d14;
    --warn-fg: #ffd48a;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}
main {
  max-width: 420px;
  margin: 0 auto;
  padding: 24px 16px 40px;
}
h1 { font-size: 20px; line-height: 1.3; margin: 0 0 10px; }
p { margin: 0 0 16px; }
.hint { color: var(--muted); font-size: 15px; }
label { display: block; font-size: 14px; font-weight: 600; margin: 0 0 6px; color: var(--muted); }
input, textarea {
  width: 100%;
  font-size: 16px;
  line-height: 1.4;
  color: var(--fg);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
  min-height: 48px;
}
textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  min-height: 168px;
  resize: vertical;
}
.field { position: relative; }
/* Firefox offers its password manager for input[type=password] and for text
   inputs it heuristically reads as login fields; a textarea is never treated as
   one, so the single-line case is a one-row textarea. The value is hidden by an
   overlay of bullets, which works in every browser without relying on
   -webkit-text-security. */
.single { min-height: 48px; height: 48px; resize: none; overflow: hidden; white-space: pre; padding-right: 12px; }
.masked { color: transparent; }
.mask {
  position: absolute;
  inset: 1px 1px 1px 1px;
  padding: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px;
  line-height: 1.4;
  color: var(--fg);
  background: var(--card);
  border-radius: 10px;
  pointer-events: none;
  overflow: hidden;
  white-space: pre;
}
.mask[hidden] { display: none; }
.reveal { margin: 10px 0 0; }
.reveal button {
  width: auto;
  min-height: 44px;
  padding: 0 16px;
  font-size: 15px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 10px;
  cursor: pointer;
}
.actions { display: flex; gap: 12px; margin: 22px 0 0; }
button { font: inherit; cursor: pointer; }
.actions button {
  flex: 1 1 auto;
  min-height: 50px;
  padding: 12px 16px;
  font-size: 16px;
  font-weight: 600;
  border-radius: 10px;
  border: 1px solid transparent;
}
.save { background: var(--accent); color: var(--accent-fg); }
.cancel { background: transparent; color: var(--fg); border-color: var(--line) !important; }
input[type=file] {
  padding: 10px;
  border-style: dashed;
  background: var(--bg);
}
pre.secret {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 15px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
  margin: 0 0 12px;
  max-height: 60vh;
  overflow: auto;
}
.copy {
  min-height: 46px;
  padding: 10px 18px;
  font-size: 15px;
  font-weight: 600;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: 10px;
}
.notice { border-left: 3px solid var(--accent); padding: 2px 0 2px 12px; }
.err { color: var(--danger); }
.warn { background: var(--warn-bg); color: var(--warn-fg); border-radius: 10px; padding: 12px; font-size: 15px; }
.meta { color: var(--muted); font-size: 13px; margin: 20px 0 0; }
`.trim();

/** Escape text for element content and double-quoted attributes. */
export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// A regular expression source reaches the page as a JS string literal, so it
// must not be able to close the script element it lives in.
function scriptLiteral(text) {
  return JSON.stringify(text).replaceAll('<', '\\u003c');
}

function shell({ title, body, script, locale }) {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
${body}
</main>
${script === undefined ? '' : `<script>\n${script}\n</script>`}
</body>
</html>
`;
}

// The page never renders a locale the table does not have: an unknown tag means
// the caller passed something odd, and English is always readable.
function localized(locale) {
  const resolved = normalizeLocale(locale) ?? FALLBACK_LOCALE;
  return { locale: resolved, messages: messagesFor(resolved) };
}

// Minute counts come from the locale's own rule: Russian has three forms, so
// the plural decision lives in the table next to the words it selects.
function remainingText(messages, remainingSeconds) {
  if (remainingSeconds === undefined) return '';
  if (remainingSeconds < 60) return messages.remainingSoon;
  return messages.remaining(Math.round(remainingSeconds / 60));
}

/**
 * Render the input page for a pending form.
 * @param form - pending form.
 * @param options - `actionPath` is where the form posts, `remainingSeconds`
 *   feeds the expiry line, `error` and `warning` are page-level messages,
 *   `locale` picks the wording (English when absent or unsupported).
 */
export function renderFormView(form, { actionPath, remainingSeconds, error, warning, locale } = {}) {
  const { locale: lang, messages } = localized(locale);
  const isFile = form.kind === 'file';
  const name = form.ref;
  const required = form.allowEmpty ? '' : ' required';
  const field = isFile
    ? `<input type="file" id="value" name="file"${required}>`
    : form.kind === 'single'
    ? `<div class="field"><textarea id="value" name="value" rows="1" class="single masked" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" wrap="off" autofocus${required}></textarea><div class="mask" id="mask" aria-hidden="true" hidden></div></div>`
    : `<textarea id="value" name="value" rows="8" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus${required}></textarea>`;
  const reveal = form.kind === 'single'
    ? `<div class="reveal"><button type="button" id="reveal" aria-pressed="false">${escapeHtml(messages.reveal)}</button></div>`
    : '';
  const scripts = [];
  if (form.kind === 'single') {
    scripts.push(`(function () {
  var button = document.getElementById('reveal');
  var field = document.getElementById('value');
  var mask = document.getElementById('mask');
  if (!button || !field || !mask) return;
  var hidden = true;
  var paint = function () {
    mask.hidden = !hidden;
    field.className = hidden ? 'single masked' : 'single';
    if (!hidden) return;
    mask.textContent = new Array(field.value.length + 1).join('\\u2022');
  };
  paint();
  field.addEventListener('input', paint);
  button.addEventListener('click', function () {
    hidden = !hidden;
    button.textContent = hidden ? ${scriptLiteral(messages.reveal)} : ${scriptLiteral(messages.hide)};
    button.setAttribute('aria-pressed', hidden ? 'false' : 'true');
    paint();
  });
})();`);
  }
  if (form.expectSource !== undefined && !isFile) {
    scripts.push(`(function () {
  var pattern = new RegExp(${scriptLiteral(form.expectSource)});
  var field = document.getElementById('value');
  var box = document.getElementById('expect-warning');
  if (!field || !box) return;
  field.addEventListener('input', function () {
    var value = field.value.trim();
    var mismatch = value !== '' && !pattern.test(value);
    box.hidden = !mismatch;
  });
})();`);
  }
  const remaining = remainingText(messages, remainingSeconds);
  const body = [
    `<h1>${escapeHtml(form.label)}</h1>`,
    form.description === undefined ? '' : `<p class="hint">${escapeHtml(form.description)}</p>`,
    error === undefined ? '' : `<p class="err">${escapeHtml(error)}</p>`,
    warning === undefined ? '' : `<p class="warn">${escapeHtml(warning)}</p>`,
    `<form method="post" action="${escapeHtml(actionPath)}"${isFile ? ' enctype="multipart/form-data"' : ''} autocomplete="off">`,
    // The ref is an identifier such as OPENAI_API_KEY: it is shown as is, next
    // to the translated word for the thing being filled in.
    `<label for="value">${escapeHtml(isFile ? messages.fileField : messages.field)} <span class="hint">${escapeHtml(name)}</span></label>`,
    // The locale travels with the post so the outcome page answers in the
    // language the form was read in, whatever the next request's header says.
    `<input type="hidden" name="lang" value="${escapeHtml(lang)}">`,
    field,
    reveal,
    form.expectSource === undefined || isFile
      ? ''
      : `<p class="warn" id="expect-warning" hidden>${escapeHtml(messages.mismatch)}</p>`,
    `<div class="actions">`,
    `<button class="save" type="submit" name="action" value="save">${escapeHtml(messages.save)}</button>`,
    `<button class="cancel" type="submit" name="action" value="cancel" formnovalidate>${escapeHtml(messages.cancel)}</button>`,
    `</div>`,
    `</form>`,
    // Without a remaining time there is no sentence to finish, so the line goes.
    remaining === '' ? '' : `<p class="meta">${escapeHtml(format(messages.note, { time: remaining }))}</p>`,
  ].filter((part) => part !== '');
  return shell({
    title: form.label,
    body: body.join('\n'),
    script: scripts.length === 0 ? undefined : scripts.join('\n'),
    locale: lang,
  });
}

/**
 * Render an outcome page: saved, empty, cancelled, used, expired, unknown.
 * @param kind - key of the notice table.
 * @param note - optional extra sentence, already user-facing.
 * @param options - `locale` picks the wording, English when absent.
 */
export function renderNotice(kind, note, { locale } = {}) {
  const { locale: lang, messages } = localized(locale);
  const notice = messages.notices[kind] ?? messages.notices.unknown;
  const body = [
    `<h1>${escapeHtml(notice.title)}</h1>`,
    `<p class="notice">${escapeHtml(notice.text)}</p>`,
    note === undefined ? '' : `<p class="warn">${escapeHtml(note)}</p>`,
  ].filter((part) => part !== '');
  return shell({ title: notice.title, body: body.join('\n'), locale: lang });
}

/**
 * Render the page of an outbound secret: a link that may be opened any number of
 * times, and a button that works exactly once.
 * @param share - pending share.
 * @param options - `actionPath` is where the reveal posts, `remainingSeconds`
 *   feeds the expiry line, `error` and `warning` are page-level messages,
 *   `locale` picks the wording.
 */
export function renderShareView(share, { actionPath, remainingSeconds, error, warning, locale } = {}) {
  const { locale: lang, messages } = localized(locale);
  const remaining = remainingText(messages, remainingSeconds);
  const body = [
    `<h1>${escapeHtml(share.label)}</h1>`,
    share.description === undefined ? '' : `<p class="hint">${escapeHtml(share.description)}</p>`,
    error === undefined ? '' : `<p class="err">${escapeHtml(error)}</p>`,
    warning === undefined ? '' : `<p class="warn">${escapeHtml(warning)}</p>`,
    `<form method="post" action="${escapeHtml(actionPath)}" autocomplete="off">`,
    `<input type="hidden" name="lang" value="${escapeHtml(lang)}">`,
    `<div class="actions">`,
    `<button class="save" type="submit" name="action" value="reveal">${escapeHtml(messages.revealSecret)}</button>`,
    `</div>`,
    `</form>`,
    remaining === '' ? '' : `<p class="meta">${escapeHtml(format(messages.shareNote, { time: remaining }))}</p>`,
  ].filter((part) => part !== '');
  return shell({
    title: share.label,
    body: body.join('\n'),
    locale: lang,
  });
}

/**
 * Render the one page that ever shows an outbound secret. It is produced once,
 * after the reveal burned the link, and carries the copy button.
 * @param share - the share that was just revealed.
 * @param options - `value` is the decrypted secret, `locale` picks the wording.
 */
export function renderRevealedView(share, { value, locale } = {}) {
  const { locale: lang, messages } = localized(locale);
  const script = `(function () {
  var button = document.getElementById('copy');
  var box = document.getElementById('secret');
  if (!button || !box) return;
  var done = function () { button.textContent = ${scriptLiteral(messages.copied)}; };
  var fallback = function () {
    var range = document.createRange();
    range.selectNodeContents(box);
    var selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    try { document.execCommand('copy'); done(); } catch (error) {}
  };
  button.addEventListener('click', function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.textContent || '').then(done, fallback);
      return;
    }
    fallback();
  });
})();`;
  const body = [
    `<h1>${escapeHtml(share.label)}</h1>`,
    `<pre class="secret" id="secret">${escapeHtml(value)}</pre>`,
    `<button class="copy" type="button" id="copy">${escapeHtml(messages.copy)}</button>`,
    `<p class="meta">${escapeHtml(messages.burnNote)}</p>`,
  ].filter((part) => part !== '');
  return shell({
    title: share.label,
    body: body.join('\n'),
    script,
    locale: lang,
  });
}

/** Send an HTML response with the security headers and an exact length. */
export function sendHtml(res, status, html, { head = false } = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length),
  });
  res.end(head ? undefined : body);
}

/** Send a short plain-text response (method or body rejections). */
export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(`${text}\n`, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    ...headers,
  });
  res.end(body);
}
