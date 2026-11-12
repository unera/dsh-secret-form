// One-time secret links for DeepSeek Harness.
//
// Two directions, one surface:
//
//   * `secret_create` asks the human for a value (or a file). The value never
//     reaches the model: the page writes it straight into the credential store
//     or a document file, and the model learns aggregate facts only.
//   * `secret_share` hands a secret to the human: the link may be opened many
//     times, the reveal button works exactly once, and the sealed value is
//     deleted as soon as it was shown.
//
// Both directions live in SQLite (`lib/db.mjs`), so a form created before a
// restart still accepts its submission afterwards, and its token is stored as a
// hash. A finished direction wakes the session that asked for it through the
// schedule service (`lib/notify.mjs`) — the same route the graceful-restart
// plugin uses for its post-restart note.
//
// Two HTTP surfaces on the Web GUI host: `GET <prefix>/<token>` renders the page
// and `POST <prefix>/<token>` accepts it (urlencoded, or multipart for a file).
// The token is the capability: single use for a form, single reveal for a share.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { closeDatabase, defaultDatabasePath, openDatabase } from './lib/db.mjs';
import {
  KINDS,
  MAX_WAIT_SECONDS,
  STATUS,
  clampTtl,
  createFormStore,
  normalizeWait,
  publicResult,
  publicSummary,
} from './lib/forms.mjs';
import { SUPPORTED_LOCALES, format, messagesFor, normalizeLocale, resolveLocale } from './lib/i18n.mjs';
import { NOTE_KINDS, createNotifier } from './lib/notify.mjs';
import {
  renderFormView,
  renderNotice,
  renderRevealedView,
  renderShareView,
  sendHtml,
  sendText,
} from './lib/page.mjs';
import { SHARE_STATUS, createShareStore, publicShareResult, publicShareSummary } from './lib/shares.mjs';
import { assertRefForTarget, normalizeTarget, writeSecret } from './lib/targets.mjs';
import { DEFAULT_MAX_UPLOAD_BYTES, boundaryOf, normalizeUploadDir, parseMultipart, saveUpload } from './lib/upload.mjs';

export const name = 'dsh-secret-form';
// A form without a page cannot be filled in, and a form without tools cannot be
// requested. Everything else is optional and looked up lazily: `credentials` is
// needed only for a credential target or a credential share, `schedule` only to
// wake a session with a note.
export const inject = ['tools', 'webServer'];

const DEFAULT_ROUTE_PREFIX = '/secret';
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_LOCALE = 'en';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_RETAIN_SECONDS = 3600;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SHARE_SECRET_BYTES = 256 * 1024;
const LANGUAGES = Object.freeze(['en', 'ru', 'zh']);

