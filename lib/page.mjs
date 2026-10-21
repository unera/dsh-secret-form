// The one page a human ever sees.
//
// Self-contained by requirement: no assets, no frameworks, no requests beyond
// the form post itself. The markup is written once and lays out the same on a
// phone and on a desktop, because the person opening this link is usually
// holding a phone and already annoyed.
//
// Every interpolated string (label, description) comes from the model and is
// untrusted HTML.

/** Headers that apply to every response, form pages and outcome pages alike. */
export const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
});

const NOTICES = Object.freeze({
  saved: {
    title: 'Saved',
    text: 'The value has been stored on the host. It is not shown here and was not sent to the chat; you can close this tab.',
  },
  empty: {
    title: 'Nothing stored',
    text: 'The form was submitted empty, so no value was saved.',
  },
  cancelled: {
    title: 'Cancelled',
    text: 'This form was cancelled. Nothing was saved.',
  },
  used: {
    title: 'Link already used',
    text: 'This link has already been used once and no longer accepts input. Ask for a new link if you still need to share a value.',
  },
  expired: {
    title: 'Link expired',
    text: 'This link is too old and no longer accepts input. Ask for a new link to submit the value.',
  },
  unknown: {
    title: 'Link not recognised',
    text: 'This link does not match any open form. It may have been mistyped, or the harness may have restarted since it was created.',
  },
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

function shell({ title, body, script }) {
  return `<!DOCTYPE html>
<html lang="en">
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

function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function remainingText(remainingSeconds) {
  if (remainingSeconds === undefined) return '';
  if (remainingSeconds < 60) return 'in less than a minute';
  return `in ${plural(Math.round(remainingSeconds / 60), 'minute')}`;
}

/**
 * Render the input page for a pending form.
 * @param form - pending form.
 * @param options - `actionPath` is where the form posts, `remainingSeconds`
 *   feeds the expiry line, `error` and `warning` are page-level messages.
 */
export function renderFormView(form, { actionPath, remainingSeconds, error, warning } = {}) {
  const name = form.ref;
  const required = form.allowEmpty ? '' : ' required';
  const field = form.kind === 'single'
    ? `<input id="value" name="value" type="password" value="" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus${required}>`
    : `<textarea id="value" name="value" rows="8" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus${required}></textarea>`;
  const reveal = form.kind === 'single'
    ? `<div class="reveal"><button type="button" id="reveal" aria-pressed="false">Reveal</button></div>`
    : '';
  const scripts = [];
  if (form.kind === 'single') {
    scripts.push(`(function () {
  var button = document.getElementById('reveal');
  var field = document.getElementById('value');
  if (!button || !field) return;
  button.addEventListener('click', function () {
    var shown = field.type === 'text';
    field.type = shown ? 'password' : 'text';
    button.textContent = shown ? 'Reveal' : 'Hide';
    button.setAttribute('aria-pressed', shown ? 'false' : 'true');
  });
})();`);
  }
  if (form.expect !== undefined) {
    scripts.push(`(function () {
  var pattern = new RegExp(${scriptLiteral(form.expect.source)});
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
  const body = [
    `<h1>${escapeHtml(form.label)}</h1>`,
    form.description === undefined ? '' : `<p class="hint">${escapeHtml(form.description)}</p>`,
    error === undefined ? '' : `<p class="err">${escapeHtml(error)}</p>`,
    warning === undefined ? '' : `<p class="warn">${escapeHtml(warning)}</p>`,
    `<form method="post" action="${escapeHtml(actionPath)}" autocomplete="off">`,
    `<label for="value">${escapeHtml(name)}</label>`,
    field,
    reveal,
    form.expect === undefined
      ? ''
      : `<p class="warn" id="expect-warning" hidden>This value does not look like the expected format. You can still save it.</p>`,
    `<div class="actions">`,
    `<button class="save" type="submit" name="action" value="save">Save</button>`,
    `<button class="cancel" type="submit" name="action" value="cancel" formnovalidate>Cancel</button>`,
    `</div>`,
    `</form>`,
    `<p class="meta">One-time link: it works once and stops accepting input ${escapeHtml(remainingText(remainingSeconds))}.</p>`,
  ].filter((part) => part !== '');
  return shell({
    title: form.label,
    body: body.join('\n'),
    script: scripts.length === 0 ? undefined : scripts.join('\n'),
  });
}

/**
 * Render an outcome page: saved, empty, cancelled, used, expired, unknown.
 * @param kind - key of the notice table.
 * @param note - optional extra sentence, already user-facing.
 */
export function renderNotice(kind, note) {
  const notice = NOTICES[kind] ?? NOTICES.unknown;
  const body = [
    `<h1>${escapeHtml(notice.title)}</h1>`,
    `<p class="notice">${escapeHtml(notice.text)}</p>`,
    note === undefined ? '' : `<p class="warn">${escapeHtml(note)}</p>`,
  ].filter((part) => part !== '');
  return shell({ title: notice.title, body: body.join('\n') });
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
