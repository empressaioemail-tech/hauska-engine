/**
 * YAML 1.2 subset parser for GitHub Actions workflow files.
 * Throws on tabs, aliases, merge keys, and other constructs we do not accept.
 * Keys are kept as written strings (so `on:` stays "on", not boolean true).
 */
export class YamlParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "YamlParseError";
  }
}

export function parseWorkflowYaml(text, filename = "<yaml>") {
  if (typeof text !== "string") {
    throw new YamlParseError(`${filename}: input is not a string`);
  }
  if (text.includes("\t")) {
    throw new YamlParseError(`${filename}: tabs are not allowed`);
  }
  if (/(^|\n)\s*[&*]/.test(text) || /(^|\n)\s*<<:/.test(text)) {
    throw new YamlParseError(
      `${filename}: aliases, anchors, and merge keys are not accepted`
    );
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const lexed = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*$/.test(raw)) continue;
    if (/^\s*#/.test(raw)) continue;
    const indent = raw.match(/^ */)[0].length;
    const trimmed = raw.slice(indent);
    if (trimmed === "---" || trimmed === "...") continue;
    lexed.push({ indent, text: trimmed, line: i + 1, filename });
  }
  const pos = { i: 0, lexed, filename };
  if (lexed.length === 0) {
    throw new YamlParseError(`${filename}: empty document`);
  }
  const value = parseBlock(pos, lexed[0].indent);
  if (pos.i < lexed.length) {
    const extra = lexed[pos.i];
    throw new YamlParseError(
      `${filename}:${extra.line}: unexpected content after document`
    );
  }
  return value;
}

function parseBlock(pos, minIndent) {
  const { lexed } = pos;
  if (pos.i >= lexed.length) {
    throw new YamlParseError(`${pos.filename}: unexpected end of document`);
  }
  const first = lexed[pos.i];
  if (first.indent < minIndent) {
    throw new YamlParseError(
      `${pos.filename}:${first.line}: indent went backwards`
    );
  }
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseList(pos, first.indent);
  }
  return parseMap(pos, first.indent);
}

function parseMap(pos, indent) {
  const map = Object.create(null);
  const { lexed, filename } = pos;
  while (pos.i < lexed.length) {
    const row = lexed[pos.i];
    if (row.indent < indent) break;
    if (row.indent > indent) {
      throw new YamlParseError(
        `${filename}:${row.line}: unexpected indent in mapping`
      );
    }
    if (row.text.startsWith("- ") || row.text === "-") {
      throw new YamlParseError(
        `${filename}:${row.line}: sequence entry where mapping key expected`
      );
    }
    const { key, rest } = splitKey(row.text, filename, row.line);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlParseError(
        `${filename}:${row.line}: duplicate key ${JSON.stringify(key)}`
      );
    }
    pos.i += 1;
    map[key] = parseAfterColon(pos, indent, rest, row);
  }
  return map;
}

function parseList(pos, indent) {
  const list = [];
  const { lexed, filename } = pos;
  while (pos.i < lexed.length) {
    const row = lexed[pos.i];
    if (row.indent < indent) break;
    if (row.indent > indent) {
      throw new YamlParseError(
        `${filename}:${row.line}: unexpected indent in sequence`
      );
    }
    if (!(row.text.startsWith("- ") || row.text === "-")) {
      throw new YamlParseError(
        `${filename}:${row.line}: mapping entry where sequence expected`
      );
    }
    const rest = row.text === "-" ? "" : row.text.slice(2);
    pos.i += 1;
    if (rest === "") {
      if (pos.i < lexed.length && lexed[pos.i].indent > indent) {
        list.push(parseBlock(pos, lexed[pos.i].indent));
      } else {
        list.push(null);
      }
      continue;
    }
    if (looksLikeKey(rest)) {
      const { key, rest: after } = splitKey(rest, filename, row.line);
      const item = Object.create(null);
      item[key] = parseNestedAfterColon(pos, indent, after, row);
      while (pos.i < lexed.length && lexed[pos.i].indent > indent) {
        const nested = lexed[pos.i];
        if (nested.text.startsWith("- ") || nested.text === "-") {
          throw new YamlParseError(
            `${filename}:${nested.line}: nested sequence on a mapping list item needs an explicit nested key`
          );
        }
        const nestedMap = parseMap(pos, nested.indent);
        for (const [k, v] of Object.entries(nestedMap)) {
          if (Object.prototype.hasOwnProperty.call(item, k)) {
            throw new YamlParseError(
              `${filename}:${nested.line}: duplicate key ${JSON.stringify(k)}`
            );
          }
          item[k] = v;
        }
      }
      list.push(item);
      continue;
    }
    list.push(parseScalar(rest, filename, row.line));
  }
  return list;
}

function parseAfterColon(pos, parentIndent, rest, row) {
  return parseNestedAfterColon(pos, parentIndent, rest, row);
}

