// One-time secret links for DeepSeek Harness.
//
// The model never receives the secret. It asks for a link, a human opens it and
// types the value into the browser, and the plugin writes it straight into the
// credential store or a document file. The model only learns aggregate facts
// (status, length, line count), because anything it can read ends up in the
// session log, the transcript, and every provider request built from them.
//
// Two HTTP surfaces on the Web GUI host: `GET <prefix>/<token>` renders the
// form and `POST <prefix>/<token>` accepts it as form-urlencoded. The token is
// the credential — single use, swept from memory by TTL.
import {
  MAX_WAIT_SECONDS,
  STATUS,
  clampTtl,
  createFormStore,
  normalizeWait,
  publicResult,
  publicSummary,
} from './lib/forms.mjs';
import { SUPPORTED_LOCALES, format, messagesFor, normalizeLocale, resolveLocale } from './lib/i18n.mjs';
import { renderFormView, renderNotice, sendHtml, sendText } from './lib/page.mjs';
import { assertRefForTarget, normalizeTarget, writeSecret } from './lib/targets.mjs';

export const name = 'dsh-secret-form';
// A form without a page cannot be filled in, and a form without tools cannot be
// requested. `credentials` is resolved lazily: a host that only writes to files
// should not be forced to mount a credential provider.
export const inject = ['tools', 'webServer'];

const DEFAULT_ROUTE_PREFIX = '/secret';
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_LOCALE = 'en';
const MAX_BODY_BYTES = 64 * 1024;

function invalidConfig(message) {
  return new TypeError(`dsh-secret-form: ${message}`);
}

/**
 * Validate the plugin config.
 * @param config - `routePrefix` (default `/secret`), `defaultTtlSeconds`
 *   (default 300, clamped to 30..3600) and `defaultLocale` (default `en`).
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
  return { routePrefix: prefix, defaultTtlSeconds: ttl, publicUrl, defaultLocale };
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

// Only the first eight characters of a token are ever logged: the rest is the
// capability itself.
function tokenTag(token) {
  return typeof token === 'string' ? token.slice(0, 8) : '????????';
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

/**
 * Register the four tools.
 * @param ctx - host context carrying `tools`.
 * @param deps - store, settings, logger, and the lazy credentials lookup.
 */
export function registerTools(ctx, { store, settings, logger }) {
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
    description: 'Open a one-time web link where the human types a secret, instead of pasting it into the chat. Returns the absolute URL to hand over. The value is stored on the host and is never returned to you; call secret_result to learn whether it arrived.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: {
          type: 'string',
          description: 'Key name. With the default credentials target it is the credential reference, such as OPENAI_API_KEY. With a file target it is the path inside the document: ref.OPENAI_API_KEY for yaml/json, a bare key for .env.',
        },
        label: {
          type: 'string',
          description: 'Form title, 2 to 5 words, shown to the human.',
        },
        kind: {
          type: 'string',
          enum: ['single', 'multi'],
          description: 'One-line input (single) or a textarea (multi) for multi-line secrets such as certificates or key files.',
        },
        description: {
          type: 'string',
          description: 'Optional one or two sentences shown under the title, at most 300 characters.',
        },
        save: {
          type: 'object',
          additionalProperties: true,
          description: 'Where the value goes. Default { kind: "credentials" }. A file target is { kind: "file", path } where the extension picks the format: .yaml, .yml, .json or .env.',
        },
        ttlSeconds: {
          type: 'integer',
          description: 'How long the link accepts input, 30 to 3600 seconds. Default 300.',
        },
        allowEmpty: {
          type: 'boolean',
          description: 'Accept an empty submission and report it as empty. Default false: the page refuses to submit nothing.',
        },
        expect: {
          type: 'string',
          description: 'Optional regular expression, as text, that the submitted value should match. Reported back as matchesExpect; it never blocks or delays the save.',
        },
        data: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional JSON object, at most 1 KB, of bookkeeping for yourself. Echoed back by every secret tool and never shown on the page.',
        },
      },
      required: ['ref', 'label', 'kind'],
    },
    output: textOutput,
    async execute(args) {
      const target = normalizeTarget(args.save);
      const ref = assertRefForTarget(target, args.ref);
      const form = store.create({
        ref,
        target,
        label: args.label,
        kind: args.kind,
        description: args.description,
        ttlSeconds: args.ttlSeconds,
        allowEmpty: args.allowEmpty,
        expect: args.expect,
        data: args.data,
      });
      const url = `${resolveOrigin(ctx, settings)}${settings.routePrefix}/${form.token}`;
      logger?.info?.(`[dsh-secret-form] created ${tokenTag(form.token)} for ${ref}`);
      return {
        uuid: form.uuid,
        url,
        expiresAt: new Date(form.expiresAt).toISOString(),
        data: form.data,
      };
    },
  });

  tools.register({
    name: 'secret_result',
    description: 'Check a form created by secret_create. Never returns the value: only its status, length, line count, whether surrounding whitespace was stripped, and whether it matched expect. With waitSeconds above zero it waits for the human, then returns what it has.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uuid: { type: 'string', description: 'The uuid returned by secret_create.' },
        waitSeconds: {
          type: 'integer',
          description: `How long to wait for the form to leave pending, 0 to ${MAX_WAIT_SECONDS} seconds. Default 0.`,
        },
      },
      required: ['uuid'],
    },
    output: textOutput,
    async execute(args) {
      const form = store.require(args.uuid);
      const waitSeconds = normalizeWait(args.waitSeconds);
      const settled = await store.settle(form, waitSeconds * 1000);
      return publicResult(settled);
    },
  });

  tools.register({
    name: 'secret_list',
    description: 'List every secret form this process created, oldest first, with its status and the data booked at creation. Never includes submitted values.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: listOutput,
    execute() {
      return store.list().map(publicSummary);
    },
  });

  tools.register({
    name: 'secret_cancel',
    description: 'Cancel a pending secret form so its link stops accepting input. Cancelling a form that already finished reports its current status and changes nothing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uuid: { type: 'string', description: 'The uuid returned by secret_create.' },
      },
      required: ['uuid'],
    },
    output: textOutput,
    async execute(args) {
      const form = store.cancel(store.require(args.uuid));
      logger?.info?.(`[dsh-secret-form] cancelled ${form.uuid}`);
      return publicResult(form);
    },
  });
}

