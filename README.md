# dsh-secret-form

A **one-time web link for secrets** in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The model needs an API key. Today the usual answer is "paste it in the chat",
which puts the secret into the session log, the transcript, every later provider
request, and anything the session is exported to. This plugin replaces that with
a link:

1. the model calls `secret_create` and gets an absolute URL;
2. the human opens it on a phone or a desktop, types the value, presses Save;
3. the plugin writes it into the host credential store or into a document file;
4. the model calls `secret_result` and learns `saved`, `length: 51` — never the
   value itself.

The page is one self-contained HTML document: inline CSS, no assets, no
frameworks, light and dark from the same markup.

## Install

The package ships no `dsh.bundle`, so `dsh plugin add` installs it as a plain
dependency and a profile patch row actually mounts it.

### From npm

```sh
dsh plugin --profile <profile> add @dr-co/dsh-secret-form
```

### From GitHub

Pin a tag when you want a revision you can point at later; the repository root is
the package, so no build step is involved.

```sh
dsh plugin --profile <profile> add "git+https://github.com/unera/dsh-secret-form.git#v0.1.0"
# a particular commit
dsh plugin --profile <profile> add "git+https://github.com/unera/dsh-secret-form.git#<sha>"
# or a local checkout while developing
dsh plugin --profile <profile> add file:$PWD/dsh-secret-form
```

Either way the package ships no `dsh.bundle`, so it lands as a plain dependency
and the profile patch row below is what actually mounts it.

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

The plugin declares `inject: ['tools', 'webServer']`: it cannot do anything
without a Web GUI server to serve the page, and it registers its four tools on
the agent surface. The credentials service is read lazily, so a host that only
writes to files does not need a credential provider.

## The four tools

### `secret_create`

Open a form and return its link.

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `ref` | string | yes | Key name. Default target: the credential reference, such as `OPENAI_API_KEY`. File target: the path inside the document — `provider.apiKey` for yaml/json, a bare key for `.env`. |
| `label` | string | yes | Form title, 2 to 5 words. |
| `kind` | `'single'` \| `'multi'` | yes | One-line masked input, or a monospace textarea for multi-line secrets. |
| `description` | string | no | One or two sentences under the title, at most 300 characters. |
| `save` | object | no | Default `{ "kind": "credentials" }`. A file target is `{ "kind": "file", "path": "…" }`. |
| `ttlSeconds` | integer | no | Default 300, clamped to 30..3600. |
| `allowEmpty` | boolean | no | Default `false`. When true an empty submit is accepted and reported as `empty`. |
| `expect` | string | no | Regular expression as text. The result carries `matchesExpect`; the page warns on a mismatch but still saves. |
| `data` | object | no | Up to 1 KB of bookkeeping for the model. Echoed verbatim by all four tools, never rendered on the page. |

Returns `{ uuid, url, expiresAt, data }`. `url` is absolute: the web server's
`getOrigin()` plus `routePrefix` plus a 43-character token.

### `secret_result`

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `uuid` | string | yes | The uuid `secret_create` returned. |
| `waitSeconds` | integer | no | 0..30, default 0. Above zero it waits for the form to leave `pending`, then reports whatever state it reached. |

Returns `{ status, data, ref, label }` plus, once a value was submitted,
`length` (characters), `lines`, `trimmed` (whether surrounding whitespace was
stripped) and `matchesExpect` when `expect` was given. `status` is one of
`pending`, `saved`, `empty`, `cancelled`, `expired`.

The submitted value never appears in a tool result. Not truncated, not masked,
not hashed — absent.

### `secret_list`

No arguments. Returns every form this process created, oldest first:

```json
[{ "uuid": "…", "ref": "OPENAI_API_KEY", "label": "OpenAI key", "status": "saved",
   "createdAt": "2026-10-21T12:28:30.263Z", "expiresAt": "2026-10-21T12:33:30.263Z", "data": {} }]
```

### `secret_cancel`

