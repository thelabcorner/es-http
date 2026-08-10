#!/usr/bin/env node
/*
 * audit-dist.mjs — output-level ES3 audit of the built dist/eshttp.jsx (T4).
 * ============================================================================
 * Skill adobe-illustrator-scripting §11: "verify the bundled output — not
 * just the TypeScript source — when the expression guards a critical path."
 * The build's own verifyEs3Output checks let/const/class/arrow; this audit
 * adds checks the build does not, with a string/comment-aware scanner so the
 * embedded ESPAK accel bundle payloads (giant base64 string literals) are NOT
 * scanned as code (they are generated content — coordinator-ratified T5
 * exemption; renaming/flagging inside them would corrupt the bundles).
 *
 *   1. Forbidden tokens in CODE context only (let/const/class decls, arrows,
 *      template literals, optional chaining, nullish coalescing, rest
 *      params, real destructuring) — line numbers reported.
 *   2. The !(compound) ES3 parser precedence quirk (verified live 2026-08-08,
 *      skill §11): `!` binding to only the first sub-expression of an
 *      unparenthesized &&/|| chain inside a grouped negation. Flagged as
 *      SUSPECT lines for core-porter triage (not hard failures — each is
 *      legitimate if defensively parenthesized/isolated).
 *   3. Array-prototype-method calls in code context (report-only: the old
 *      jsxinc implements its own _arrIndexOf and must not leak reliance).
 *
 * Usage: node test/parity/audit-dist.mjs [path-to-dist-eshttp-jsx]
 * Exit 0 = no hard failures. Suspect lines print for manual triage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(HERE, '..', '..', 'dist', 'eshttp.jsx');

if (!fs.existsSync(file)) {
  console.error('audit-dist: file not found: ' + file + ' (run `npm run build` first)');
  process.exit(2);
}
const text = fs.readFileSync(file, 'utf8');

// ---------------------------------------------------------------------------
// Code-context tokenizer: walk the source char by char, tracking strings,
// line comments, block comments, and regex literals, and emit CODE segments
// only. (Modeled on the skill scanner's stripping, but line-accurate.)
// ---------------------------------------------------------------------------
function codeSegments(src) {
  const segs = []; // { line, col, text }
  const n = src.length;
  let i = 0;
  let line = 1;
  let segStart = -1;
  let segLine = 1;
  let segCol = 0;

  function flush(end) {
    if (segStart >= 0 && end > segStart) {
      segs.push({ line: segLine, col: segCol, text: src.slice(segStart, end) });
    }
    segStart = -1;
  }
  function startHere() {
    if (segStart < 0) { segStart = i; segLine = line; segCol = i - (lineStart(i) ); }
  }
  function lineStart(at) {
    let j = at;
    while (j > 0 && src.charAt(j - 1) !== '\n') { j--; }
    return j;
  }
  function advance(to) {
    for (let k = i; k < to && k < n; k++) { if (src.charCodeAt(k) === 10) { line++; } }
    i = to;
  }

  while (i < n) {
    const c = src.charAt(i);
    if (c === '\n') { flush(i); i++; line++; continue; }
    if (c === '/' && src.charAt(i + 1) === '/') { // line comment
      flush(i);
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && src.charAt(i + 1) === '*') { // block comment
      flush(i);
      const e = src.indexOf('*/', i + 2);
      advance(e < 0 ? n : e + 2);
      continue;
    }
    if (c === '"' || c === "'") { // string literal
      flush(i);
      const q = c;
      let j = i + 1;
      while (j < n) {
        const d = src.charAt(j);
        if (d === '\\') { j += 2; continue; }
        if (d === q) { j++; break; }
        j++;
      }
      advance(j);
      continue;
    }
    if (c === '`') { // template literal (already forbidden, but skip as string)
      flush(i);
      let j = i + 1;
      while (j < n) {
        const d = src.charAt(j);
        if (d === '\\') { j += 2; continue; }
        if (d === '`') { j++; break; }
        j++;
      }
      advance(j);
      continue;
    }
    if (c === '/' && segStart >= 0 && isRegexStart(i)) { // regex literal (best-effort)
      flush(i);
      let j = i + 1;
      let inCls = false;
      while (j < n) {
        const d = src.charAt(j);
        if (d === '\\') { j += 2; continue; }
        if (d === '[') { inCls = true; j++; continue; }
        if (d === ']') { inCls = false; j++; continue; }
        if (d === '/' && !inCls) { j++; break; }
        j++;
      }
      advance(j);
      continue;
    }
    if (segStart < 0) { segStart = i; segLine = line; segCol = i - lineStart(i); }
    i++;
  }
  flush(n);
  return segs;
}