function noticeFor(status) {
  return status === STATUS.saved || status === STATUS.empty ? 'used' : status;
}

async function readFormBody(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new Error('payload too large');
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      const error = new Error('payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks, length).toString('utf8'));
}

function isFormPost(request) {
  const type = request.headers['content-type'];
  if (typeof type !== 'string') return false;
  return type.split(';', 1)[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

/**
 * Build the HTTP handler for the route prefix.
 * @param deps - store, settings, logger, credentials lookup, and the clock.
 */
export function createRouteHandler({ store, settings, logger, credentialsOf, now = Date.now }) {
  const { routePrefix } = settings;

  const pageFor = (form, locale, extra = {}) => renderFormView(form, {
    actionPath: `${routePrefix}/${form.token}`,
    remainingSeconds: Math.max(0, Math.round((form.expiresAt - now()) / 1000)),
    locale,
    ...extra,
  });

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
    const method = String(request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      sendText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
      return;
    }

    // A link the model pinned with `?lang=` keeps that language for the whole
    // exchange: the form carries it in a hidden field that outranks the header.
    let locale = localeFor(query.get('lang') ?? undefined);

    const form = store.lookup(token);
    if (form === undefined) {
      sendHtml(response, 404, renderNotice('unknown', undefined, { locale }));
      return;
    }

    if (method !== 'POST') {
      if (form.status !== STATUS.pending) {
        sendHtml(response, 200, renderNotice(noticeFor(form.status), undefined, { locale }), { head: method === 'HEAD' });
        return;
      }
      sendHtml(response, 200, pageFor(form, locale), { head: method === 'HEAD' });
      return;
    }

    if (form.status !== STATUS.pending) {
      sendHtml(response, 410, renderNotice(noticeFor(form.status), undefined, { locale }));
      return;
    }
    if (!isFormPost(request)) {
      sendText(response, 415, 'Expected application/x-www-form-urlencoded');
      return;
    }

    let body;
    try {
      body = await readFormBody(request);
    } catch (error) {
      sendText(response, error.status ?? 400, error.message);
      return;
    }

    // The hidden field wins over the header: it is what the reader actually saw.
    locale = localeFor(body.get('lang') ?? query.get('lang') ?? undefined);
    const messages = messagesFor(locale);

    const action = body.get('action');
    if (action === 'cancel') {
      store.cancel(form);
      logger?.info?.(`[dsh-secret-form] cancelled ${tokenTag(token)}`);
      sendHtml(response, 200, renderNotice('cancelled', undefined, { locale }));
      return;
    }
    if (action !== 'save') {
      sendHtml(response, 400, pageFor(form, locale, { error: messages.errors.action }));
      return;
    }

    const submission = store.beginSubmit(form, body.get('value') ?? '');
    if (submission.outcome === 'invalid') {
      sendHtml(response, 422, pageFor(form, locale, { error: messages.errors.empty }));
      return;
    }
    if (submission.outcome === 'busy') {
      sendHtml(response, 409, pageFor(form, locale, { error: messages.errors.busy }));
      return;
    }
    if (submission.outcome !== 'ready') {
      sendHtml(response, 410, renderNotice(noticeFor(form.status), undefined, { locale }));
      return;
    }

    try {
      await writeSecret(form.target, form.ref, submission.value, { credentials: credentialsOf() });
    } catch (error) {
      store.abortSubmit(form);
      logger?.warn?.(`[dsh-secret-form] ${tokenTag(token)} could not be stored: ${error.message}`);
      const detail = String(error.message).slice(0, 300);
      sendHtml(response, 500, pageFor(form, locale, { error: format(messages.errors.store, { detail }) }));
      return;
    }

    store.completeSubmit(form, submission);
    logger?.info?.(`[dsh-secret-form] ${tokenTag(token)} ${form.status}`);
    const note = submission.matchesExpect === false ? messages.mismatchNote : undefined;
    sendHtml(response, 200, renderNotice(submission.empty ? 'empty' : 'saved', note, { locale }));
  };
}

/**
 * Mount the plugin: routes on the Web GUI host, tools on the agent surface.
 * @param ctx - host context with `tools`, `webServer`, and an `effect` scope.
 * @param config - see {@link normalizeConfig}.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config);
  const store = createFormStore({ defaultTtlSeconds: settings.defaultTtlSeconds });
  const logger = resolveLogger(ctx);
  const credentialsOf = () => (typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials);
  const handler = createRouteHandler({ store, settings, logger, credentialsOf });
  const route = { kind: 'prefix', path: settings.routePrefix, handler };

  if (typeof ctx?.webServer?.register !== 'function') {
    throw new TypeError('dsh-secret-form: the webServer service is required');
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.webServer.register(route), `dsh-secret-form: ${settings.routePrefix}`);
  } else {
    ctx.webServer.register(route);
  }
  registerTools(ctx, { store, settings, logger });
}

export default Object.freeze({ name, inject, apply, normalizeConfig });
