// The inbound form registry.
//
// A form is a request for a value: the model creates one, the human opens the
// link and either types the value (`single`, `multi`) or picks a file (`file`).
// The registry owns the state machine and the validation; it stores rows in the
// plugin database (see lib/db.mjs) and never stores the value itself — the
// caller writes that to its target and reports back the aggregate facts.
//
// Tokens are stored as SHA-256 hashes: the token is the capability, and a copy
// of the database must not hand it out.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const STATUS = Object.freeze({
  pending: 'pending',
  saved: 'saved',
  empty: 'empty',
  cancelled: 'cancelled',
  expired: 'expired',
});

export const MIN_TTL_SECONDS = 30;
export const MAX_TTL_SECONDS = 3600;
export const DEFAULT_TTL_SECONDS = 300;
export const DEFAULT_WAIT_SECONDS = 0;
export const MAX_WAIT_SECONDS = 30;
export const MAX_DATA_BYTES = 1024;
export const MAX_DESCRIPTION_CHARS = 300;
export const KINDS = Object.freeze(['single', 'multi', 'file']);

// A finished form keeps answering its link ("already used", "cancelled") for an
// hour past expiry; after that a sweep drops it and the link reads as unknown.
export const RETAIN_MS = 3_600_000;

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'secret-form-invalid';
  return error;
}

/** SHA-256 of a link token, hex. The only form in which a token is persisted. */
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Clamp a TTL into the supported window.
 * @param seconds - requested TTL; undefined takes the default.
 * @param fallback - configured default TTL.
 * @returns whole seconds within 30..3600.
 */
export function clampTtl(seconds, fallback = DEFAULT_TTL_SECONDS) {
  const wanted = seconds === undefined || seconds === null ? fallback : seconds;
  if (typeof wanted !== 'number' || !Number.isFinite(wanted)) throw invalid('ttlSeconds must be a number');
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(wanted)));
}

/** Validate the `waitSeconds` argument of `secret_result`. */
export function normalizeWait(seconds) {
  if (seconds === undefined || seconds === null) return DEFAULT_WAIT_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS) {
    throw invalid(`waitSeconds must be an integer from 0 to ${MAX_WAIT_SECONDS}`);
  }
  return seconds;
}

/** Validate the `data` bookkeeping object of `secret_create` and `secret_share`. */
export function normalizeData(data) {
  if (data === undefined || data === null) return {};
  if (typeof data !== 'object' || Array.isArray(data)) throw invalid('data must be a JSON object');
  const clone = structuredClone(data);
  let serialised;
  try {
    serialised = JSON.stringify(clone);
  } catch {
    throw invalid('data must be JSON-serialisable');
  }
  if (serialised === undefined) throw invalid('data must be JSON-serialisable');
  if (Buffer.byteLength(serialised, 'utf8') > MAX_DATA_BYTES) {
    throw invalid(`data must serialise to at most ${MAX_DATA_BYTES} bytes`);
  }
  return clone;
}

function normalizeExpect(expect) {
  if (expect === undefined || expect === null || expect === '') return undefined;
  if (typeof expect !== 'string') throw invalid('expect must be a string holding a regular expression');
  try {
    return new RegExp(expect);
  } catch (error) {
    throw invalid(`expect is not a valid regular expression: ${error.message}`);
  }
}

/** Validate the form title. */
export function normalizeLabel(label) {
  if (typeof label !== 'string') throw invalid('label must be a string');
  const text = label.trim();
  if (text === '') throw invalid('label must not be empty');
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > 5) throw invalid('label must be 2 to 5 words');
  if (text.length > 120) throw invalid('label must be at most 120 characters');
  return text;
}

