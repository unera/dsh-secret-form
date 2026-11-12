// The outbound half: a secret the model hands to the human.
//
// The link may be opened any number of times — a link that stops working
// because the browser refreshed is worse than useless — but the reveal button
// works exactly once. The value is written encrypted with a one-shot AES-256-GCM
// key that lives in its own row; revealing reads both rows, hands the value to
// the one page, and deletes them. Expiry and cancellation delete them too, so
// after the link is spent there is nothing left on disk to decrypt.
//
// The key next to the ciphertext protects a copy of the database that left the
// machine with only one of the two rows in it, or a single row surviving a crash
// mid-delete. It is not a defence against someone who can read both rows while
// the link is still open — that person owns the host anyway.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

import {
  MAX_TTL_SECONDS,
  clampTtl,
  hashToken,
  normalizeData,
  normalizeDescription,
  normalizeLabel,
} from './forms.mjs';

export const SHARE_STATUS = Object.freeze({
  pending: 'pending',
  revealed: 'revealed',
  cancelled: 'cancelled',
  expired: 'expired',
});

export const SHARE_ALG = 'aes-256-gcm';
export const SHARE_KINDS = Object.freeze(['single', 'multi']);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'secret-share-invalid';
  return error;
}

function normalizeShareKind(kind) {
  if (!SHARE_KINDS.includes(kind)) throw invalid(`kind must be one of: ${SHARE_KINDS.join(', ')}`);
  return kind;
}

