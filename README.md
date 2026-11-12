# dsh-secret-form

**One-time secret links in both directions** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The model needs an API key. The usual answer is "paste it in the chat", which
puts the secret into the session log, the transcript, every later provider
request, and anything the session is exported to. This plugin replaces that with
a link — and it works the other way round too, when the model has a secret the
human needs:

| | inbound (`secret_create`) | outbound (`secret_share`) |
| --- | --- | --- |
| who has the secret | the human | the model |
| the link | works exactly once | may be opened any number of times |
| the action on the page | Save | a reveal button that works **exactly once** |
| where the value ends up | credential store, a document file, or a directory | the browser, shown once with a copy button |
| what the model learns | `saved`, `length: 51`, a file sha256 | `revealed`, `views: 3` — never the value back |

Both directions live in SQLite, so a link created before a restart of the harness
still works afterwards. Filling a form in — or a human collecting a shared
secret — wakes the session that asked, through the schedule service.

The page is one self-contained HTML document: inline CSS, no assets, no
frameworks, light and dark from the same markup.

## Install

The package ships a `dsh.bundle` layer, so `dsh plugin add` both installs it and
mounts it: it shows up in the settings plugin list, where it can be switched off
or removed like any other plugin. Host-specific settings belong in the profile's
own patch as an id-targeted override.

### From npm

```sh
dsh plugin --profile <profile> add @dr-co/dsh-secret-form
```

### From GitHub

Pin a tag when you want a revision you can point at later; the repository root is
the package, so no build step is involved.

```sh
dsh plugin --profile <profile> add "git+https://github.com/unera/dsh-secret-form.git#v0.4.0"
# a particular commit
dsh plugin --profile <profile> add "git+https://github.com/unera/dsh-secret-form.git#<sha>"
# or a local checkout while developing
dsh plugin --profile <profile> add file:$PWD/dsh-secret-form
```

Mount it next to the two services it uses — the Web GUI host and the agent's
tools:

```yaml
- id: secret-form
  name: '@dr-co/dsh-secret-form'
  config:
    routePrefix: /secret            # default; must start with "/"
    defaultTtlSeconds: 300          # default; every value is clamped to 30..3600
    defaultLocale: en               # default; en|ru|de|fr|es|pt|zh|ja
    publicUrl: https://dsh.example.org   # optional; see below
    database: /home/dsh/.dsh/storages/dsh-secret-form.sqlite   # default
    language: en                    # default; wording of the notes: en|ru|zh
    notify: true                    # default; wake the creating session
    maxUploadBytes: 67108864        # default 64 MiB; 1 KiB..1 GiB
    retainSeconds: 3600             # default; how long finished records stay answerable
```

`publicUrl` matters behind a proxy: the listener usually binds loopback, so its
own origin would produce a `http://127.0.0.1:3080/...` link that no phone can
open. When `publicUrl` is set the returned link is built from it; when it is not,
the plugin returns the listener origin unchanged and the model is told to hand it
over as-is rather than invent a hostname.

`routePrefix` moves the whole surface, which is what a host behind a path
rewriter needs. `defaultTtlSeconds` is the TTL used when a call omits
`ttlSeconds`. `defaultLocale` is the wording used when neither the link nor the
browser asks for a language; any other value is refused at mount time.
`database` defaults to `$DSH_HOME/storages/dsh-secret-form.sqlite`; the file is
created with mode `0600` inside a directory with mode `0700`.

The plugin declares `inject: ['tools', 'webServer']`: it cannot do anything
without a Web GUI server to serve the page, and it registers its five tools on
the agent surface. Two more services are looked up lazily and never required: the
credentials service (only for a credential target or a credential share) and the
schedule service (only to place a note on a session).

## The five tools

### `secret_create`