/** Validate the optional sentence under the title. */
export function normalizeDescription(description) {
  if (description === undefined || description === null) return undefined;
  if (typeof description !== 'string') throw invalid('description must be a string');
  const text = description.trim();
  if (text === '') return undefined;
  if (text.length > MAX_DESCRIPTION_CHARS) {
    throw invalid(`description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
  }
  return text;
}

function normalizeKind(kind) {
  if (!KINDS.includes(kind)) throw invalid(`kind must be one of: ${KINDS.join(', ')}`);
  return kind;
}

/**
 * Trim a submitted value and report what trimming changed.
 * @param raw - the form field exactly as posted.
 * @param kind - 'single' also drops embedded newlines, which a one-line field
 *   cannot express and a pasted key file carries at its end.
 */
export function normalizeSubmission(raw, kind) {
  const text = typeof raw === 'string' ? raw : '';
  const stripped = text.trim();
  const value = kind === 'single' ? stripped.replace(/[\r\n]+/g, '') : stripped;
  return { value, trimmed: stripped !== text };
}

function countLines(value) {
  return value === '' ? 0 : value.split('\n').length;
}

/** Facts about a stored file, as returned to the model. Never its content. */
function fileFacts(file) {
  if (file === undefined || file === null) return {};
  return {
    fileName: file.fileName,
    size: file.size,
    sha256: file.sha256,
    path: file.path,
  };
}

/**
 * Project a form into the aggregate facts the model may see.
 * The value itself never leaves this module.
 */
export function publicResult(form) {
  return {
    type: 'form',
    status: form.status,
    data: form.data,
    ref: form.ref,
    label: form.label,
    ...(form.result === undefined ? {} : {
      length: form.result.length,
      lines: form.result.lines,
      trimmed: form.result.trimmed,
      ...(form.result.matchesExpect === undefined ? {} : { matchesExpect: form.result.matchesExpect }),
      ...(form.kind === 'file' ? fileFacts(form.result.file) : {}),
    }),
  };
}

/** Project a form into one `secret_list` row. */
export function publicSummary(form) {
  return {
    uuid: form.uuid,
    type: 'form',
    ref: form.ref,
    label: form.label,
    status: form.status,
    createdAt: new Date(form.createdAt).toISOString(),
    expiresAt: new Date(form.expiresAt).toISOString(),
    data: form.data,
  };
}

function parseJson(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToForm(row) {
  return {
    uuid: row.uuid,
    ref: row.ref,
    label: row.label,
    kind: row.kind,
    description: row.description ?? undefined,
    target: parseJson(row.target, { kind: 'credentials' }),
    allowEmpty: row.allow_empty === 1,
    expectSource: row.expect ?? undefined,
    data: parseJson(row.data, {}),
    ttlSeconds: row.ttl_seconds,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    busy: row.busy === 1,
    finishedAt: row.finished_at ?? undefined,
    result: parseJson(row.result, undefined),
    sessionId: row.session_id ?? null,
    notify: row.notify === 1,
    notifiedAt: row.notified_at ?? undefined,
  };
}

/**
 * Create the form registry over an open database.
 * @param options - `db` (opened by lib/db.mjs), `now`, `defaultTtlSeconds`.
 */
export function createFormStore({ db, now = () => Date.now(), defaultTtlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (db === undefined || typeof db.prepare !== 'function') {
    throw new TypeError('dsh-secret-form: the form store needs an open database');
  }
  const sql = {
    insert: db.prepare(`INSERT INTO form (
      uuid, token_hash, ref, label, kind, description, target, allow_empty, expect, data,
      ttl_seconds, created_at, expires_at, status, busy, session_id, notify
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`),
    byToken: db.prepare('SELECT * FROM form WHERE token_hash = ?'),
    byUuid: db.prepare('SELECT * FROM form WHERE uuid = ?'),
    all: db.prepare('SELECT * FROM form ORDER BY created_at'),
    due: db.prepare("UPDATE form SET status = 'expired', finished_at = ?, busy = 0 WHERE status = 'pending' AND expires_at <= ?"),
    stale: db.prepare("UPDATE form SET busy = 0 WHERE status = 'pending' AND busy = 1"),
    state: db.prepare('UPDATE form SET status = ?, busy = ?, finished_at = ?, result = ? WHERE uuid = ?'),
    cancelled: db.prepare("UPDATE form SET status = 'cancelled', finished_at = ?, busy = 0 WHERE uuid = ? AND status = 'pending'"),
    notified: db.prepare('UPDATE form SET notified_at = ? WHERE uuid = ?'),
    purge: db.prepare('DELETE FROM form WHERE status <> ? AND finished_at IS NOT NULL AND finished_at <= ?'),
  };

  const waiters = new Map();

  const wake = (uuid) => {
    const set = waiters.get(uuid);
    if (set === undefined) return;
    for (const resume of [...set]) resume();
  };

  const persist = (form) => {
    sql.state.run(
      form.status,
      form.busy ? 1 : 0,
      form.finishedAt ?? null,
      form.result === undefined ? null : JSON.stringify(form.result),
      form.uuid,
    );
  };

  const finish = (form, status, result) => {
    form.status = status;
    form.finishedAt = now();
    form.busy = false;
    if (result !== undefined) form.result = result;
    persist(form);
    wake(form.uuid);
    return form;
  };

  const expireIfDue = (form) => {
    if (form.status !== STATUS.pending) return form;
    if (now() < form.expiresAt) return form;
    return finish(form, STATUS.expired);
  };

  const store = {
    /** Create a pending form; `target` and `ref` are already validated. */
    create(spec) {
      const createdAt = now();
      const ttlSeconds = clampTtl(spec.ttlSeconds, defaultTtlSeconds);
      const token = randomBytes(32).toString('base64url');
      const form = {
        uuid: randomUUID(),
        token,
        ref: spec.ref,
        label: normalizeLabel(spec.label),
        kind: normalizeKind(spec.kind),
        description: normalizeDescription(spec.description),
        target: spec.target,
        allowEmpty: spec.allowEmpty === true,
        expectSource: spec.expect === undefined ? undefined : String(spec.expect),
        data: normalizeData(spec.data),
        ttlSeconds,
        createdAt,
        expiresAt: createdAt + ttlSeconds * 1000,
        status: STATUS.pending,
        finishedAt: undefined,
        result: undefined,
        busy: false,
        sessionId: typeof spec.sessionId === 'string' && spec.sessionId !== '' ? spec.sessionId : null,
        notify: spec.notify === true,
        notifiedAt: undefined,
      };
      if (form.expectSource !== undefined) normalizeExpect(form.expectSource);
      sql.insert.run(
        form.uuid,
        hashToken(token),
        form.ref,
        form.label,
        form.kind,
        form.description ?? null,
        JSON.stringify(form.target),
        form.allowEmpty ? 1 : 0,
        form.expectSource ?? null,
        JSON.stringify(form.data),
        form.ttlSeconds,
        form.createdAt,
        form.expiresAt,
        form.status,
        form.sessionId,
        form.notify ? 1 : 0,
      );
      return form;
    },

    /** Resolve a link token, expiring it first when its window has passed. */
    lookup(token) {
      if (typeof token !== 'string' || token === '') return undefined;
      const row = sql.byToken.get(hashToken(token));
      if (row === undefined) return undefined;
      return expireIfDue(rowToForm(row));
    },

    /** Resolve a form by the uuid the model holds. */
    require(uuid) {
      const row = typeof uuid === 'string' ? sql.byUuid.get(uuid) : undefined;
      if (row === undefined) throw invalid(`unknown secret form ${JSON.stringify(uuid ?? null)}`);
      return expireIfDue(rowToForm(row));
    },

    /** Every form the database still holds, oldest first. */
    list() {
      store.sweep();
      return sql.all.all().map(rowToForm);
    },

    /**
     * Start a text submission. The caller stores the value and then reports the
     * outcome, so a failed write never reads as saved.
     * @returns `{ outcome }` plus the normalised value when `outcome` is `ready`.
     */
    beginSubmit(form, raw) {
      expireIfDue(form);
      if (form.status !== STATUS.pending) return { outcome: 'terminal' };
      if (form.busy) return { outcome: 'busy' };
      const { value, trimmed } = normalizeSubmission(raw, form.kind);
      const facts = {
        value,
        trimmed,
        length: [...value].length,
        lines: countLines(value),
        matchesExpect: form.expectSource === undefined ? undefined : new RegExp(form.expectSource).test(value),
      };
      if (value === '' && !form.allowEmpty) return { outcome: 'invalid', ...facts };
      form.busy = true;
      persist(form);
      return { outcome: 'ready', empty: value === '', ...facts };
    },

    /** Start a file submission: the caller receives the upload and reports facts. */
    beginUpload(form) {
      expireIfDue(form);
      if (form.status !== STATUS.pending) return { outcome: 'terminal' };
      if (form.busy) return { outcome: 'busy' };
      form.busy = true;
      persist(form);
      return { outcome: 'ready' };
    },

    /** Mark a submission finished after the value (or file) reached its target. */
    completeSubmit(form, submission) {
      const file = submission.file === undefined ? undefined : submission.file;
      return finish(form, submission.empty ? STATUS.empty : STATUS.saved, {
        length: file === undefined ? submission.length : 0,
        lines: file === undefined ? submission.lines : 0,
        trimmed: submission.trimmed === true,
        matchesExpect: submission.matchesExpect,
        ...(file === undefined ? {} : { file }),
      });
    },

    /** Return a form to `pending` after the target refused the write. */
    abortSubmit(form) {
      form.busy = false;
      persist(form);
      return form;
    },

    /** Cancel a pending form; a finished form reports its current status. */
    cancel(form) {
      expireIfDue(form);
      if (form.status !== STATUS.pending) return form;
      const at = now();
      sql.cancelled.run(at, form.uuid);
      form.status = STATUS.cancelled;
      form.finishedAt = at;
      form.busy = false;
      wake(form.uuid);
      return form;
    },

    /** Record that the note about this form was delivered. */
    markNotified(form, at = now()) {
      form.notifiedAt = at;
      sql.notified.run(at, form.uuid);
      return form;
    },

    /**
     * Wait for a form to leave `pending`, at most `ms`.
     * @returns the same form, settled or still pending at the deadline.
     */
    async settle(form, ms) {
      expireIfDue(form);
      if (form.status !== STATUS.pending || !(ms > 0)) return form;
      await new Promise((resolve) => {
        const set = waiters.get(form.uuid) ?? new Set();
        waiters.set(form.uuid, set);
        const resume = () => {
          clearTimeout(timer);
          set.delete(resume);
          if (set.size === 0) waiters.delete(form.uuid);
          resolve();
        };
        const timer = setTimeout(resume, ms);
        set.add(resume);
      });
      return store.require(form.uuid);
    },

    /** Expire overdue forms and drop finished ones past their retention. */
    sweep({ retainMs = RETAIN_MS } = {}) {
      const at = now();
      sql.due.run(at, at);
      sql.stale.run();
      sql.purge.run(STATUS.pending, at - retainMs);
      return store;
    },

    get size() {
      return db.prepare('SELECT COUNT(*) AS n FROM form').get().n;
    },
  };
  return store;
}
