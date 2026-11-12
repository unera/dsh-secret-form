// The note that wakes the session which created a form.
//
// A form is filled in by a human in a browser, minutes after the model asked
// for it — usually after that session's turn has ended. Leaving the model to
// poll `secret_result` is wasteful and slow, so the plugin places a durable
// one-shot reminder on the session, exactly the way the graceful-restart plugin
// wakes a session after the host comes back:
//
//   schedule.create(sessionId, { title, prompt, after_seconds: 1 })
//
// `ScheduleService` owns the timer, resumes the session itself and retries on
// its own terms. The rows in the `note` table are the outbox: a note survives a
// restart, a session that is not there is retried, and one that can never be
// delivered is dropped with a log line rather than blocking the queue.
const NOTE_KIND = Object.freeze({
  formSaved: 'form-saved',
  formUploaded: 'form-uploaded',
  formCancelled: 'form-cancelled',
  shareRevealed: 'share-revealed',
});

export const NOTE_KINDS = NOTE_KIND;

/** Longest a single note keeps trying before it goes back to the outbox. */
const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_RETRY_MS = 2_000;
/** How many times a note is tried across restarts before it is dropped. */
const MAX_ATTEMPTS = 8;

const DICTS = {
  en: {
    formSaved: {
      title: 'Secret received',
      prompt: 'The secret for "{label}" ({ref}) was saved to {target}. The form uuid={uuid} is closed. Continue the work: secret_result({uuid}) reports the status.',
    },
    formUploaded: {
      title: 'File received',
      prompt: 'The file {fileName} ({size} bytes) for "{label}" was saved to {path}, sha256={sha256}. The form uuid={uuid} is closed. Continue the work.',
    },
    formCancelled: {
      title: 'Form cancelled',
      prompt: 'The human cancelled the form "{label}" ({ref}), uuid={uuid}. Nothing was saved: decide whether a new link or another route is needed.',
    },
    shareRevealed: {
      title: 'Secret collected',
      prompt: 'The secret "{label}" (uuid={uuid}) was shown to the human once; the link is burnt and the key with the ciphertext are deleted. secret_result({uuid}) confirms the state.',
    },
  },
  ru: {
    formSaved: {
      title: 'Секрет получен',
      prompt: 'Секрет для «{label}» ({ref}) сохранён в {target}. Форма uuid={uuid} закрыта. Продолжай работу: secret_result(uuid="{uuid}") покажет статус.',
    },
    formUploaded: {
      title: 'Файл получен',
      prompt: 'Файл {fileName} ({size} байт) для «{label}» сохранён в {path}, sha256={sha256}. Форма uuid={uuid} закрыта. Продолжай работу.',
    },
    formCancelled: {
      title: 'Форма отменена',
      prompt: 'Человек отменил форму «{label}» ({ref}), uuid={uuid}. Ничего не сохранено: реши, нужна ли новая ссылка или другой путь.',
    },
    shareRevealed: {
      title: 'Секрет забрали',
      prompt: 'Секрет «{label}» (uuid={uuid}) показан человеку один раз: ссылка погашена, ключ и шифртекст удалены. secret_result(uuid="{uuid}") подтвердит состояние.',
    },
  },
  zh: {
    formSaved: {
      title: '已收到密钥',
      prompt: '“{label}”（{ref}）的值已保存到 {target}。表单 uuid={uuid} 已关闭。继续工作：secret_result({uuid}) 可查看状态。',
    },
    formUploaded: {
      title: '已收到文件',
      prompt: '“{label}”的文件 {fileName}（{size} 字节）已保存到 {path}，sha256={sha256}。表单 uuid={uuid} 已关闭。继续工作。',
    },
    formCancelled: {
      title: '表单已取消',
      prompt: '用户取消了表单“{label}”（{ref}），uuid={uuid}。没有保存任何内容：请判断是否需要新链接或其他方式。',
    },
    shareRevealed: {
      title: '密钥已被取走',
      prompt: '“{label}”的密钥（uuid={uuid}）已向用户展示一次：链接作废，密钥与密文已删除。secret_result({uuid}) 可确认状态。',
    },
  },
};