Open a form and return its link.

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `ref` | string | for text kinds | Key name. Default target: the credential reference, such as `OPENAI_API_KEY`. File target: the path inside the document — `provider.apiKey` for yaml/json, a bare key for `.env`. For `kind: "file"` it is only a label unless `upload.name` is omitted. |
| `label` | string | yes | Form title, 2 to 5 words. |
| `kind` | `'single'` \| `'multi'` \| `'file'` | no | Default `single`. One-line masked input, a monospace textarea, or a file picker. |
| `description` | string | no | One or two sentences under the title, at most 300 characters. |
| `save` | object | no | Default `{ "kind": "credentials" }`. A file target is `{ "kind": "file", "path": "…" }`. Ignored for `kind: "file"`. |
| `upload` | object | for `kind: "file"` | `{ "dir": "/abs/dir", "name": "app.log" }`. `dir` receives the file (created when missing, mode `0700`); `name` defaults to the name the browser sent. |
| `ttlSeconds` | integer | no | Default 300, clamped to 30..3600. |
| `allowEmpty` | boolean | no | Default `false`. When true an empty submit is accepted and reported as `empty`. |
| `expect` | string | no | Regular expression as text. The result carries `matchesExpect`; the page warns on a mismatch but still saves. |
| `notify` | boolean | no | Wake the creating session when the form is filled in or cancelled. Default: the plugin setting. |
| `data` | object | no | Up to 1 KB of bookkeeping for the model. Echoed verbatim by all five tools, never rendered on the page. |

Returns `{ uuid, url, expiresAt, kind, data }`. `url` is absolute: the web
server's `getOrigin()` (or `publicUrl`) plus `routePrefix` plus a 43-character
token.

### `secret_share`

Hand a secret to the human. **The value never passes through the call**: name a
source and the plugin reads the bytes itself, seals them with a one-shot
AES-256-GCM key and stores both ciphertext and key in SQLite.

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `label` | string | yes | Page title, 2 to 5 words. |
| `kind` | `'single'` \| `'multi'` | no | Wording and layout only. Default `single`. |
| `file` | string | one of two | Absolute path of a text file on this host. At most 256 KiB; a file with a NUL byte is refused as binary. |
| `credential` | string | one of two | A credential reference such as `OPENAI_API_KEY`, read through `ctx.credentials.resolve()`. |
| `description` | string | no | One or two sentences under the title. |
| `ttlSeconds` | integer | no | 30..3600, default 300. After that the sealed value is deleted unread. |
| `notify` | boolean | no | Wake the creating session when the human collects the secret. Default: the plugin setting. |
| `data` | object | no | Up to 1 KB of bookkeeping. |

Returns `{ uuid, url, expiresAt, source, length, data }` — `length`, not the
value.

### `secret_result`

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `uuid` | string | yes | The uuid `secret_create` or `secret_share` returned. |
| `waitSeconds` | integer | no | 0..30, default 0. Above zero it waits for the record to leave `pending`, then reports whatever state it reached. |

For a form: `{ type: "form", status, data, ref, label }` plus, once a value was
submitted, `length` (characters), `lines`, `trimmed` and `matchesExpect` when
`expect` was given — or `fileName`, `size`, `sha256`, `path` for a file form.
`status` is one of `pending`, `saved`, `empty`, `cancelled`, `expired`.

For a share: `{ type: "share", status, label, views, data, revealedAt? }`.
`status` is one of `pending`, `revealed`, `cancelled`, `expired`; `pending` with
`views > 0` means the human opened the page but has not pressed the button yet.

Neither the submitted value nor the shared secret ever appears in a tool result.
Not truncated, not masked, not hashed — absent.

### `secret_list`

No arguments. Every form and share still held, oldest first:

```json
[{ "uuid": "…", "type": "form", "ref": "OPENAI_API_KEY", "label": "OpenAI key",
   "status": "saved", "createdAt": "2026-10-21T12:28:30.263Z",
   "expiresAt": "2026-10-21T12:33:30.263Z", "data": {} },
 { "uuid": "…", "type": "share", "label": "Router password", "status": "pending",
   "views": 2, "createdAt": "…", "expiresAt": "…", "data": {} }]
```

The list is read from SQLite, so it also holds records created before a restart.

### `secret_cancel`

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `uuid` | string | yes | The uuid of a form or a share. |

Cancels a pending record; one that already finished reports its current status
and is left alone. For a share this also deletes the sealed value and its key.

## The web surface

| route | method | body | result |
| --- | --- | --- | --- |
| `<prefix>/<token>` | `GET`, `HEAD` | — | the form, the reveal page, or an outcome page |
| `<prefix>/<token>` | `POST` | `application/x-www-form-urlencoded` with `value`, `action` (`save`/`cancel`/`reveal`) and the hidden `lang` | an outcome page |
| `<prefix>/<token>` | `POST` | `multipart/form-data` with a `file` part, `action` and `lang` | an outcome page |

