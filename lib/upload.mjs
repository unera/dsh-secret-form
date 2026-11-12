// File uploads without a framework.
//
// A `kind: "file"` form is the one place where the browser sends
// `multipart/form-data` here, so the parser handles exactly that: one boundary,
// parts made of headers and bytes, no nested encodings, no chunked streaming.
// The body is already bounded by the caller, which is what makes a whole-buffer
// parse acceptable.
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

/** Pull the boundary out of a `multipart/form-data` content type. */
export function boundaryOf(contentType) {
  if (typeof contentType !== 'string') return undefined;
  const [type, ...params] = contentType.split(';');
  if (type.trim().toLowerCase() !== 'multipart/form-data') return undefined;
  for (const param of params) {
    const index = param.indexOf('=');
    if (index === -1) continue;
    if (param.slice(0, index).trim().toLowerCase() !== 'boundary') continue;
    let value = param.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value === '' ? undefined : value;
  }
  return undefined;
}

function parseHeaders(text) {
  // latin1 keeps the bytes of a filename intact for the ASCII case; the
  // RFC 5987 form is decoded below when the browser sends it.
  const headers = {};
  for (const line of text.split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function dispositionParams(value) {
  const params = {};
  for (const part of String(value).split(';').slice(1)) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    let raw = part.slice(index + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    params[key] = raw;
  }
  return params;
}

function decodeExtended(value) {
  // `UTF-8''%D0%B8%D0%BC%D1%8F` — the charset is always UTF-8 in practice.
  const match = /^([^']*)'[^']*'(.*)$/.exec(String(value));
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return undefined;
  }
}

/**
 * Parse a bounded multipart body.
 * @returns `{ fields: Map<string,string>, files: Array<{name, filename, contentType, data}> }`
 */
export function parseMultipart(buffer, boundary) {
  const fields = new Map();
  const files = [];
  if (typeof boundary !== 'string' || boundary === '') return { fields, files };
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(delimiter);
  if (cursor === -1) return { fields, files };
  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    // `--` straight after the delimiter closes the body.
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;
    let end = next;
    if (end - 2 >= start && buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;
    const part = buffer.subarray(start, end);
    const split = part.indexOf(HEADER_END);
    const headerText = (split === -1 ? part : part.subarray(0, split)).toString('utf8');
    const data = split === -1 ? Buffer.alloc(0) : part.subarray(split + HEADER_END.length);
    const headers = parseHeaders(headerText);
    const disposition = headers['content-disposition'];
    if (typeof disposition === 'string') {
      const params = dispositionParams(disposition);
      const name = params.name;
      if (name !== undefined) {
        if (params.filename !== undefined || params['filename*'] !== undefined) {
          const filename = params['filename*'] !== undefined
            ? (decodeExtended(params['filename*']) ?? params.filename ?? '')
            : params.filename;
          files.push({ name, filename, contentType: headers['content-type'], data: Buffer.from(data) });
        } else {
          fields.set(name, data.toString('utf8'));
        }
      }
    }
    cursor = next;
  }
  return { fields, files };
}

/**
 * Reduce a browser-supplied file name to something safe to create in a
 * directory the model chose.
 */
export function safeFileName(name, fallback = 'upload.bin') {
  let text = String(name ?? '');
  // Some browsers (and every Windows one) send a full path.
  text = text.split(/[\\/]/).pop() ?? '';
  text = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (text === '' || text === '.' || text === '..') return fallback;
  if (text.length > 200) text = text.slice(0, 200);
  return text;
}

/** Validate the `upload.dir` of a file form: an absolute directory path. */
export function normalizeUploadDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('upload.dir must be a non-empty string');
  if (dir.includes('\0')) throw new TypeError('upload.dir must not contain a NUL byte');
  if (!isAbsolute(dir)) throw new TypeError(`upload.dir must be an absolute path, got ${JSON.stringify(dir)}`);
  return resolve(dir);
}

// A half-received file is worse than a failed form: write beside the target,
// flush, then rename over it in one step.
async function writeAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.${basename(file)}.${Date.now().toString(36)}.part`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  await chmod(file, 0o600);
}

/**
 * Store an uploaded part inside the directory the form was created with.
 * @param input - `dir`, the requested `name` (optional), and the received bytes.
 * @returns facts about the stored file, never its content.
 */
export async function saveUpload({ dir, name, data }) {
  const root = normalizeUploadDir(dir);
  const fileName = safeFileName(name, 'upload.bin');
  const path = join(root, fileName);
  const resolved = resolve(path);
  // `safeFileName` already drops separators, but a resolved-path check is the
  // one that actually bounds the write.
  if (resolved !== path || !resolved.startsWith(`${root}${sep}`)) {
    throw new TypeError(`upload name ${JSON.stringify(name)} escapes ${root}`);
  }
  await writeAtomic(resolved, data);
  return {
    path: resolved,
    fileName,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}
