// A host stub: the same `apply()` a real profile runs, wired to captured
// registrations instead of a live Cordis tree and a listening socket.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { apply } from '../index.mjs';

// A host's database has to outlive the host for the restart tests, so the
// temporary directories are removed once, when the test process ends.
const cleanupDirs = [];
process.on('exit', () => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function createResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
  };
  response.writeHead = (status, headers) => {
    response.statusCode = status;
    response.headers = headers ?? {};
  };
  response.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      response.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }
    response.ended = true;
  };
  return response;
}

/** A schedule-service stub: it records the reminders a note turns into. */
/**
 * The schedule service as the core offers it.
 *
 * `api: 'typed'` is the 0.2.2 shape — one request carrying a timing selector and
 * a target; `api: 'legacy'` is the flat `(sessionId, { after_seconds })` of the
 * older core. The fake refuses the shape it does not speak, the way the real
 * service does, because a fake that accepts anything hides this breakage.
 */
export function createSchedule({ api = 'typed' } = {}) {
  const calls = [];
  return {
    calls,
    async create(first, second) {
      const typed = api === 'typed';
      if (typed !== (typeof first === 'object' && first !== null)) {
        throw new Error('invalid_rule: timing must contain exactly kind and its matching selector.');
      }
      if (typed) {
        if (first.timing?.kind !== 'after') {
          throw new Error('invalid_rule: timing must contain exactly kind and its matching selector.');
        }
        calls.push({ sessionId: first.target?.sessionId, request: first, timing: first.timing });
        return;
      }
      calls.push({ sessionId: first, request: second, timing: { kind: 'after', after_seconds: second.after_seconds } });
    },
  };
}

/**
 * Mount the plugin against a stub context.
 * @param options - `config`, a credentials stub, a schedule stub, and the origin
 *   to report. Every host gets its own SQLite file in a temporary directory, so
 *   one test can never read another one's forms.
 */
export function createHost({ config, credentials, schedule, origin = 'http://127.0.0.1:3080' } = {}) {
  const tools = new Map();
  const writes = [];
  const warnings = [];
  let route;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-secret-form-test-'));
  cleanupDirs.push(dir);
  // A test that wants a restart hands the same file to a second host.
  const database = typeof config?.database === 'string' ? config.database : join(dir, 'store.sqlite');
  const store = credentials ?? {
    async set(ref, value) {
      writes.push([ref, value]);
    },
  };
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    webServer: {
      register(registered) {
        route = registered.handler;
        return () => {
          route = undefined;
        };
      },
      getOrigin: () => origin,
    },
    credentials: store,
    logger: {
      info: () => {},
      warn: (message) => warnings.push(message),
    },
    effect: (fn) => fn(),
    ...(schedule === undefined ? {} : { schedule }),
  };
  apply(ctx, { ...config, database });
  return {
    ctx,
    tools,
    writes,
    warnings,
    dir,
    schedule,
    database,
    route: () => route,
    call: (name, args = {}) => tools.get(name).execute(args, {}),
    callAs: (sessionId, name, args = {}) => tools.get(name).execute(args, { agent: { session: { id: sessionId } } }),
    /**
     * Retire this host. The database file stays where it is: a restart test
     * mounts a second host on it, and the temporary directory is removed when
     * the test process ends.
     */
    close: () => {},
  };
}

async function send(host, url, { method, body, contentType, headers = {}, chunks } = {}) {
  const route = host.route();
  if (route === undefined) throw new Error('no route registered');
  const payload = chunks ?? (body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  const request = Readable.from(payload);
  request.method = method;
  // The query string matters: `?lang=` is one of the ways a locale is chosen.
  const parsed = new URL(url, 'http://127.0.0.1');
  request.url = `${parsed.pathname}${parsed.search}`;
  request.headers = { ...headers };
  if (contentType !== undefined) request.headers['content-type'] = contentType;
  const response = createResponse();
  await route(request, response);
  return response;
}

/** Submit the form at `url` as the browser would. */
export function post(host, url, fields, { headers } = {}) {
  return send(host, url, {
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    contentType: 'application/x-www-form-urlencoded',
    headers,
  });
}

/**
 * Post a multipart body, the way a browser submits a file form.
 * @param files - `[{ name, filename, data }]`, `data` being a Buffer or a string.
 */
export function postMultipart(host, url, { fields = {}, files = [] } = {}, { headers } = {}) {
  const boundary = `----dshsecretform${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
    ));
    parts.push(data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return send(host, url, {
    method: 'POST',
    chunks: parts,
    contentType: `multipart/form-data; boundary=${boundary}`,
    headers,
  });
}

/**
 * Open the page at `url`.
 * @param options - request headers, or a method name for the older call shape.
 */
export function get(host, url, options = {}) {
  const { method = 'GET', headers } = typeof options === 'string' ? { method: options } : options;
  return send(host, url, { method, headers });
}