/** Encrypt one value; the key is returned separately so it can get its own row. */
export function sealValue(value) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv(SHARE_ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return {
    alg: SHARE_ALG,
    key: key.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypt a sealed value; a missing or tampered part throws. */
export function openValue({ alg, key, iv, tag, ciphertext }) {
  if (alg !== SHARE_ALG) throw new Error(`unsupported cipher ${String(alg)}`);
  const decipher = createDecipheriv(SHARE_ALG, Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function parseJson(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToShare(row) {
  return {
    uuid: row.uuid,
    label: row.label,
    kind: row.kind,
    description: row.description ?? undefined,
    data: parseJson(row.data, {}),
    source: row.source,
    fileName: row.file_name ?? undefined,
    ttlSeconds: row.ttl_seconds,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    views: row.views,
    revealedAt: row.revealed_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    sessionId: row.session_id ?? null,
    notify: row.notify === 1,
    notifiedAt: row.notified_at ?? undefined,
  };
}

/** Project a share into one `secret_list` row. */
export function publicShareSummary(share) {
  return {
    uuid: share.uuid,
    type: 'share',
    label: share.label,
    status: share.status,
    views: share.views,
    createdAt: new Date(share.createdAt).toISOString(),
    expiresAt: new Date(share.expiresAt).toISOString(),
    data: share.data,
  };
}

/** Project a share into the `secret_result` answer. */
export function publicShareResult(share) {
  return {
    type: 'share',
    status: share.status,
    label: share.label,
    views: share.views,
    data: share.data,
    ...(share.revealedAt === undefined ? {} : { revealedAt: new Date(share.revealedAt).toISOString() }),
  };
}

/**
 * Create the outbound registry over an open database.
 * @param options - `db` (opened by lib/db.mjs), `now`, `defaultTtlSeconds`.
 */
export function createShareStore({ db, now = () => Date.now(), defaultTtlSeconds = 300 } = {}) {
  if (db === undefined || typeof db.prepare !== 'function') {
    throw new TypeError('dsh-secret-form: the share store needs an open database');
  }
  const sql = {
    insert: db.prepare(`INSERT INTO share (
      uuid, token_hash, label, kind, description, data, source, file_name,
      ttl_seconds, created_at, expires_at, status, views, session_id, notify
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`),
    insertSecret: db.prepare('INSERT INTO share_secret (uuid, alg, iv, tag, ciphertext) VALUES (?, ?, ?, ?, ?)'),
    insertKey: db.prepare('INSERT INTO share_key (uuid, key) VALUES (?, ?)'),
    byToken: db.prepare('SELECT * FROM share WHERE token_hash = ?'),
    byUuid: db.prepare('SELECT * FROM share WHERE uuid = ?'),
    all: db.prepare('SELECT * FROM share ORDER BY created_at'),
    secret: db.prepare('SELECT * FROM share_secret WHERE uuid = ?'),
    key: db.prepare('SELECT * FROM share_key WHERE uuid = ?'),
    dropSecret: db.prepare('DELETE FROM share_secret WHERE uuid = ?'),
    dropKey: db.prepare('DELETE FROM share_key WHERE uuid = ?'),
    due: db.prepare("UPDATE share SET status = 'expired', finished_at = ? WHERE status = 'pending' AND expires_at <= ?"),
    dueWithSecret: db.prepare("SELECT uuid FROM share WHERE status = 'expired'"),
    purge: db.prepare('DELETE FROM share WHERE status <> ? AND finished_at IS NOT NULL AND finished_at <= ?'),
    view: db.prepare('UPDATE share SET views = views + 1 WHERE uuid = ?'),
    reveal: db.prepare("UPDATE share SET status = 'revealed', revealed_at = ?, finished_at = ? WHERE uuid = ? AND status = 'pending'"),
    cancel: db.prepare("UPDATE share SET status = 'cancelled', finished_at = ? WHERE uuid = ? AND status = 'pending'"),
    notified: db.prepare('UPDATE share SET notified_at = ? WHERE uuid = ?'),
  };

  const dropMaterial = (uuid) => {
    sql.dropSecret.run(uuid);
    sql.dropKey.run(uuid);
  };

  const expireIfDue = (share) => {
    if (share.status !== SHARE_STATUS.pending) return share;
    if (now() < share.expiresAt) return share;
    const at = now();
    db.prepare("UPDATE share SET status = 'expired', finished_at = ? WHERE uuid = ? AND status = 'pending'").run(at, share.uuid);
    dropMaterial(share.uuid);
    share.status = SHARE_STATUS.expired;
    share.finishedAt = at;
    return share;
  };

  const store = {
    /**
     * Create a pending share. `value` is sealed here and never kept in memory.
     * @returns the share with its plain token, for the caller to build the link.
     */
    create(spec) {
      const createdAt = now();
      const ttlSeconds = clampTtl(spec.ttlSeconds, defaultTtlSeconds);
      const token = randomBytes(32).toString('base64url');
      const share = {
        uuid: randomUUID(),
        token,
        label: normalizeLabel(spec.label),
        kind: normalizeShareKind(spec.kind),
        description: normalizeDescription(spec.description),
        data: normalizeData(spec.data),
        source: typeof spec.source === 'string' ? spec.source : 'file',
        fileName: typeof spec.fileName === 'string' && spec.fileName !== '' ? spec.fileName : undefined,
        ttlSeconds,
        createdAt,
        expiresAt: createdAt + ttlSeconds * 1000,
        status: SHARE_STATUS.pending,
        views: 0,
        sessionId: typeof spec.sessionId === 'string' && spec.sessionId !== '' ? spec.sessionId : null,
        notify: spec.notify === true,
      };
      if (share.expiresAt - createdAt > MAX_TTL_SECONDS * 1000) throw invalid('ttlSeconds is out of range');
      const sealed = sealValue(spec.value);
      sql.insert.run(
        share.uuid,
        hashToken(token),
        share.label,
        share.kind,
        share.description ?? null,
        JSON.stringify(share.data),
        share.source,
        share.fileName ?? null,
        share.ttlSeconds,
        share.createdAt,
        share.expiresAt,
        share.sessionId,
        share.notify ? 1 : 0,
      );
      sql.insertSecret.run(share.uuid, sealed.alg, sealed.iv, sealed.tag, sealed.ciphertext);
      sql.insertKey.run(share.uuid, sealed.key);
      return share;
    },

    /** Resolve a link token, expiring it first when its window has passed. */
    lookup(token) {
      if (typeof token !== 'string' || token === '') return undefined;
      const row = sql.byToken.get(hashToken(token));
      if (row === undefined) return undefined;
      return expireIfDue(rowToShare(row));
    },

    /** Resolve a share by the uuid the model holds. */
    require(uuid) {
      const row = typeof uuid === 'string' ? sql.byUuid.get(uuid) : undefined;
      if (row === undefined) throw invalid(`unknown secret link ${JSON.stringify(uuid ?? null)}`);
      return expireIfDue(rowToShare(row));
    },

    /** Every share the database still holds, oldest first. */
    list() {
      store.sweep();
      return sql.all.all().map(rowToShare);
    },

    /** Count one page open. Cheap, and it tells the model whether anyone looked. */
    countView(share) {
      if (share.status !== SHARE_STATUS.pending) return share;
      sql.view.run(share.uuid);
      share.views += 1;
      return share;
    },

    /**
     * Burn the link and hand the value to the one page that asked for it.
     * @returns `{ status, value }`; `value` is present only on a successful reveal.
     */
    reveal(share) {
      expireIfDue(share);
      if (share.status !== SHARE_STATUS.pending) return { status: share.status };
      const at = now();
      const changed = sql.reveal.run(at, at, share.uuid);
      if (changed.changes !== 1) return { status: store.require(share.uuid).status };
      share.status = SHARE_STATUS.revealed;
      share.revealedAt = at;
      share.finishedAt = at;
      const secretRow = sql.secret.get(share.uuid);
      const keyRow = sql.key.get(share.uuid);
      dropMaterial(share.uuid);
      if (secretRow === undefined || keyRow === undefined) {
        throw new Error('the sealed value is missing: it was already revealed or removed');
      }
      return {
        status: SHARE_STATUS.revealed,
        value: openValue({ ...secretRow, key: keyRow.key }),
      };
    },

    /** Cancel a pending share; a finished one reports its current status. */
    cancel(share) {
      expireIfDue(share);
      if (share.status !== SHARE_STATUS.pending) return share;
      const at = now();
      sql.cancel.run(at, share.uuid);
      dropMaterial(share.uuid);
      share.status = SHARE_STATUS.cancelled;
      share.finishedAt = at;
      return share;
    },

    /** Record that the note about this share was delivered. */
    markNotified(share, at = now()) {
      share.notifiedAt = at;
      sql.notified.run(at, share.uuid);
      return share;
    },

    /** Expire overdue shares and drop finished ones past their retention. */
    sweep({ retainMs = 3_600_000 } = {}) {
      const at = now();
      sql.due.run(at, at);
      // A share that expired while the process was down still has its sealed
      // rows: tear them down now rather than waiting for the purge.
      for (const row of sql.dueWithSecret.all()) {
        if (sql.secret.get(row.uuid) !== undefined || sql.key.get(row.uuid) !== undefined) dropMaterial(row.uuid);
      }
      sql.purge.run(SHARE_STATUS.pending, at - retainMs);
      return store;
    },

    get size() {
      return db.prepare('SELECT COUNT(*) AS n FROM share').get().n;
    },
  };
  return store;
}