function invalidConfig(message) {
  return new TypeError(`dsh-secret-form: ${message}`);
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Clamp a number into a window; a non-number is a config error, not a default. */
function clampNumber(value, { min, max, fallback, field }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidConfig(`${field} must be a number`);
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Validate the plugin config.
 * @param config - `routePrefix`, `defaultTtlSeconds`, `defaultLocale`,
 *   `publicUrl`, `database`, `language`, `notify`, `maxUploadBytes` and
 *   `retainSeconds`.
 */
export function normalizeConfig(config = {}) {
  const prefixRaw = config?.routePrefix ?? DEFAULT_ROUTE_PREFIX;
  if (typeof prefixRaw !== 'string') throw invalidConfig('routePrefix must be a string');
  const prefix = prefixRaw.trim().replace(/\/+$/, '');
  if (prefix === '') throw invalidConfig('routePrefix must not be empty or the server root');
  if (!prefix.startsWith('/')) throw invalidConfig('routePrefix must start with "/"');
  if (/[\s?#]/.test(prefix)) throw invalidConfig('routePrefix must not contain whitespace, "?" or "#"');
  const ttl = clampTtl(config?.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  // The listener usually binds loopback behind a proxy, so its own origin is
  // useless in a link meant for a phone. A public URL wins when configured.
  const publicUrlRaw = config?.publicUrl;
  let publicUrl;
  if (publicUrlRaw !== undefined && publicUrlRaw !== null && publicUrlRaw !== '') {
    if (typeof publicUrlRaw !== 'string') throw invalidConfig('publicUrl must be a string');
    const trimmed = publicUrlRaw.trim().replace(/\/+$/, '');
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw invalidConfig('publicUrl must be an absolute http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw invalidConfig('publicUrl must be an absolute http(s) URL');
    }
    publicUrl = trimmed;
  }
  // The page falls back to this locale when neither the link nor the browser
  // asks for one, so a host known to serve one language can pin it.
  const localeRaw = config?.defaultLocale ?? DEFAULT_LOCALE;
  if (typeof localeRaw !== 'string') throw invalidConfig('defaultLocale must be a string');
  const defaultLocale = normalizeLocale(localeRaw);
  if (defaultLocale === undefined) {
    throw invalidConfig(`defaultLocale must be one of: ${SUPPORTED_LOCALES.join(', ')}`);
  }
  const databaseRaw = config?.database ?? defaultDatabasePath();
  if (typeof databaseRaw !== 'string' || databaseRaw.trim() === '') {
    throw invalidConfig('database must be a file path');
  }
  const languageRaw = String(config?.language ?? DEFAULT_LANGUAGE).trim().toLowerCase();
  const language = LANGUAGES.includes(languageRaw) ? languageRaw : DEFAULT_LANGUAGE;
  return {
    routePrefix: prefix,
    defaultTtlSeconds: ttl,
    publicUrl,
    defaultLocale,
    database: resolve(databaseRaw.trim()),
    language,
    notify: booleanOr(config?.notify, true),
    maxUploadBytes: clampNumber(config?.maxUploadBytes, {
      min: 1024,
      max: 1024 * 1024 * 1024,
      fallback: DEFAULT_MAX_UPLOAD_BYTES,
      field: 'maxUploadBytes',
    }),
    retainSeconds: clampNumber(config?.retainSeconds, {
      min: 60,
      max: 7 * 24 * 3600,
      fallback: DEFAULT_RETAIN_SECONDS,
      field: 'retainSeconds',
    }),
  };
}

function resolveLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') {
      const logger = ctx.logger(name);
      if (logger !== undefined && logger !== null) return logger;
    }
  } catch {
    // A host whose logger factory rejects this name still needs the plugin.
  }
  return ctx?.logger ?? console;
}

// Only the first eight characters of an identifier are ever logged: a token's
// tail is the capability itself, so records are logged by their uuid.
function recordTag(record) {
  return typeof record?.uuid === 'string' ? record.uuid.slice(0, 8) : '????????';
}

function resolveOrigin(ctx, settings) {
  if (settings?.publicUrl) return settings.publicUrl;
  const server = ctx?.webServer;
  if (typeof server?.getOrigin !== 'function') {
    throw new Error('dsh-secret-form: this host exposes no Web GUI server, so a secret link has no origin');
  }
  try {
    return server.getOrigin();
  } catch (error) {
    throw new Error(`dsh-secret-form: the web server origin is not available yet (${error.message})`);
  }
}

/** A human sentence for where a submitted value went; used in notes and answers. */
function describeTarget(target, ref) {
  if (target.kind === 'credentials') return `the credential store as ${ref}`;
  if (target.kind === 'upload') return `the directory ${target.dir}`;
  return `the file ${target.path} (${target.format})`;
}

const NOTE_TARGET_LIMIT = 160;

/**
 * Read the value of an outbound secret from its source.
 * The value never travels through the tool arguments: either a file on the host
 * or a credential reference is named, and the bytes are read here.
 */
async function readShareValue(args, ctx) {
  const file = typeof args.file === 'string' && args.file.trim() !== '' ? args.file.trim() : undefined;
  const credential = typeof args.credential === 'string' && args.credential.trim() !== ''
    ? args.credential.trim()
    : undefined;
  if ((file === undefined) === (credential === undefined)) {
    throw new TypeError('name exactly one source: file (a path on this host) or credential (a reference name)');
  }
  if (file !== undefined) {
    const path = resolve(file);
    let data;
    try {
      data = await readFile(path);
    } catch (error) {
      throw new TypeError(`cannot read ${path}: ${error.code ?? error.message}`);
    }
    if (data.length > MAX_SHARE_SECRET_BYTES) {
      throw new TypeError(`${path} is ${data.length} bytes; a share carries at most ${MAX_SHARE_SECRET_BYTES}`);
    }
    const text = data.toString('utf8');
    if (text.includes('\u0000')) {
      throw new TypeError(`${path} looks like a binary file; pass a text secret`);
    }
    const value = text.trim();
    if (value === '') throw new TypeError(`${path} is empty`);
    return { value, source: 'file', fileName: basename(path) };
  }
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials;
  if (credentials === undefined || typeof credentials.resolve !== 'function') {
    throw new Error('the credentials service is not mounted, so a credential share has no source');
  }
  const resolvedValue = await credentials.resolve(credential);
  if (resolvedValue === undefined || typeof resolvedValue.value !== 'string' || resolvedValue.value === '') {
    throw new TypeError(`credential ${credential} is not set in this host`);
  }
  return { value: resolvedValue.value, source: 'credential', fileName: undefined };
}

/** Merge both stores into one `secret_list` answer, oldest first. */
function mergedList(forms, shares) {
  const rows = [
    ...forms.list().map((form) => ({ createdAt: form.createdAt, row: publicSummary(form) })),
    ...shares.list().map((share) => ({ createdAt: share.createdAt, row: publicShareSummary(share) })),
  ];
  return rows.sort((left, right) => left.createdAt - right.createdAt).map((entry) => entry.row);
}

/**
 * Register the tools.
 * @param ctx - host context carrying `tools`.
 * @param deps - stores, settings, logger, notifier and the session-aware helpers.
 */
export function registerTools(ctx, { forms, shares, settings, logger, notifier, ctx: hostCtx = ctx }) {
  const tools = ctx?.tools;
  if (typeof tools?.register !== 'function') {
    throw new TypeError('dsh-secret-form: the tools service is required');
  }
  const textOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };
  const listOutput = {
    schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };

  tools.register({
    name: 'secret_create',
    description: "Ask the human for a secret through a form link instead of having it typed into the chat: chat history, transcripts and every provider request would keep a pasted key forever, while a form writes the value straight to the host.\n\nCreate the form, then put the returned url in your own reply to the human — that message is how they learn about the link. Call secret_result with the returned uuid to find out whether the value arrived; the value itself is never returned to you. The session that created the form is remembered and woken with a note when the form is filled in, cancelled, or a shared secret is collected, unless you pass notify=false.\n\nkinds: single (one-line value, e.g. an API key), multi (a textarea for certificates and multi-line secrets), file (the human picks a file; requires upload { dir } and nothing is sent to the chat).\n\nThe link is built from the host public URL when one is configured, and otherwise from the web server own listener origin. Hand the url over exactly as returned and never rewrite it.\n\nref names the key the value is stored under. With the default credentials target it is the credential name, for example OPENAI_API_KEY. With a file target it is the path inside that document: a flat .env takes a bare key, while structured .yaml and .json documents take a dotted path. For kind=file ref is only a label unless upload.name is omitted, when it becomes the file name.\n\nThe form is stored in SQLite and survives a restart of the harness; its token is stored only as a hash.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: {
          type: 'string',
          description: 'Key name. Credentials target: the credential name, e.g. OPENAI_API_KEY. File target: the path inside the document — a bare key for .env, a dotted path such as ref.fooname for .yaml and .json.',
        },
        label: {
          type: 'string',
          description: 'Form title, 2 to 5 words, shown to the human.',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description: 'single (one-line value), multi (textarea, for certificates and other multi-line secrets), or file (the human uploads a file). Default single.',
        },
        description: {
          type: 'string',
          description: 'Optional one or two sentences shown under the title, at most 300 characters. State what the value is for, so the human knows what to paste.',
        },
        save: {
          type: 'object',
          additionalProperties: true,
          description: 'Where the value goes for kind=single|multi. Default credentials. A file target is { kind: "file", path }; the extension picks the format — .yaml, .yml, .json or .env. Missing directories are created, the file is written atomically with mode 0600, and unrelated keys in it are preserved.',
        },
        upload: {
          type: 'object',
          additionalProperties: false,
          description: 'Required for kind=file: { dir, name? }. dir is an absolute directory on this host that receives the file (created when missing, mode 0700); name is the file name to write, and defaults to the name the browser sent.',
          properties: {
            dir: { type: 'string', description: 'Absolute path of the directory that receives the uploaded file.' },
            name: { type: 'string', description: 'File name to write inside dir. Default: the name the browser sent.' },
          },
          required: ['dir'],
        },
        ttlSeconds: {
          type: 'integer',
          description: 'How long the link accepts input, 30 to 3600 seconds. Default 300. After that the form reports expired.',
        },
        allowEmpty: {
          type: 'boolean',
          description: 'Accept an empty submission and report it as empty. Default false: the page refuses to submit nothing.',
        },
        expect: {
          type: 'string',
          description: 'Optional regular expression, as text, the submitted value should match. Reported back as matchesExpect; it never blocks a save.',
        },
        notify: {
          type: 'boolean',
          description: 'Wake the creating session with a note when the form is filled in or cancelled. Default: the plugin setting (on).',
        },
        data: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional JSON object, at most 1 KB, of bookkeeping for yourself — a workflow id, a provider name, anything you want back later. Echoed by secret_result and secret_list and never shown on the page.',
        },
      },
      required: ['label'],
    },
    output: textOutput,
    async execute(args, exec) {
      const kind = args.kind ?? 'single';
      if (!KINDS.includes(kind)) throw new TypeError(`kind must be one of: ${KINDS.join(', ')}`);
      const sessionId = exec?.agent?.session?.id ?? null;
      const notify = args.notify === undefined ? settings.notify : args.notify === true;
      let target;
      let ref;
      if (kind === 'file') {
        target = { kind: 'upload', dir: normalizeUploadDir(args.upload?.dir), name: args.upload?.name };
        ref = typeof args.ref === 'string' && args.ref.trim() !== ''
          ? args.ref.trim()
          : (typeof target.name === 'string' && target.name !== '' ? target.name : 'file');
      } else {
        target = normalizeTarget(args.save);
        ref = assertRefForTarget(target, args.ref);
      }
      const form = forms.create({
        ref,
        target,
        label: args.label,
        kind,
        description: args.description,
        ttlSeconds: args.ttlSeconds,
        allowEmpty: args.allowEmpty,
        expect: args.expect,
        data: args.data,
        sessionId,
        notify,
      });
      const url = `${resolveOrigin(hostCtx, settings)}${settings.routePrefix}/${form.token}`;
      logger?.info?.(`created form ${recordTag(form)} for ${ref} (${kind})`);
      return {
        uuid: form.uuid,
        url,
        expiresAt: new Date(form.expiresAt).toISOString(),
        kind,
        data: form.data,
      };
    },
  });

  tools.register({
    name: 'secret_share',
    description: 'Hand a secret to the human through a one-time link. The value does not pass through this call: name a source — file (a path on this host) or credential (a reference name) — and the plugin reads the bytes itself, seals them with a one-shot key and stores both in SQLite.\n\nThe link may be opened any number of times; the reveal button on it works exactly once. After the reveal the link is dead and the sealed value with its key is deleted. If nobody reveals it before ttlSeconds, the value is deleted on expiry too. Only text secrets are carried: a file must be readable text of at most 256 KiB.\n\nPut the returned url in your own reply. The session that created the share is woken with a note when the human collects the secret, unless notify=false. secret_result(uuid) reports whether it was collected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: {
          type: 'string',
          description: 'Page title, 2 to 5 words, shown to the human.',
        },
        kind: {
          type: 'string',
          enum: ['single', 'multi'],
          description: 'single for a one-line value, multi for a multi-line one. Default single.',
        },
        file: {
          type: 'string',
          description: 'Absolute path of a text file on this host whose contents are the secret. Exactly one of file or credential.',
        },
        credential: {
          type: 'string',
          description: 'Name of a stored credential, e.g. OPENAI_API_KEY, whose value is the secret. Exactly one of file or credential.',
        },
        description: {
          type: 'string',
          description: 'Optional one or two sentences shown under the title, at most 300 characters.',
        },
        ttlSeconds: {
          type: 'integer',
          description: 'How long the link lives, 30 to 3600 seconds. Default 300. After that the value is deleted unread.',
        },
        notify: {
          type: 'boolean',
          description: 'Wake the creating session with a note when the human collects the secret. Default: the plugin setting (on).',
        },
        data: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional JSON object, at most 1 KB, of bookkeeping for yourself. Echoed back by secret_result and secret_list.',
        },
      },
      required: ['label'],
    },
    output: textOutput,
    async execute(args, exec) {
      const source = await readShareValue(args, hostCtx);
      const sessionId = exec?.agent?.session?.id ?? null;
      const notify = args.notify === undefined ? settings.notify : args.notify === true;
      const share = shares.create({
        label: args.label,
        kind: args.kind ?? 'single',
        description: args.description,
        data: args.data,
        value: source.value,
        source: source.source,
        fileName: source.fileName,
        ttlSeconds: args.ttlSeconds,
        sessionId,
        notify,
      });
      const url = `${resolveOrigin(hostCtx, settings)}${settings.routePrefix}/${share.token}`;
      logger?.info?.(`created share ${recordTag(share)} (${source.source}, ${source.value.length} chars)`);
      return {
        uuid: share.uuid,
        url,
        expiresAt: new Date(share.expiresAt).toISOString(),
        source: source.source,
        length: source.value.length,
        data: share.data,
      };
    },
  });

  tools.register({
    name: 'secret_result',
    description: "Read the state of a form from secret_create or a link from secret_share. The value is never returned: you learn whether it arrived and how it looks, which is normally enough to keep going.\n\nFor a form, status is one of: pending (nobody has submitted or cancelled yet), saved (the value was written), empty (an empty value was submitted under allowEmpty and nothing was written), cancelled, expired. For saved and empty the answer also carries length, lines, trimmed and, for a file form, fileName, size, sha256 and path.\n\nFor a share, status is one of: pending (not collected yet), revealed (the human pressed the button; the value and its key are deleted), cancelled, expired. views counts how often the link page was opened, so pending with views>0 means the human looked but did not press the button.\n\nWith waitSeconds above zero the call waits for the record to leave pending, up to that many seconds.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uuid: { type: 'string', description: 'The uuid returned by secret_create or secret_share.' },
        waitSeconds: {
          type: 'integer',
          description: `How long to wait for the record to leave pending, 0 to ${MAX_WAIT_SECONDS} seconds. Default 0: report the current state without waiting.`,
        },
      },
      required: ['uuid'],
    },
    output: textOutput,
    async execute(args) {
      const waitSeconds = normalizeWait(args.waitSeconds);
      const found = requireRecord(forms, shares, args.uuid);
      if (found.form !== undefined) {
        const settled = await forms.settle(found.form, waitSeconds * 1000);
        return publicResult(settled);
      }
      const { share } = found;
      const ms = waitSeconds * 1000;
      if (share.status === SHARE_STATUS.pending && ms > 0) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          await new Promise((done) => {
            const timer = setTimeout(done, Math.min(500, Math.max(50, deadline - Date.now())));
            timer.unref?.();
          });
          if (shares.require(args.uuid).status !== SHARE_STATUS.pending) break;
        }
      }
      return publicShareResult(shares.require(args.uuid));
    },
  });

  tools.register({
    name: 'secret_list',
    description: 'List every form and share the plugin still holds, oldest first: uuid, type (form or share), ref or label, status, createdAt, expiresAt, and the data booked at creation. Submitted values and sealed secrets are never included. The list is read from SQLite, so it also holds records created before a restart. Check it before creating a second record for the same purpose.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: listOutput,
    execute() {
      return mergedList(forms, shares);
    },
  });

  tools.register({
    name: 'secret_cancel',
    description: 'Cancel a pending form or share so its link stops working and nothing is written or revealed. Use it when the request no longer stands: the workflow moved on, the human declined, or a new link replaces this one. For a share this also deletes the sealed value and its key. Cancelling something that already finished changes nothing and reports the status it already has.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uuid: { type: 'string', description: 'The uuid returned by secret_create or secret_share.' },
      },
      required: ['uuid'],
    },
    output: textOutput,
    async execute(args) {
      const found = requireRecord(forms, shares, args.uuid);
      if (found.form !== undefined) {
        const cancelled = forms.cancel(found.form);
        logger?.info?.(`cancelled form ${cancelled.uuid}`);
        if (cancelled.status === STATUS.cancelled && cancelled.notify && notifier !== undefined) {
          notifier.queue({
            kind: NOTE_KINDS.formCancelled,
            uuid: cancelled.uuid,
            sessionId: cancelled.sessionId,
            variables: { label: cancelled.label, ref: cancelled.ref },
          });
          forms.markNotified(cancelled);
        }
        return publicResult(cancelled);
      }
      const share = shares.cancel(found.share);
      logger?.info?.(`cancelled share ${share.uuid}`);
      return publicShareResult(share);
    },
  });
}

