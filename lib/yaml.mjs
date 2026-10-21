// A block-style YAML reader and writer, limited to what a secret form needs.
//
// The form sets exactly one dotted path inside a document someone already keeps
// by hand. A real YAML implementation would be a dependency, and a partial one
// that silently mangles a document is worse than a refusal: everything this
// reader does not understand (sequences, flow collections, block scalars,
// anchors, tags, multiple documents) throws instead of being re-serialised
// losslessly-but-wrongly.
//
// Leaf values keep their original scalar spelling, so setting one path never
// turns `port: 8080` into `port: "8080"`. Comments are the one thing the rewrite
// drops; the README says so.

const RESERVED_WORD = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const NUMERIC = /^[-+]?(?:\d[\d_]*)?(?:\.\d*)?(?:[eE][-+]?\d+)?$/;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLAIN_VALUE = /^[A-Za-z_][A-Za-z0-9_./@+-]*$/;

function unsupported(source, reason) {
  const error = new TypeError(`${source} is not supported as a YAML target: ${reason}`);
  error.code = 'secret-form-yaml-unsupported';
  return error;
}

function isPlain(text) {
  return PLAIN_VALUE.test(text) && !RESERVED_WORD.test(text) && !NUMERIC.test(text);
}

function quoted(text) {
  // JSON strings are valid YAML double-quoted scalars and carry every escape a
  // secret can need (newlines, tabs, backslashes, quotes).
  return JSON.stringify(text);
}

/** Serialise a new string value so a YAML reader gets the same string back. */
export function yamlScalar(value) {
  if (value === '') return '""';
  return isPlain(value) ? value : quoted(value);
}

function emitKey(key) {
  return PLAIN_KEY.test(key) && !RESERVED_WORD.test(key) && !NUMERIC.test(key) ? key : quoted(key);
}

function stripComment(text) {
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (double) {
      if (char === '\\') index += 1;
      else if (char === '"') double = false;
      continue;
    }
    if (single) {
      if (char === "'") {
        if (text[index + 1] === "'") index += 1;
        else single = false;
      }
      continue;
    }
    if (char === '"') {
      double = true;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '#' && (index === 0 || text[index - 1] === ' ' || text[index - 1] === '\t')) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

function unquote(text) {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function splitEntry(body, source, lineNumber) {
  let single = false;
  let double = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (double) {
      if (char === '\\') index += 1;
      else if (char === '"') double = false;
      continue;
    }
    if (single) {
      if (char === "'") {
        if (body[index + 1] === "'") index += 1;
        else single = false;
      }
      continue;
    }
    if (char === '"') {
      double = true;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === ':' && (index + 1 === body.length || body[index + 1] === ' ' || body[index + 1] === '\t')) {
      const key = unquote(body.slice(0, index));
      if (key === '') throw unsupported(source, `line ${lineNumber} has an empty key`);
      const rest = stripComment(body.slice(index + 1)).trim();
      return { key, raw: rest };
    }
  }
  throw unsupported(source, `line ${lineNumber} is not a "key: value" entry`);
}

function collectLines(text, source) {
  const raw = text.split(/\r?\n/);
  const lines = [];
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    const lineNumber = index + 1;
    if (line.trim() === '') continue;
    if (line.trimStart().startsWith('#')) continue;
    if (/^[ \t]*\t/.test(line)) throw unsupported(source, `line ${lineNumber} is indented with a tab`);
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(line.trim())) throw unsupported(source, 'multi-document markers are not supported');
    const indent = /^ */.exec(line)[0].length;
    const body = line.slice(indent);
    if (/^-(\s|$)/.test(body)) throw unsupported(source, `line ${lineNumber} opens a sequence`);
    if (/^[?&*!|>%@`]/.test(body)) throw unsupported(source, `line ${lineNumber} uses YAML syntax this writer does not keep`);
    const entry = splitEntry(body, source, lineNumber);
    if (/^[?&*!|>%@`{]/.test(entry.raw) || entry.raw.startsWith('[')) {
      throw unsupported(source, `line ${lineNumber} has a value this writer does not keep`);
    }
    lines.push({ indent, lineNumber, key: entry.key, raw: entry.raw });
  }
  return lines;
}