function parseNestedAfterColon(pos, parentIndent, rest, row) {
  const { lexed, filename } = pos;
  if (rest === "|" || rest.startsWith("|") || rest === ">" || rest.startsWith(">")) {
    return parseBlockScalar(pos, parentIndent, rest, row);
  }
  if (rest !== "") {
    return parseScalar(rest, filename, row.line);
  }
  if (pos.i < lexed.length && lexed[pos.i].indent > parentIndent) {
    return parseBlock(pos, lexed[pos.i].indent);
  }
  return null;
}

function parseBlockScalar(pos, parentIndent, indicator, row) {
  const { lexed } = pos;
  const chomped = [];
  while (pos.i < lexed.length && lexed[pos.i].indent > parentIndent) {
    const child = lexed[pos.i];
    chomped.push(" ".repeat(child.indent - parentIndent - 2) + child.text);
    pos.i += 1;
  }
  const joined = chomped.join("\n");
  if (indicator.startsWith(">")) return joined.replace(/\n/g, " ");
  return joined;
}

function splitKey(text, filename, line) {
  const colon = findUnquotedColon(text);
  if (colon < 0) {
    throw new YamlParseError(
      `${filename}:${line}: expected key: value, got ${JSON.stringify(text)}`
    );
  }
  const rawKey = text.slice(0, colon).trim();
  const rest = text.slice(colon + 1).trim();
  if (rawKey === "") {
    throw new YamlParseError(`${filename}:${line}: empty mapping key`);
  }
  const key = decodeKey(rawKey, filename, line);
  return { key, rest };
}

function looksLikeKey(text) {
  return findUnquotedColon(text) >= 0;
}

function findUnquotedColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || text[i - 1] === " ")) break;
    if (ch === ":" && (i + 1 === text.length || text[i + 1] === " ")) return i;
    if (ch === ":" && i === text.length - 1) return i;
  }
  const m = text.match(/^([^:#]+):(\s|$)/);
  if (m) return m[1].length;
  return -1;
}

function decodeKey(raw, filename, line) {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    const parsed = parseScalar(raw, filename, line);
    if (typeof parsed !== "string") {
      throw new YamlParseError(`${filename}:${line}: mapping key is not a string`);
    }
    return parsed;
  }
  if (raw.includes("#")) {
    throw new YamlParseError(`${filename}:${line}: bare key contains #`);
  }
  return raw;
}

function stripInlineComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || text[i - 1] === " ")) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

function parseScalar(raw, filename, line) {
  const text = stripInlineComment(raw);
  if (text === "") return null;
  if (text === "~" || text === "null" || text === "Null" || text === "NULL") {
    return null;
  }
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (text.startsWith("[") && text.endsWith("]")) {
    return parseFlowSeq(text, filename, line);
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    return parseFlowMap(text, filename, line);
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return JSON.parse(text);
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  return text;
}

function parseFlowSeq(text, filename, line) {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  return splitFlow(inner, filename, line).map((part) =>
    parseScalar(part.trim(), filename, line)
  );
}

function parseFlowMap(text, filename, line) {
  const inner = text.slice(1, -1).trim();
  const map = Object.create(null);
  if (inner === "") return map;
  for (const part of splitFlow(inner, filename, line)) {
    const { key, rest } = splitKey(part.trim(), filename, line);
    map[key] = parseScalar(rest, filename, line);
  }
  return map;
}

function splitFlow(inner, filename, line) {
  const parts = [];
  let buf = "";
  let quote = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      if (ch === "\\" && quote === '"') {
        i += 1;
        if (i < inner.length) buf += inner[i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth += 1;
      buf += ch;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth -= 1;
      buf += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (quote || depth !== 0) {
    throw new YamlParseError(`${filename}:${line}: unbalanced flow collection`);
  }
  parts.push(buf);
  return parts;
}

export function collectJobCheckNames(doc, filename) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new YamlParseError(`${filename}: workflow document must be a mapping`);
  }
  if (!Object.prototype.hasOwnProperty.call(doc, "jobs")) {
    throw new YamlParseError(`${filename}: missing jobs: mapping`);
  }
  const jobs = doc.jobs;
  if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new YamlParseError(`${filename}: jobs: must be a mapping`);
  }
  const names = [];
  const localUses = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    if (job === null || typeof job !== "object" || Array.isArray(job)) {
      throw new YamlParseError(
        `${filename}: jobs.${jobId} must be a mapping`
      );
    }
    if (Object.prototype.hasOwnProperty.call(job, "name")) {
      if (typeof job.name !== "string") {
        throw new YamlParseError(
          `${filename}: jobs.${jobId}.name must be a string, got ${typeof job.name}`
        );
      }
      if (job.name.includes("${{")) {
        throw new YamlParseError(
          `${filename}: jobs.${jobId}.name interpolates a context; check-run name cannot be matched statically`
        );
      }
      names.push({ jobId, name: job.name, source: filename });
    } else {
      names.push({ jobId, name: jobId, source: filename });
    }
    if (typeof job.uses === "string") {
      localUses.push({ jobId, uses: job.uses, source: filename });
    }
  }
  return { names, localUses };
}

export function isLocalReusableWorkflow(uses) {
  if (typeof uses !== "string") return false;
  const path = uses.split("@")[0];
  return path.startsWith("./") || path.startsWith(".github/");
}
