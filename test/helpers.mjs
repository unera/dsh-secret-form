// A host stub: the same `apply()` a real profile runs, wired to captured
// registrations instead of a live Cordis tree and a listening socket.
import { Readable } from 'node:stream';

import { apply } from '../index.mjs';

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

/**
 * Mount the plugin against a stub context.
 * @param options - `config`, a credentials stub, and the origin to report.
 */
export function createHost({ config, credentials, origin = 'http://127.0.0.1:3080' } = {}) {
  const tools = new Map();
  const writes = [];
  const warnings = [];
  let route;
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
  };
  apply(ctx, config);
  return {
    ctx,
    tools,
    writes,
    warnings,
    route: () => route,
    call: (name, args = {}) => tools.get(name).execute(args, {}),
  };
}

async function send(host, url, { method, body, contentType }) {
  const route = host.route();
  if (route === undefined) throw new Error('no route registered');
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  request.method = method;
  request.url = new URL(url, 'http://127.0.0.1').pathname;
  request.headers = contentType === undefined ? {} : { 'content-type': contentType };
  const response = createResponse();
  await route(request, response);
  return response;
}

/** Submit the form at `url` as the browser would. */
export function post(host, url, fields) {
  return send(host, url, {
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    contentType: 'application/x-www-form-urlencoded',
  });
}

/** Open the page at `url`. */
export function get(host, url, method = 'GET') {
  return send(host, url, { method });
}
