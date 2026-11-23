// main.ts is mend, the CLI SPEC.md specifies: one patch tool for the four edit
// formats AI models write (unified diff, SEARCH/REPLACE blocks, V4A patches and
// JSON tool calls), finding the lines an edit names at the first of three
// matching tiers and changing every file or none. Node 22, standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under its own line break (SPEC section 3). */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** One body line of a hunk or chunk: context, old, or new. */
type Op = { kind: 'ctx' | 'old' | 'new'; text: string };

/** Matching (SPEC section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

interface Occ {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs in `file` at or after `from`, and every
 *  position there; for endOnly only occurrences ending at the last line. */
function findOccurrences(file: string[], o: string[], strict: boolean, from = 0, endOnly = false): Occ | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const normO = o.map((l) => normLine(l, t));
    const pos: number[] = [];
    for (let i = from; i + o.length <= file.length; i++) {
      if (endOnly && i + o.length !== file.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (normLine(file[i + j]!, t) !== normO[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Tier 2 re-indentation of one new line (SPEC section 5). */
function reindent(t: string, tier: number, f: string, p: string, hasO: boolean): string {
  if (tier === 2 && hasO && t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
  return t;
}

/** N of a hunk/chunk, given its ops: context lines are the file's own matched
 *  lines, new lines are written as they are (tier 2 re-indented). */
function buildNewLines(file: string[], pos: number, ops: Op[], tier: number): string[] {
  const oLines = ops.filter((x) => x.kind !== 'new').map((x) => x.text);
  const f = oLines.length > 0 ? leadingWs(file[pos]!) : '';
  const p = oLines.length > 0 ? leadingWs(oLines[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(file[pos + oi]!);
      oi++;
    } else if (op.kind === 'old') {
      oi++;
    } else {
      out.push(reindent(op.text, tier, f, p, oLines.length > 0));
    }
  }
  return out;
}

/** N of a SEARCH/REPLACE block (no context lines): every line is new. */
function replaceLines(file: string[], pos: number, o: string[], n: string[], tier: number): string[] {
  const f = o.length > 0 ? leadingWs(file[pos]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  return n.map((t) => reindent(t, tier, f, p, o.length > 0));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** An edit: applies itself to the tree, or throws Fail; returns the move pair
 *  when it moves a file, else null. It touches tree.now only once it knows it
 *  will succeed, so a failed edit changes nothing. */
type Edit = (tree: Tree) => [string, string] | null;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
      return null;
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
      return null;
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                    */
/* ------------------------------------------------------------------ */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)/;

interface Hunk {
  a: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function cleanHeaderPath(raw: string): string {
  const p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunkBody(lines: string[], j: number): { ops: Op[]; noEol: boolean; plusNoEol: boolean; next: number } {
  type Ent = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };
  const ents: Ent[] = [];
  let k = j;
  while (k < lines.length) {
    const l = lines[k]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      ents.push({ kind: 'ctx', text: '' });
      k++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      ents.push({ kind: 'ctx', text: l.slice(1) });
      k++;
      continue;
    }
    if (c === '-') {
      ents.push({ kind: 'old', text: l.slice(1) });
      k++;
      continue;
    }
    if (c === '+') {
      ents.push({ kind: 'new', text: l.slice(1) });
      k++;
      continue;
    }
    if (c === '\\') {
      ents.push({ kind: 'bs', text: l.slice(1) });
      k++;
      continue;
    }
    break;
  }
  while (ents.length > 0) {
    const last = ents[ents.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') ents.pop();
    else break;
  }
  const ops: Op[] = ents.filter((e) => e.kind !== 'bs').map((e) => ({ kind: e.kind as 'ctx' | 'old' | 'new', text: e.text }));
  let noEol = false;
  let plusNoEol = false;
  for (let q = ents.length - 1; q >= 0; q--) {
    if (ents[q]!.kind === 'ctx' || ents[q]!.kind === 'new') {
      noEol = q + 1 < ents.length && ents[q + 1]!.kind === 'bs';
      break;
    }
  }
  for (let q = ents.length - 1; q >= 0; q--) {
    if (ents[q]!.kind === 'new') {
      plusNoEol = q + 1 < ents.length && ents[q + 1]!.kind === 'bs';
      break;
    }
  }
  return { ops, noEol, plusNoEol, next: k };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const finish = (): void => {
    if (cur) sections.push(cur);
    cur = null;
    inHeader = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      cur = { diffOld: m[1]!, diffNew: m[2]!, headOld: null, headNew: null, renameOld: null, renameNew: null, isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: parseInt(m[1]!, 10), ops: body.ops, noEol: body.noEol, plusNoEol: body.plusNoEol });
      inHeader = false;
      i = body.next;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && inHeader && cur.headOld === null) {
          cur.headOld = cleanHeaderPath(line.slice(4));
          cur.headNew = cleanHeaderPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        finish();
        cur = { diffOld: null, diffNew: null, headOld: cleanHeaderPath(line.slice(4)), headNew: cleanHeaderPath(lines[i + 1]!.slice(4)), renameOld: null, renameNew: null, isCreate: false, isDelete: false, hunks: [] };
        inHeader = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        if (cur.headNew === null) cur.headNew = cleanHeaderPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
    }
    i++;
  }
  finish();
  return sections;
}

function sectionPaths(s: Section): { old: string | null; nw: string | null } {
  const toNull = (p: string | null): string | null => (p === '/dev/null' ? null : p);
  return { old: toNull(s.headOld ?? s.renameOld ?? s.diffOld), nw: toNull(s.headNew ?? s.renameNew ?? s.diffNew) };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const { old, nw } = sectionPaths(sec);
    if (old !== null && !safe(old)) throw new Fail('unsafe', old);
    if (nw !== null && !safe(nw)) throw new Fail('unsafe', nw);
    if (old === null && nw === null) throw new Fail('unsafe', '/dev/null');
    const isCreate = old === null || sec.isCreate;
    if (isCreate && nw === null) throw new Fail('unsafe', '/dev/null');
    const isDelete = !isCreate && (nw === null || sec.isDelete);
    if (isCreate) {
      const target = nw!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'new') plus.push(op.text);
      let plusNoEol = false;
      for (let h = sec.hunks.length - 1; h >= 0; h--) {
        if (sec.hunks[h]!.ops.some((o) => o.kind === 'new')) {
          plusNoEol = sec.hunks[h]!.plusNoEol;
          break;
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (plusNoEol ? '' : '\n'));
      return null;
    }
    if (isDelete) {
      const target = old!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return null;
    }
    const target = old!;
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    const isMove = nw !== null && nw !== old;
    if (isMove && tree.get(nw) !== null) throw new Fail('exists', nw);
    const model = splitFile(before);
    let lines = model.lines;
    let final = model.final;
    let d = 0;
    for (const h of sec.hunks) {
      const oLines = h.ops.filter((o) => o.kind !== 'new').map((o) => o.text);
      if (oLines.length === 0) {
        const ins = h.ops.filter((o) => o.kind === 'new').map((o) => o.text);
        const at = Math.max(0, Math.min(h.a + d, lines.length));
        const atEnd = at === lines.length;
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        if (atEnd) final = !h.noEol;
        d += ins.length;
        continue;
      }
      const occ = findOccurrences(lines, oLines, strict);
      if (!occ) throw new Fail('no-match', target);
      const want = h.a - 1 + d;
      let best = occ.positions[0]!;
      for (const p of occ.positions) {
        if (Math.abs(p - want) < Math.abs(best - want)) best = p;
      }
      const newLines = buildNewLines(lines, best, h.ops, occ.tier);
      const toEof = best + oLines.length === lines.length;
      lines = [...lines.slice(0, best), ...newLines, ...lines.slice(best + oLines.length)];
      if (toEof) final = !h.noEol;
      d += newLines.length - oLines.length;
    }
    const text = joinFile({ br: model.br, lines, final });
    if (isMove) {
      tree.now.set(old, null);
      tree.now.set(nw, text);
      return [old, nw];
    }
    tree.now.set(old, text);
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return null;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = splitFile(before);
    const occ = findOccurrences(model.lines, b.oldLines, strict);
    if (!occ) throw new Fail('no-match', p);
    if (occ.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = occ.positions[0]!;
    const newLines = replaceLines(model.lines, pos, b.oldLines, b.newLines, occ.tier);
    const lines = [...model.lines.slice(0, pos), ...newLines, ...model.lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, joinFile({ br: model.br, lines, final: model.final }));
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
}

function isV4ASectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function parseV4AChunks(raw: string[], base: number): V4AChunk[] {
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    if (l.trim() === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${base + k + 1}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (!cur) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${base + k + 1}`);
        cur = { anchor: null, eof: false, ops: [] };
      }
      if (l === '') cur.ops.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.ops.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.ops.push({ kind: 'old', text: l.slice(1) });
      else cur.ops.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${base + k + 1}`);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ')) {
      const isAdd = line.startsWith('*** Add File: ');
      const path = line.slice((isAdd ? '*** Add File: ' : '*** Delete File: ').length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isV4ASectionStart(l) || l.trim() === '*** End Patch') break;
        raw.push(l);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      if (isAdd) {
        const ls: string[] = [];
        for (let k = 0; k < raw.length; k++) {
          const l = raw[k]!;
          if (l.startsWith('+')) ls.push(l.slice(1));
          else if (l === '') ls.push('');
          else throw new Exit2(`error: parse ${i + 1 + k + 1}`);
        }
        sections.push({ kind: 'add', path, moveTo: null, lines: ls, chunks: [] });
      } else {
        if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
        sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [] });
      }
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const raw: string[] = [];
      while (j < last) {
        const l = lines[j]!;
        if (isV4ASectionStart(l) || l.trim() === '*** End Patch') break;
        raw.push(l);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const base = j - raw.length;
      const chunks = parseV4AChunks(raw, base);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return null;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return null;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const model = splitFile(before);
    let lines = model.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const aocc = findOccurrences(lines, [ch.anchor], strict, cursor);
        if (!aocc) throw new Fail('no-match', p);
        cursor = aocc.positions[0]! + 1;
      }
      const oLines = ch.ops.filter((o) => o.kind !== 'new').map((o) => o.text);
      if (oLines.length === 0) {
        const ins = ch.ops.filter((o) => o.kind === 'new').map((o) => o.text);
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      const occ = ch.eof ? findOccurrences(lines, oLines, strict, cursor, true) : findOccurrences(lines, oLines, strict, cursor);
      if (!occ) throw new Fail('no-match', p);
      const pos = occ.positions[0]!;
      const newLines = buildNewLines(lines, pos, ch.ops, occ.tier);
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos + oLines.length)];
      cursor = pos + newLines.length;
    }
    const text = joinFile({ br: model.br, lines, final: model.final });
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, text);
      return [p, sec.moveTo];
    }
    tree.now.set(p, text);
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC sections 1, 2 and 10)                                  */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4A(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
    kind: 'A' | 'D' | 'M' | 'R';
    path: string;
    newPath: string | null;
  }
  const rows: Row[] = [];
  const suppressed = new Set<string>();
  for (const [old, nw] of moves) {
    const wasOld = tree.original(old);
    const nowOld = tree.get(old);
    const wasNew = tree.original(nw);
    const nowNew = tree.get(nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}`, kind: 'R', path: old, newPath: nw });
      suppressed.add(`D:${old}`);
      suppressed.add(`A:${nw}`);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    if (suppressed.has(`${kind}:${p}`)) continue;
    rows.push({ key: p, line: `${kind} ${p}`, kind, path: p, newPath: null });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const r of rows) {
      if (r.kind === 'D' || r.kind === 'R') rmSync(r.path, { force: true });
    }
    for (const r of rows) {
      if (r.kind === 'A' || r.kind === 'M') {
        const target = r.path;
        try {
          if (statSync(target).isDirectory()) rmSync(target, { recursive: true, force: true });
        } catch {
          /* not present, or not a directory */
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, tree.now.get(target)!);
      } else if (r.kind === 'R') {
        const target = r.newPath!;
        try {
          if (statSync(target).isDirectory()) rmSync(target, { recursive: true, force: true });
        } catch {
          /* not present, or not a directory */
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, tree.now.get(target)!);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