| argument | type | required | meaning |
| --- | --- | --- | --- |
| `uuid` | string | yes | The uuid `secret_create` returned. |

Cancels a pending form; a form that already finished reports its current status
and is left alone.

## The web surface

| route | method | body | result |
| --- | --- | --- | --- |
| `<prefix>/<token>` | `GET`, `HEAD` | — | the form, or an outcome page |
| `<prefix>/<token>` | `POST` | `application/x-www-form-urlencoded` with `value`, `action` (`save` or `cancel`) and the hidden `lang` | an outcome page |

Both responses carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'
```

The label and description come from the model and are escaped as untrusted HTML;
the only script on the page is the reveal toggle and the `expect` hint, both
inline and both from this origin.

Outcome pages have distinct wording: **Saved**, **Nothing stored** (empty
submit), **Cancelled**, **Link already used**, **Link expired**, **Link not
recognised**.

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

### The YAML writer is deliberately small

The reader understands block mappings, plain and quoted scalars, comments and
blank lines. Anything else — sequences, flow collections, block scalars (`|`,
`>`), anchors, aliases, tags, multiple documents — is **refused with an error
and the file is left untouched**, because a partial implementation that rewrites
a document it half-understands is worse than a refusal. Leaf values keep their
original spelling (`port: 8080` stays `port: 8080`); **comments are dropped** by
the rewrite. Use `.json` or `.env` when a hand-written YAML file must keep its
comments.

## Security notes

- **The token is the capability.** 256 bits of `crypto.randomBytes`, base64url,
  single use. A successful submit or a cancel kills it: the link still opens, but
  only to say "already used" or "cancelled". Nothing else can read a form.
- **The value only ever travels browser → host.** It is not logged, not echoed
  back into the page, and not returned to the model. Logs carry at most the first
  eight characters of a token.
- **The page never accepts a value twice.** A second POST on the same token is a
  `410` and writes nothing.
- **The page holds no third-party content.** `default-src 'none'` with inline
  style and script only, `form-action 'self'`, `base-uri 'none'`, no referrer,
  no store, no framing.
- **One-time links are visible to whoever can read the chat.** The URL is safe to
  post because it carries no secret; anything that can submit it first wins.
  Treat the window as `ttlSeconds`, and cancel a form you no longer need.
- **A link is bound to this process.** Nothing about it is durable, which is why
  a restart is safe — and why every form disappears with it.

## In-memory by design

Forms live in a `Map` in the plugin instance. There is no database, no file, no
token on disk. Consequences, all intentional:

- a restart makes every form `expired`; ask for a new link;
- an expired form, a used link and a cancelled form stay answerable for an hour
  past their TTL, then a lazy sweep drops them and the token becomes unknown;
- two DSH processes do not share forms, so a link created by one is unknown to
  the other;
- `secret_list` shows this process's forms only.

## Development

```sh
npm test              # node --test, no dependencies
npm pack --dry-run    # what would ship
```

The suite drives the real `apply()` against a stub host: tool definitions are
captured as a real agent would call them, and the route handler is invoked with
`node:stream` request doubles, so no port is opened. TTL cases move the clock
with `node:test` mock timers instead of sleeping.

## Limits

- Node >= 22, zero runtime dependencies.
- The page is served by the Web GUI host only; a headless composition with no
  `webServer` cannot use this plugin.
- `label` is 2..5 words and `description` 300 characters: the form is a prompt
  for one value, not a second chat.
- `kind: 'single'` removes embedded newlines, so a pasted key file must use
  `kind: 'multi'`.

## License

MIT — see [LICENSE](LICENSE).

## Why the single-line field is a textarea

Firefox offers its password manager on `input[type=password]`, and on text inputs
it heuristically reads as login fields (the same problem the Telegram bot card
hit with its group reference). A `textarea` is never treated as a login field, so
the single-line form uses a one-row textarea; the value is hidden by an overlay
of bullets rather than by the element type, which keeps the reveal toggle working
in every browser, including those without `-webkit-text-security`.