/** Find a form by uuid, or undefined when the uuid names a share instead. */
function findForm(forms, uuid) {
  try {
    return forms.require(uuid);
  } catch {
    return undefined;
  }
}

/** Resolve one uuid against both stores, or refuse with one sentence. */
function requireRecord(forms, shares, uuid) {
  const form = findForm(forms, uuid);
  if (form !== undefined) return { form };
  try {
    return { share: shares.require(uuid) };
  } catch {
    throw new TypeError(`unknown secret form or link ${JSON.stringify(uuid ?? null)}`);
  }
}

function noticeFor(status, kind) {
  if (status === STATUS.saved) return kind === 'file' ? 'uploaded' : 'used';
  if (status === STATUS.empty) return 'used';
  return status;
}

function noticeForShare(status) {
  if (status === SHARE_STATUS.revealed) return 'revealed';
  return status;
}

async function readBody(request, limit) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error('payload too large');
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) {
      const error = new Error('payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

function isFormPost(request) {
  const type = request.headers['content-type'];
  if (typeof type !== 'string') return false;
  return type.split(';', 1)[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

/**
 * Build the HTTP handler for the route prefix.
 * @param deps - stores, settings, logger, credentials lookup, notifier and the clock.
 */
export function createRouteHandler({
  forms,
  shares,
  settings,
  logger,
  credentialsOf,
  notifier,
  now = Date.now,
}) {
  const { routePrefix } = settings;

  // A record read from the database carries no token — that is the point — so
  // the action of its page comes from the request that resolved it.
  const pageFor = (form, actionPath, locale, extra = {}) => renderFormView(form, {
    actionPath,
    remainingSeconds: Math.max(0, Math.round((form.expiresAt - now()) / 1000)),
    locale,
    ...extra,
  });

  const sharePageFor = (share, actionPath, locale, extra = {}) => renderShareView(share, {
    actionPath,
    remainingSeconds: Math.max(0, Math.round((share.expiresAt - now()) / 1000)),
    locale,
    ...extra,
  });

  /** Tell the creating session what happened, if the record asked for it. */
  const noteForm = (kind, form, variables) => {
    if (notifier === undefined || !form.notify || typeof form.sessionId !== 'string') return;
    notifier.queue({ kind, uuid: form.uuid, sessionId: form.sessionId, variables });
    forms.markNotified(form);
  };

  const noteShare = (kind, share, variables) => {
    if (notifier === undefined || !share.notify || typeof share.sessionId !== 'string') return;
    notifier.queue({ kind, uuid: share.uuid, sessionId: share.sessionId, variables });
    shares.markNotified(share);
  };

  async function handleUpload(request, response, form, actionPath, locale) {
    const boundary = boundaryOf(request.headers['content-type']);
    if (boundary === undefined) {
      sendText(response, 415, 'Expected multipart/form-data');
      return;
    }
    let body;
    try {
      body = await readBody(request, settings.maxUploadBytes + MAX_BODY_BYTES);
    } catch (error) {
      sendText(response, error.status ?? 400, error.message);
      return;
    }
    const parsed = parseMultipart(body, boundary);
    const action = parsed.fields.get('action') ?? 'save';
    const effectiveLocale = parsed.fields.get('lang') === undefined
      ? locale
      : resolveLocale({ lang: parsed.fields.get('lang'), defaultLocale: settings.defaultLocale });
    const dict = messagesFor(effectiveLocale);
    if (action === 'cancel') {
      forms.cancel(form);
      logger?.info?.(`cancelled form ${recordTag(form)}`);
      sendHtml(response, 200, renderNotice('cancelled', undefined, { locale: effectiveLocale }));
      noteForm(NOTE_KINDS.formCancelled, form, { label: form.label, ref: form.ref });
      return;
    }
    const part = parsed.files.find((candidate) => candidate.name === 'file');
    if (part === undefined || part.data.length === 0) {
      const extra = { error: dict.errors.nofile };
      sendHtml(response, 422, pageFor(form, actionPath, effectiveLocale, extra));
      return;
    }
    if (part.data.length > settings.maxUploadBytes) {
      sendText(response, 413, 'payload too large');
      return;
    }
    const started = forms.beginUpload(form);
    if (started.outcome === 'busy') {
      sendHtml(response, 409, pageFor(form, actionPath, effectiveLocale, { error: dict.errors.busy }));
      return;
    }
    if (started.outcome !== 'ready') {
      sendHtml(response, 410, renderNotice(noticeFor(form.status, form.kind), undefined, { locale: effectiveLocale }));
      return;
    }
    let facts;
    try {
      facts = await saveUpload({
        dir: form.target.dir,
        name: form.target.name ?? part.filename,
        data: part.data,
      });
    } catch (error) {
      forms.abortSubmit(form);
      logger?.warn?.(`${recordTag(form)} upload refused: ${error.message}`);
      const detail = String(error.message).slice(0, 300);
      sendHtml(response, 500, pageFor(form, actionPath, effectiveLocale, { error: format(dict.errors.upload, { detail }) }));
      return;
    }
    forms.completeSubmit(form, { empty: false, trimmed: false, length: 0, lines: 0, file: facts });
    logger?.info?.(`${recordTag(form)} stored ${facts.size} bytes as ${facts.path}`);
    sendHtml(response, 200, renderNotice('uploaded', undefined, { locale: effectiveLocale }));
    noteForm(NOTE_KINDS.formUploaded, form, {
      label: form.label,
      fileName: facts.fileName,
      size: facts.size,
      path: facts.path,
      sha256: facts.sha256,
    });
  }

  async function handleFormPost(request, response, form, actionPath, locale) {
    if (form.kind === 'file') {
      await handleUpload(request, response, form, actionPath, locale);
      return;
    }
    if (!isFormPost(request)) {
      sendText(response, 415, 'Expected application/x-www-form-urlencoded');
      return;
    }
    let body;
    try {
      body = new URLSearchParams((await readBody(request, MAX_BODY_BYTES)).toString('utf8'));
    } catch (error) {
      sendText(response, error.status ?? 400, error.message);
      return;
    }
    // The hidden field wins over the header: it is what the reader actually saw.
    const effectiveLocale = resolveLocale({
      lang: body.get('lang') ?? locale,
      defaultLocale: settings.defaultLocale,
    });
    const messages = messagesFor(effectiveLocale);
    const action = body.get('action');
    if (action === 'cancel') {
      forms.cancel(form);
      logger?.info?.(`cancelled ${recordTag(form)}`);
      sendHtml(response, 200, renderNotice('cancelled', undefined, { locale: effectiveLocale }));
      noteForm(NOTE_KINDS.formCancelled, form, { label: form.label, ref: form.ref });
      return;
    }
    if (action !== 'save') {
      sendHtml(response, 400, pageFor(form, actionPath, effectiveLocale, { error: messages.errors.action }));
      return;
    }
    const submission = forms.beginSubmit(form, body.get('value') ?? '');
    if (submission.outcome === 'invalid') {
      sendHtml(response, 422, pageFor(form, actionPath, effectiveLocale, { error: messages.errors.empty }));
      return;
    }
    if (submission.outcome === 'busy') {
      sendHtml(response, 409, pageFor(form, actionPath, effectiveLocale, { error: messages.errors.busy }));
      return;
    }
    if (submission.outcome !== 'ready') {
      sendHtml(response, 410, renderNotice(noticeFor(form.status, form.kind), undefined, { locale: effectiveLocale }));
      return;
    }
    try {
      await writeSecret(form.target, form.ref, submission.value, { credentials: credentialsOf() });
    } catch (error) {
      forms.abortSubmit(form);
      logger?.warn?.(`${recordTag(form)} could not be stored: ${error.message}`);
      const detail = String(error.message).slice(0, 300);
      sendHtml(response, 500, pageFor(form, actionPath, effectiveLocale, { error: format(messages.errors.store, { detail }) }));
      return;
    }
    forms.completeSubmit(form, submission);
    logger?.info?.(`${recordTag(form)} ${form.status}`);
    const note = submission.matchesExpect === false ? messages.mismatchNote : undefined;
    sendHtml(response, 200, renderNotice(submission.empty ? 'empty' : 'saved', note, { locale: effectiveLocale }));
    noteForm(NOTE_KINDS.formSaved, form, {
      label: form.label,
      ref: form.ref,
      target: describeTarget(form.target, form.ref).slice(0, NOTE_TARGET_LIMIT),
    });
  }

  async function handleSharePost(request, response, share, actionPath, locale) {
    let effectiveLocale = locale;
    if (isFormPost(request)) {
      let body;
      try {
        body = new URLSearchParams((await readBody(request, MAX_BODY_BYTES)).toString('utf8'));
      } catch (error) {
        sendText(response, error.status ?? 400, error.message);
        return;
      }
      effectiveLocale = resolveLocale({
        lang: body.get('lang') ?? locale,
        defaultLocale: settings.defaultLocale,
      });
      if (body.get('action') !== 'reveal') {
        const messages = messagesFor(effectiveLocale);
        sendHtml(response, 400, sharePageFor(share, actionPath, effectiveLocale, { error: messages.errors.action }));
        return;
      }
    }
    const at = now();
    const revealed = shares.reveal(share);
    if (revealed.value === undefined) {
      logger?.info?.(`share ${recordTag(share)} not revealed: ${revealed.status}`);
      sendHtml(response, 410, renderNotice(noticeForShare(revealed.status), undefined, { locale: effectiveLocale }));
      return;
    }
    logger?.info?.(`share ${recordTag(share)} revealed at ${new Date(at).toISOString()}`);
    sendHtml(response, 200, renderRevealedView(share, { value: revealed.value, locale: effectiveLocale }));
    noteShare(NOTE_KINDS.shareRevealed, share, { label: share.label });
  }

  return async function secretFormRoute(request, response) {
    const target = String(request.url ?? '/');
    const queryIndex = target.indexOf('?');
    const path = queryIndex === -1 ? target : target.slice(0, queryIndex);
    const query = new URLSearchParams(queryIndex === -1 ? '' : target.slice(queryIndex + 1));
    const acceptLanguage = request.headers['accept-language'];
    const localeFor = (lang) => resolveLocale({ lang, acceptLanguage, defaultLocale: settings.defaultLocale });
    if (!path.startsWith(`${routePrefix}/`)) {
      sendText(response, 404, 'Not found');
      return;
    }
    let token;
    try {
      token = decodeURIComponent(path.slice(routePrefix.length + 1));
    } catch {
      sendText(response, 404, 'Not found');
      return;
    }
    if (token === '' || token.includes('/')) {
      sendText(response, 404, 'Not found');
      return;
    }
    const actionPath = `${routePrefix}/${encodeURIComponent(token)}`;
    const method = String(request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      sendText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
      return;
    }

    // A link the model pinned with `?lang=` keeps that language for the whole
    // exchange: the form carries it in a hidden field that outranks the header.
    const locale = localeFor(query.get('lang') ?? undefined);

    const form = forms?.lookup(token);
    if (form !== undefined) {
      if (method !== 'POST') {
        if (form.status !== STATUS.pending) {
          sendHtml(response, 200, renderNotice(noticeFor(form.status, form.kind), undefined, { locale }), { head: method === 'HEAD' });
          return;
        }
        sendHtml(response, 200, pageFor(form, actionPath, locale), { head: method === 'HEAD' });
        return;
      }
      if (form.status !== STATUS.pending) {
        sendHtml(response, 410, renderNotice(noticeFor(form.status, form.kind), undefined, { locale }));
        return;
      }
      await handleFormPost(request, response, form, actionPath, locale);
      return;
    }

    const share = shares?.lookup(token);
    if (share === undefined) {
      sendHtml(response, 404, renderNotice('unknown', undefined, { locale }));
      return;
    }
    if (method !== 'POST') {
      if (share.status !== SHARE_STATUS.pending) {
        sendHtml(response, 200, renderNotice(noticeForShare(share.status), undefined, { locale }), { head: method === 'HEAD' });
        return;
      }
      shares.countView(share);
      sendHtml(response, 200, sharePageFor(share, actionPath, locale), { head: method === 'HEAD' });
      return;
    }
    if (share.status !== SHARE_STATUS.pending) {
      sendHtml(response, 410, renderNotice(noticeForShare(share.status), undefined, { locale }));
      return;
    }
    await handleSharePost(request, response, share, actionPath, locale);
  };
}

/**
 * Mount the plugin: routes on the Web GUI host, tools on the agent surface.
 * @param ctx - host context with `tools`, `webServer`, and an `effect` scope.
 * @param config - see {@link normalizeConfig}.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config);
  const logger = resolveLogger(ctx);
  const db = openDatabase(settings.database);
  const forms = createFormStore({ db, defaultTtlSeconds: settings.defaultTtlSeconds });
  const shares = createShareStore({ db, defaultTtlSeconds: settings.defaultTtlSeconds });
  forms.sweep({ retainMs: settings.retainSeconds * 1000 });
  shares.sweep({ retainMs: settings.retainSeconds * 1000 });

  // `schedule` is what actually wakes a session: the service owns the timer and
  // resumes the session itself. It may mount after this plugin does, which is
  // why the notifier asks for it on every attempt instead of capturing it once.
  //
  // Cordis refuses a bare `ctx.schedule` for a service the plugin did not
  // declare in `inject` — the property getter throws — so an optional service is
  // read through `ctx.get`, which answers undefined instead.
  let scheduling = typeof ctx?.get === 'function' ? ctx.get('schedule') : ctx?.schedule;
  let notifier;
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['schedule'], (child) => {
      scheduling = child.schedule;
      void notifier?.kick();
      return () => {
        scheduling = undefined;
      };
    });
  }
  notifier = createNotifier({ db, getSchedule: () => scheduling, language: settings.language, logger });
  void notifier.kick();

  const credentialsOf = () => (typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials);
  const handler = createRouteHandler({ forms, shares, settings, logger, credentialsOf, notifier });
  const route = { kind: 'prefix', path: settings.routePrefix, handler };

  if (typeof ctx?.webServer?.register !== 'function') {
    throw new TypeError('dsh-secret-form: the webServer service is required');
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.webServer.register(route), `dsh-secret-form: ${settings.routePrefix}`);
    ctx.effect(() => () => {
      notifier.stop();
      closeDatabase(db);
    }, 'dsh-secret-form: database');
  } else {
    ctx.webServer.register(route);
  }
  registerTools(ctx, { forms, shares, settings, logger, notifier, ctx });
  logger?.info?.(`ready: ${settings.database}`);
}

export default Object.freeze({ name, inject, apply, normalizeConfig, registerTools, createRouteHandler });