/** The wording for one note in one language; English when the tag is unknown. */
export function noteText(kind, variables, language = 'en') {
  const dict = DICTS[String(language ?? '').trim().toLowerCase().split(/[-_]/)[0]] ?? DICTS.en;
  // Stored kinds are hyphenated (`form-saved`), dictionary keys are camelCase.
  const key = String(kind).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  const entry = dict[key] ?? DICTS.en[key];
  if (entry === undefined) throw new TypeError(`dsh-secret-form: unknown note kind ${JSON.stringify(kind)}`);
  const fill = (text) => String(text).replace(/\{(\w+)\}/g, (slot, key) => (key in variables ? String(variables[key]) : slot));
  return { title: fill(entry.title), prompt: fill(entry.prompt) };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Build the outbox.
 * @param input - `db`, `getSchedule` (lazy lookup of the schedule service),
 *   `language`, `logger`, and the test knobs `deadlineMs`/`pollMs`/`retryMs`.
 */
export function createNotifier({
  db,
  getSchedule = () => undefined,
  language = 'en',
  logger,
  now = Date.now,
  deadlineMs = DEFAULT_DEADLINE_MS,
  pollMs = DEFAULT_POLL_MS,
  retryMs = DEFAULT_RETRY_MS,
} = {}) {
  if (db === undefined || typeof db.prepare !== 'function') {
    throw new TypeError('dsh-secret-form: the notifier needs an open database');
  }
  const sql = {
    insert: db.prepare('INSERT INTO note (uuid, kind, session_id, title, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    all: db.prepare('SELECT * FROM note ORDER BY id'),
    bump: db.prepare('UPDATE note SET attempts = ?, last_error = ? WHERE id = ?'),
    drop: db.prepare('DELETE FROM note WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM note'),
  };

  let draining = null;
  let retryTimer;

  const log = (level, text) => {
    const writer = logger?.[level] ?? logger?.info;
    try {
      if (typeof writer === 'function') writer.call(logger, text);
    } catch {}
  };

  /**
   * Put one note on the session, retrying while the schedule service is either
   * absent or refusing.
   * @returns true when the note is placed, false when it has to wait.
   */
  async function place(note) {
    const schedule = getSchedule();
    if (schedule === undefined || typeof schedule.create !== 'function') return false;
    const deadline = Date.now() + deadlineMs;
    let refusal;
    while (Date.now() < deadline) {
      try {
        await schedule.create(note.session_id, {
          title: note.title,
          prompt: note.prompt,
          after_seconds: 1,
        });
        return true;
      } catch (error) {
        refusal = String(error?.message ?? error);
        // A delegated child has no delivery path at all: retrying forever would
        // only hide that fact.
        if (/subagent/i.test(refusal)) throw error;
        await sleep(retryMs);
      }
    }
    throw new Error(refusal ?? 'the schedule service did not accept the note in time');
  }

  async function drain() {
    for (const note of sql.all.all()) {
      try {
        const placed = await place(note);
        if (!placed) {
          log('info', `note ${note.kind} for session ${note.session_id} waits for the schedule service`);
          break;
        }
        sql.drop.run(note.id);
        log('info', `note ${note.kind} placed on session ${note.session_id}`);
      } catch (error) {
        const attempts = note.attempts + 1;
        const message = String(error?.message ?? error);
        sql.bump.run(attempts, message, note.id);
        if (attempts >= MAX_ATTEMPTS) {
          sql.drop.run(note.id);
          log('warn', `note ${note.kind} for session ${note.session_id} dropped after ${attempts} attempts: ${message}`);
          continue;
        }
        log('info', `note ${note.kind} not placed yet (${attempts}/${MAX_ATTEMPTS}): ${message}`);
      }
    }
    if (sql.count.get().n > 0) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void kick(), Math.max(1000, retryMs * 5));
      retryTimer.unref?.();
    }
  }

  /** Try to deliver everything in the outbox; safe to call at any time. */
  function kick() {
    if (draining !== null) return draining;
    draining = drain().finally(() => {
      draining = null;
    });
    return draining;
  }

  return {
    /** Queue a note and start delivering it. */
    queue({ kind, uuid, sessionId, variables = {} }) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        log('info', `no session to tell about ${kind} ${uuid}: the note is skipped`);
        return undefined;
      }
      const { title, prompt } = noteText(kind, { uuid, ...variables }, language);
      sql.insert.run(uuid, kind, sessionId, title, prompt, now());
      void kick();
      return { uuid, kind, sessionId, title, prompt };
    },

    /** Deliver what is waiting (start-up, and again when the service appears). */
    kick,

    /** How many notes are still undelivered. */
    get pending() {
      return sql.count.get().n;
    },

    stop() {
      clearTimeout(retryTimer);
    },
  };
}
