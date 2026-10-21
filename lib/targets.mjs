// Where a submitted secret lands.
//
// Two targets: the host credential store (the default, the same one an adapter
// reads through `apiKeyEnv`) and a document file inside this machine's
// filesystem. Both refuse rather than guess — an unknown extension, an
// unparseable document, or a path that would overwrite a non-string value is a
// validation error, never a best effort.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { parseYamlMapping, setYamlPath, stringifyYamlMapping } from './yaml.mjs';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORMAT_BY_EXTENSION = Object.freeze({
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.env': 'env',
});
// Dotted paths are also assignment targets, so a segment that reaches a
// prototype would be a cheap way to poison the process.
const UNSAFE_SEGMENT = new Set(['__proto__', 'prototype', 'constructor']);
const DOTENV_PLAIN = /^[A-Za-z0-9_@%+:,./~-]+$/;

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'secret-form-target-invalid';
  return error;
}

/**
 * Validate and normalise the `save` argument of `secret_create`.
 * @param save - the model's `save` value, or undefined for the default target.
 * @returns `{ kind: 'credentials' }` or `{ kind: 'file', path, format, given }`.
 */
export function normalizeTarget(save) {
  if (save === undefined || save === null) return { kind: 'credentials' };
  if (typeof save !== 'object' || Array.isArray(save)) throw invalid('save must be an object');
  if (save.kind === 'credentials') return { kind: 'credentials' };
  if (save.kind !== 'file') {
    throw invalid(`save.kind must be "credentials" or "file", got ${JSON.stringify(save.kind ?? null)}`);
  }
  if (typeof save.path !== 'string' || save.path.trim() === '') {
    throw invalid('save.path must be a non-empty string for a file target');
  }
  if (save.path.includes('\0')) throw invalid('save.path must not contain a NUL byte');
  const extension = extname(save.path).toLowerCase();
  const format = FORMAT_BY_EXTENSION[extension];
  if (format === undefined) {
    throw invalid(`save.path must end in .yaml, .yml, .json or .env, got ${JSON.stringify(extension || save.path)}`);
  }
  return { kind: 'file', path: resolve(save.path), format, given: save.path };
}

/**
 * Validate `ref` against the target's grammar.
 * @param target - normalised target.
 * @param ref - the model's `ref`.
 * @returns the trimmed ref.
 */
export function assertRefForTarget(target, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') throw invalid('ref must be a non-empty string');
  const text = ref.trim();
  if (target.kind === 'credentials') {
    if (!ENV_KEY.test(text)) {
      throw invalid(`ref ${JSON.stringify(text)} must be a credential reference such as OPENAI_API_KEY`);
    }
    return text;
  }
  if (target.format === 'env') {
    if (!ENV_KEY.test(text)) {
      throw invalid(`ref ${JSON.stringify(text)} must be a variable name such as OPENAI_API_KEY inside a .env file`);
    }
    return text;
  }
  const segments = text.split('.');
  if (segments.length > 1 && segments.some((segment) => segment === '')) {
    throw invalid(`ref ${JSON.stringify(text)} has an empty dotted path segment`);
  }
  for (const segment of segments) {
    if (/\s/.test(segment)) throw invalid(`ref ${JSON.stringify(text)} has whitespace inside a path segment`);
    if (UNSAFE_SEGMENT.has(segment)) throw invalid(`ref ${JSON.stringify(text)} names a prototype member, which is refused`);
  }
  return text;
}

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// A half-written credentials document is worse than a failed form: write beside
// the target, flush it, then rename over it in one step.
async function writeAtomic(file, text) {
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  // The rename carries the temp file's mode, but an existing target may have
  // been group- or world-readable before; the secret is not.
  await chmod(file, 0o600);
}

function dotenvValue(value) {
  if (value === '') return '';
  if (DOTENV_PLAIN.test(value)) return value;
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
  return `"${escaped}"`;
}

function upsertEnvLine(existing, ref, value) {
  const text = existing ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${ref}\\s*=`);
  const line = `${ref}=${dotenvValue(value)}`;
  const index = lines.findIndex((entry) => pattern.test(entry));
  if (index >= 0) lines[index] = line;
  else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(line);
  }
  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

function setDocumentPath(document, segments, value, source) {
  let node = document;
  for (const segment of segments.slice(0, -1)) {
    const current = node[segment];
    if (current === undefined) {
      const created = {};
      node[segment] = created;
      node = created;
      continue;
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw invalid(`${source} already holds a non-object at "${segment}"; refusing to replace it`);
    }
    node = current;
  }
  const last = segments[segments.length - 1];
  const current = node[last];
  if (current !== undefined && typeof current === 'object' && current !== null) {
    throw invalid(`${source} already holds a nested value at "${last}"; refusing to replace it`);
  }
  node[last] = value;
}

function rewriteJson(existing, file, ref, value) {
  let document = {};
  const text = (existing ?? '').trim();
  if (text !== '') {
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw invalid(`${file} is not valid JSON (${error.message}); refusing to rewrite it`);
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      throw invalid(`${file} does not hold a JSON object; refusing to rewrite it`);
    }
  }
  setDocumentPath(document, ref.split('.'), value, file);
  return `${JSON.stringify(document, null, 2)}\n`;
}

function rewriteYaml(existing, file, ref, value) {
  const root = (existing ?? '').trim() === ''
    ? { type: 'map', entries: [] }
    : parseYamlMapping(existing, file);
  setYamlPath(root, ref.split('.'), value, file);
  return stringifyYamlMapping(root);
}

/**
 * Store a submitted value.
 * @param target - normalised target.
 * @param ref - validated ref.
 * @param value - normalised submitted value; may be empty only for a file target.
 * @param options - `credentials` is the host service, read lazily by the caller.
 */
export async function writeSecret(target, ref, value, { credentials } = {}) {
  if (target.kind === 'credentials') {
    // The credential store refuses an empty value, and an empty submit is
    // reported as `empty`: there is nothing to store.
    if (value === '') return;
    if (credentials === undefined || typeof credentials.set !== 'function') {
      throw new Error('dsh-secret-form: the credentials service is not mounted in this host; use save { kind: "file", path } instead');
    }
    await credentials.set(ref, value);
    return;
  }
  const file = target.path;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const existing = await readTextIfExists(file);
  const text = target.format === 'env'
    ? upsertEnvLine(existing, ref, value)
    : target.format === 'json'
      ? rewriteJson(existing, file, ref, value)
      : rewriteYaml(existing, file, ref, value);
  await writeAtomic(file, text);
}