A `kind: "file"` form posts multipart; everything else posts urlencoded. The
multipart parser is about eighty lines in `lib/upload.mjs`: one boundary, parts
made of headers and bytes, no nested encodings. The body is read into memory and
bounded by `maxUploadBytes`, which is what makes that acceptable.

Both responses carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'
```

The label and description come from the model and are escaped as untrusted HTML;
the only scripts on a page are the reveal toggle, the `expect` hint and the copy
button, all inline and all from this origin.

Outcome pages have distinct wording: **Saved**, **File received**, **Nothing
stored** (empty submit), **Cancelled**, **Link already used**, **Secret already
shown**, **Link expired**, **Link not recognised**.

### Languages

The page's own wording exists in `en`, `ru`, `de`, `fr`, `es`, `pt`, `zh` and
`ja`; the table lives in `lib/i18n.mjs`. The locale is chosen in this order:

1. `?lang=de` on the link (`/secret/<token>?lang=de`), which also lets the model
   pin one language for a link it hands over;
2. the browser's `Accept-Language`, ranked by q-values and matched by primary
   subtag, so `de-AT` and `zh-CN`/`zh-TW`/`zh-Hans` resolve as `de` and `zh`;
3. `defaultLocale`, and English last.

The form carries the resolved locale in a hidden `lang` field, which outranks
the header on submit, so the outcome page stays in the language the reader
started in. `<html lang="…">` follows the same value. The ref (`OPENAI_API_KEY`)
is an identifier and stays as it is; everything around it is translated.

The **notes** are a separate matter: their wording follows the plugin's
`language` setting (`en`, `ru`, `zh`), because they are read by the model rather
than by the person holding the phone.

## Where the value goes

**Credentials (default).** `ctx.credentials.set(ref, value)` — the same store an
adapter reads through `apiKeyEnv`, so a rotated key applies to the next request.
The store refuses an empty value, which is why an empty submit is reported as
`empty` and stored nowhere.

**File.** `{ "kind": "file", "path": "/abs/or/relative/path" }`. The extension
picks the format and nothing else does — `.yaml`, `.yml`, `.json`, `.env`; any
other extension is rejected when the form is created, never guessed.

- `.env` — append the `KEY=value` line or replace the existing one in place.
  Values with spaces, quotes or newlines are double-quoted with escapes.
- `.json` — parse, set the dotted path, re-serialise with 2-space indent.
- `.yaml` / `.yml` — parse, set the dotted path, re-serialise.

Writes create parent directories, go through a temp file beside the target
followed by `rename`, and land with mode `0600`. Nested objects are created when
missing; a path that already holds a scalar where a mapping is needed, or a
mapping where the leaf goes, is refused instead of destroyed. `__proto__`,
`prototype` and `constructor` are refused as path segments.

**Directory (uploads).** `kind: "file"` writes the received bytes into the
`upload.dir` the model named — never anywhere else, and never into the page. The
browser's own file name is reduced to a base name, so `../../etc/passwd` becomes
`passwd` inside the directory, and the resolved path is checked against the
directory once more. The write is atomic (temp file, `fsync`, `rename`) and lands
with mode `0600`. The model gets `fileName`, `size`, `sha256` and `path`.

### The YAML writer is deliberately small

The reader understands block mappings, plain and quoted scalars, comments and
blank lines. Anything else — sequences, flow collections, block scalars (`|`,
`>`), anchors, aliases, tags, multiple documents — is **refused with an error
and the file is left untouched**, because a partial implementation that rewrites
a document it half-understands is worse than a refusal. Leaf values keep their
original spelling (`port: 8080` stays `port: 8080`); **comments are dropped** by
the rewrite. Use `.json` or `.env` when a hand-written YAML file must keep its
comments.

## Notes to the session

A form is filled in minutes after the model asked for it, usually after that turn
has ended. Polling `secret_result` would be slow and wasteful, so the plugin
wakes the session instead — the same route the
[graceful-restart](https://github.com/unera/dsh-graceful-restart) plugin uses for
its post-restart note:

```js
await schedule.create(sessionId, { title, prompt, after_seconds: 1 })
```

`ScheduleService` owns the timer and resumes the session itself, so this plugin
never races session start-up: it asks, and the service answers when it can. The
session id comes from `exec.agent.session.id` at creation time and is stored with
the record.

- one note per event: **Secret received**, **File received**, **Form cancelled**,
  **Secret collected**;
- the note names the uuid, the label and where the value went, never the value;
- undelivered notes wait in the `note` table — the schedule service may mount
  after this plugin, or not at all — and are retried at start-up, when the
  service appears, and every few seconds after that;
- a note is dropped after eight attempts, or immediately for a subagent, which
  has no delivery path at all;
- `notify: false` on a single call, or `notify: false` in the config, silences it.

## Storage and security

Records live in one SQLite file (`node:sqlite`, no dependency), in WAL mode:

| table | holds |
| --- | --- |
| `form` | inbound requests: label, ref, target, TTL, status, aggregate result, session id |
| `share` | outbound links: label, TTL, status, view count, session id |
| `share_secret` | the sealed value: algorithm, iv, tag, ciphertext |
| `share_key` | the one-shot AES-256-GCM key, in its own row |
| `note` | notes waiting for a session |
| `meta` | schema version; a mismatch is a refusal, not a migration |

- **The token is the capability and is never stored.** Only its SHA-256 hash is
  written, so a copy of the database opens no link. 256 bits of
  `crypto.randomBytes`, base64url.
- **The inbound value never touches the database.** It is written to its target
  and nowhere else; the row keeps `length`, `lines` and the file's sha256.
- **An outbound value is encrypted with a key that lives in the same file.** It
  protects a half-copied database and a row surviving a crash mid-delete, not a
  person who can read both rows while the link is still open — that person owns
  the host anyway. Revealing, cancelling and expiry all delete both rows.
- **The page never accepts a value twice.** A second POST on a form token is a
  `410` and writes nothing; a second POST on a share token cannot reveal anything
  because there is nothing left to decrypt.
- **The page holds no third-party content.** `default-src 'none'` with inline
  style and script only, `form-action 'self'`, `base-uri 'none'`, no referrer,
  no store, no framing.
- **A link is visible to whoever can read the chat.** The URL is safe to post
  because it carries no secret; anything that can submit it first wins. Treat the
  window as `ttlSeconds`, and cancel a record you no longer need.
- **One process owns the file.** SQLite serialises concurrent access, but two DSH
  processes sharing one database would share their forms as well — point
  `database` at separate files if that ever becomes a question.

Retention: an expired, used or cancelled record keeps answering its link for
`retainSeconds` (default an hour) past its end, then a lazy sweep drops it and
the link reads as unknown. Expired shares have their sealed rows deleted
immediately, not at the sweep.

## Development

```sh
npm test              # node --test, no dependencies
npm pack --dry-run    # what would ship
```

The suite drives the real `apply()` against a stub host: tool definitions are
captured as a real agent would call them, and the route handler is invoked with
`node:stream` request doubles, so no port is opened. Every host gets its own
SQLite file in a temporary directory, which is also how a restart is tested: a
second `apply()` on the same file has to find the record. Expiry cases move the
clock with SQL instead of sleeping.

## Limits

- Node >= 22.13, zero runtime dependencies: `node:sqlite` stopped needing
  `--experimental-sqlite` in 22.13.0, and on 22 it still prints an experimental
  warning.
- The page is served by the Web GUI host only; a headless composition with no
  `webServer` cannot use this plugin.
- `label` is 2..5 words and `description` 300 characters: the page is a prompt
  for one value, not a second chat.
- `kind: 'single'` removes embedded newlines, so a pasted key file must use
  `kind: 'multi'`.
- A share carries text only: 256 KiB, no NUL bytes. A binary file needs another
  route.
- Uploads go to the directory the model named. There is no default inbox, so a
  file form without `upload.dir` is refused at creation.

## License

MIT — see [LICENSE](LICENSE).

## Why the single-line field is a textarea

Firefox offers its password manager on `input[type=password]`, and on text inputs
it heuristically reads as login fields (the same problem the Telegram bot card
hit with its group reference). A `textarea` is never treated as a login field, so
the single-line form uses a one-row textarea; the value is hidden by an overlay
of bullets rather than by the element type, which keeps the reveal toggle working
in every browser, including those without `-webkit-text-security`.
