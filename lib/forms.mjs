// The pending-form registry.
//
// Everything lives in this process's memory: a restart makes every form
// `expired`, which is the accepted trade for never writing a one-time token to
// disk. The registry knows nothing about HTTP or files — it validates the
// request, decides the state machine, and hands the submitted value to the
// caller so the caller can store it.
import { randomBytes, randomUUID } from 'node:crypto';

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

// A finished form keeps answering its link ("already used", "cancelled") for an
// hour past expiry; after that a lazy sweep drops it and the link reads as
// unknown.
const RETAIN_MS = 3_600_000;

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'secret-form-invalid';
  return error;
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

function normalizeData(data) {
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
    return { source: expect, regex: new RegExp(expect) };
  } catch (error) {
    throw invalid(`expect is not a valid regular expression: ${error.message}`);
  }
}

function normalizeLabel(label) {
  if (typeof label !== 'string') throw invalid('label must be a string');
  const text = label.trim();
  if (text === '') throw invalid('label must not be empty');
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > 5) throw invalid('label must be 2 to 5 words');
  if (text.length > 120) throw invalid('label must be at most 120 characters');
  return text;
}

function normalizeDescription(description) {
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
  if (kind !== 'single' && kind !== 'multi') throw invalid('kind must be "single" or "multi"');
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

/**
 * Project a form into the aggregate facts the model may see.
 * The value itself never leaves this module.
 */
export function publicResult(form) {
  return {
    status: form.status,
    data: form.data,
    ref: form.ref,
    label: form.label,
    ...(form.result === undefined ? {} : {
      length: form.result.length,
      lines: form.result.lines,
      trimmed: form.result.trimmed,
      ...(form.result.matchesExpect === undefined ? {} : { matchesExpect: form.result.matchesExpect }),
    }),
  };
}

/** Project a form into one `secret_list` row. */
export function publicSummary(form) {
  return {
    uuid: form.uuid,
    ref: form.ref,
    label: form.label,
    status: form.status,
    createdAt: new Date(form.createdAt).toISOString(),
    expiresAt: new Date(form.expiresAt).toISOString(),
    data: form.data,
  };
}

/**
 * Create the in-memory registry.
 * @param options - `now` and `defaultTtlSeconds` are injectable so tests can
 *   move the clock instead of sleeping.
 */
export function createFormStore({ now = () => Date.now(), defaultTtlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const byToken = new Map();
  const byUuid = new Map();

  const finish = (form, status, result) => {
    form.status = status;
    form.finishedAt = now();
    form.busy = false;
    if (result !== undefined) form.result = result;
    for (const wake of [...form.waiters]) wake();
    form.waiters.clear();
  };

  const expireIfDue = (form) => {
    if (form.status !== STATUS.pending) return form;
    if (now() < form.expiresAt) return form;
    finish(form, STATUS.expired);
    return form;
  };

  const store = {
    /** Create a pending form; `target` and `ref` are already validated. */
    create(spec) {
      const createdAt = now();
      const ttlSeconds = clampTtl(spec.ttlSeconds, defaultTtlSeconds);
      const form = {
        uuid: randomUUID(),
        token: randomBytes(32).toString('base64url'),
        ref: spec.ref,
        label: normalizeLabel(spec.label),
        kind: normalizeKind(spec.kind),
        description: normalizeDescription(spec.description),
        target: spec.target,
        allowEmpty: spec.allowEmpty === true,
        expect: normalizeExpect(spec.expect),
        data: normalizeData(spec.data),
        ttlSeconds,
        createdAt,
        expiresAt: createdAt + ttlSeconds * 1000,
        status: STATUS.pending,
        finishedAt: undefined,
        result: undefined,
        busy: false,
        waiters: new Set(),
      };
      byToken.set(form.token, form);
      byUuid.set(form.uuid, form);
      return form;
    },

    /** Resolve a link token, expiring it first when its window has passed. */
    lookup(token) {
      const form = typeof token === 'string' ? byToken.get(token) : undefined;
      if (form === undefined) return undefined;
      return expireIfDue(form);
    },

    /** Resolve a form by the uuid the model holds. */
    require(uuid) {
      const form = typeof uuid === 'string' ? byUuid.get(uuid) : undefined;
      if (form === undefined) throw invalid(`unknown secret form ${JSON.stringify(uuid ?? null)}`);
      return expireIfDue(form);
    },

    /** Every form of this process, oldest first. */
    list() {
      store.sweep();
      return [...byUuid.values()].sort((left, right) => left.createdAt - right.createdAt);
    },

    /**
     * Start a submission. The caller stores the value and then reports the
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
        lines: value === '' ? 0 : value.split('\n').length,
        matchesExpect: form.expect === undefined ? undefined : form.expect.regex.test(value),
      };
      if (value === '' && !form.allowEmpty) return { outcome: 'invalid', ...facts };
      form.busy = true;
      return { outcome: 'ready', empty: value === '', ...facts };
    },

    /** Mark a submission finished after the value reached its target. */
    completeSubmit(form, submission) {
      finish(
        form,
        submission.empty ? STATUS.empty : STATUS.saved,
        {
          length: submission.length,
          lines: submission.lines,
          trimmed: submission.trimmed,
          matchesExpect: submission.matchesExpect,
        },
      );
      return form;
    },

    /** Return a form to `pending` after the target refused the write. */
    abortSubmit(form) {
      form.busy = false;
      return form;
    },

    /** Cancel a pending form; a finished form reports its current status. */
    cancel(form) {
      expireIfDue(form);
      if (form.status === STATUS.pending) finish(form, STATUS.cancelled);
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
        const done = () => {
          clearTimeout(timer);
          form.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        form.waiters.add(done);
      });
      return form;
    },

    /** Expire overdue forms and drop finished ones past their retention. */
    sweep() {
      const at = now();
      for (const [token, form] of byToken) {
        expireIfDue(form);
        if (form.status === STATUS.pending) continue;
        if (form.finishedAt !== undefined && form.finishedAt + RETAIN_MS > at) continue;
        byToken.delete(token);
        byUuid.delete(form.uuid);
      }
      return store;
    },

    get size() {
      return byUuid.size;
    },
  };
  return store;
}
