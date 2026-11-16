const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const MAX_FILE_BYTES = 262_144;
const MAX_FIELD_BYTES = 65_536;
const MAX_SHARED_DIRS = 100;
const MAX_INCLUDE_ENTRIES = 1_000;

/**
 * Normalize a relative config path (Orca rules) or return null if invalid.
 */
function normalizeRelPath(p) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/\\/g, "/");
  if (!s) return null;
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) return null;
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  if (!s) return null;
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split("/");
  for (const seg of parts) {
    if (!seg || seg === "." || seg === ".." || seg === ".git") return null;
  }
  return parts.join("/");
}

function cleanStringField(val) {
  if (typeof val !== "string") return undefined;
  if (Buffer.byteLength(val, "utf8") > MAX_FIELD_BYTES) return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse orca.yaml text using Orca's validation limits and rules.
 * Returns null if the file itself is invalid or rejected.
 */
function parseOrcaYaml(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    return null;
  }
  let doc;
  try {
    doc = YAML.parseDocument(text, { uniqueKeys: true, maxAliasCount: 100 });
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  const data = doc.toJS();
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const out = { sharedDirectories: [] };

  if (data.scripts && typeof data.scripts === "object" && !Array.isArray(data.scripts)) {
    const setup = cleanStringField(data.scripts.setup);
    if (setup !== undefined) out.setup = setup;
    const archive = cleanStringField(data.scripts.archive);
    if (archive !== undefined) out.archive = archive;
  }

  if (data.worktree && typeof data.worktree === "object" && !Array.isArray(data.worktree)) {
    const raw = data.worktree.sharedDirectories;
    if (Array.isArray(raw)) {
      const seen = new Set();
      for (const item of raw.slice(0, MAX_SHARED_DIRS)) {
        if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_FIELD_BYTES) continue;
        const norm = normalizeRelPath(item);
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          out.sharedDirectories.push(norm);
        }
      }
    }
  }

  return out;
}

/**
 * Parse .worktreeinclude text into normalized, deduplicated literal relative paths.
 */
function parseWorktreeInclude(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("!") || trimmed.includes("*") || trimmed.includes("?")) continue;
    const norm = normalizeRelPath(trimmed);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
      if (out.length >= MAX_INCLUDE_ENTRIES) break;
    }
  }
  return out;
}

function readRegularFileBounded(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readOrcaConfig(dir) {
  const text = readRegularFileBounded(path.join(dir, "orca.yaml"));
  if (text === null) return null;
  return parseOrcaYaml(text);
}

function readWorktreeInclude(dir) {
  const text = readRegularFileBounded(path.join(dir, ".worktreeinclude"));
  if (text === null) return [];
  return parseWorktreeInclude(text);
}

module.exports = {
  normalizeRelPath,
  parseOrcaYaml,
  parseWorktreeInclude,
  readOrcaConfig,
  readWorktreeInclude,
};