function buildMap(lines, start, indent, source) {
  const node = { type: 'map', entries: [] };
  const keys = new Set();
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) throw unsupported(source, `line ${line.lineNumber} is indented without a parent key`);
    if (keys.has(line.key)) throw unsupported(source, `line ${line.lineNumber} repeats the key "${line.key}"`);
    keys.add(line.key);
    index += 1;
    if (line.raw === '') {
      let child = { type: 'map', entries: [] };
      if (index < lines.length && lines[index].indent > indent) {
        const nested = buildMap(lines, index, lines[index].indent, source);
        child = nested.node;
        index = nested.next;
      }
      node.entries.push({ key: line.key, node: child });
    } else {
      node.entries.push({ key: line.key, node: { type: 'scalar', raw: line.raw } });
    }
  }
  return { node, next: index };
}

/**
 * Read a block-style YAML mapping.
 * @param text - document text; an empty or comment-only document reads as an empty mapping.
 * @param source - file name used in error messages.
 * @returns mapping node: `{ type: 'map', entries: [{ key, node }] }`.
 */
export function parseYamlMapping(text, source = 'the YAML file') {
  if (typeof text !== 'string') throw unsupported(source, 'the document is not text');
  const lines = collectLines(text, source);
  if (lines.length === 0) return { type: 'map', entries: [] };
  const parsed = buildMap(lines, 0, lines[0].indent, source);
  if (parsed.next !== lines.length) {
    throw unsupported(source, `line ${lines[parsed.next].lineNumber} is indented less than the first key`);
  }
  return parsed.node;
}

/** Serialise a mapping node back to block-style YAML text. */
export function stringifyYamlMapping(root) {
  const lines = [];
  const emit = (node, indent) => {
    const pad = ' '.repeat(indent);
    for (const entry of node.entries) {
      if (entry.node.type === 'map') {
        if (entry.node.entries.length === 0) {
          lines.push(`${pad}${emitKey(entry.key)}:`);
          continue;
        }
        lines.push(`${pad}${emitKey(entry.key)}:`);
        emit(entry.node, indent + 2);
      } else if (entry.node.raw === '') {
        lines.push(`${pad}${emitKey(entry.key)}:`);
      } else {
        lines.push(`${pad}${emitKey(entry.key)}: ${entry.node.raw}`);
      }
    }
  };
  emit(root, 0);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * Set one dotted path inside a mapping node, creating nested mappings.
 * @param root - mapping node from {@link parseYamlMapping}.
 * @param segments - dotted path already split; each segment becomes one key.
 * @param value - string leaf to store.
 * @param source - file name used in error messages.
 */
export function setYamlPath(root, segments, value, source = 'the YAML file') {
  let node = root;
  const walk = segments.slice(0, -1);
  for (const segment of walk) {
    let entry = node.entries.find((candidate) => candidate.key === segment);
    if (entry === undefined) {
      const created = { type: 'map', entries: [] };
      entry = { key: segment, node: created };
      node.entries.push(entry);
      node = created;
      continue;
    }
    if (entry.node.type === 'scalar') {
      if (entry.node.raw !== '') {
        throw unsupported(source, `"${segment}" already holds a value, not a mapping`);
      }
      // An empty `key:` reads as null, which is the natural place to grow a mapping.
      entry.node = { type: 'map', entries: [] };
    }
    node = entry.node;
  }
  const last = segments[segments.length - 1];
  const leaf = node.entries.find((candidate) => candidate.key === last);
  const scalar = { type: 'scalar', raw: yamlScalar(value) };
  if (leaf === undefined) node.entries.push({ key: last, node: scalar });
  else if (leaf.node.type === 'map' && leaf.node.entries.length > 0) {
    throw unsupported(source, `"${last}" already holds a mapping; refusing to replace it`);
  } else leaf.node = scalar;
}