function isRegexStart(i) {
  // Heuristic: a '/' is a regex start when the previous non-space char is
  // one of ( = , : ; ! & | ? { } [ ] or start-of-line — else it's division.
  let j = i - 1;
  while (j >= 0 && /\s/.test(text.charAt(j))) { j--; }
  if (j < 0) { return true; }
  return /[=(,:;!&|?{}\[\]+\-*%^~<>]/.test(text.charAt(j));
}

const segs = codeSegments(text);
const codeText = segs.map((s) => s.text).join('\n');

let hardFails = 0;
const suspects = [];
const seen = new Set();

function report(kind, name, idx) {
  // Map a codeText offset back to a source line by replaying segments.
  let off = 0;
  for (const s of segs) {
    if (idx < off + s.text.length) {
      const line = s.line;
      const snippet = (text.split('\n')[line - 1] || '').trim();
      const short = snippet.length > 140 ? snippet.slice(0, 140) + '...' : snippet;
      const key = kind + '|' + line;
      if (seen.has(key)) { return; }
      seen.add(key);
      if (kind === 'FAIL') {
        console.error('FAIL: ' + name + ' @line ' + line + ': ' + short);
        hardFails++;
      } else {
        suspects.push('SUSPECT (' + name + ') @line ' + line + ': ' + short);
      }
      return;
    }
    off += s.text.length + 1; // +1 for the '\n' join
  }
  if (kind === 'FAIL') { console.error('FAIL: ' + name + ' (line unknown)'); hardFails++; }
}

// ---- 1. forbidden tokens (code context only) -------------------------------
const tokenSpecs = [
  ['let declaration', /\blet\s+[A-Za-z_$]/g],
  ['const declaration', /\bconst\s+[A-Za-z_$]/g],
  ['class declaration', /\bclass\s+[A-Za-z_$]/g],
  ['arrow', /=>(?!=)/g],
  ['template literal', /`/g],
  ['optional chaining', /\?\./g],
  ['nullish coalescing', /\?\?(?!=)/g],
  ['rest param', /\.\.\.(?=[A-Za-z_$])/g],
  ['destructuring (var {)', /\b(?:var|let|const)\s*[\[{]/g]
];
for (const [name, re] of tokenSpecs) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(codeText)) !== null) {
    report('FAIL', name, m.index);
  }
}

// ---- 2. !(compound) precedence quirk ---------------------------------------
// Skill §11: `!(a && b || c)` — the parens are redundant per the JS spec so
// esbuild strips them, and the ES3 parser then mis-binds `!` to only the
// first comparison. Flag `!(` whose inner expression has a TOP-LEVEL && or
// ||, EXCLUDING `!!(` (double-bang) where the parens are REQUIRED (else
// `!!a && b` would parse differently — esbuild keeps them, no bug).
{
  const re = /!\(\s*([^()]|\([^()]*\))*?(&&|\|\|)/g;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(codeText)) !== null) {
    const before = codeText.slice(Math.max(0, m.index - 1), m.index);
    if (before === '!') { continue; } // !!() — parens required, not the quirk
    report('SUSPECT', '!(compound) precedence — verify each range is isolated', m.index);
  }
}

// ---- 3. genuinely-missing Array prototype methods (report-only) -------------
// Skill §11 census: the engine lacks Array.prototype.forEach/map/filter/
// reduce/every/some/indexOf/lastIndexOf, but STRING indexOf/lastIndexOf ARE
// native. So flag the unambiguous array methods; `x.indexOf(...)` on strings
// is fine and deliberately not reported.
{
  const re = /\.(?:forEach|map|filter|reduce|every|some)\(/g;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(codeText)) !== null) {
    report('SUSPECT', 'Array.prototype.' + (codeText.slice(m.index + 1).match(/^[a-zA-Z]+/) || ['?'])[0] + ' — verify own-loop ES3-safe', m.index);
  }
}

// ---- report ----------------------------------------------------------------
if (hardFails > 0) {
  console.error('audit-dist: ' + hardFails + ' HARD FAILURE(S) in ' + file);
  process.exit(1);
}
console.log('audit-dist: no forbidden tokens in ' + file + ' (' + segs.length + ' code segments, ' +
  codeText.length + ' code chars / ' + text.length + ' total bytes)');
if (suspects.length) {
  console.log('audit-dist: ' + suspects.length + ' suspect line(s) for manual triage:');
  for (const s of suspects) { console.log('  ' + s); }
} else {
  console.log('audit-dist: no suspect lines');
}
process.exit(0);
