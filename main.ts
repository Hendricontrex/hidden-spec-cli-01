// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** Leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A file's own line break, its lines and whether it ends with a break (SPEC.md section 3). */
interface FileParts { br: string; lines: string[]; finalBreak: boolean }
function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}
function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** Tier key of a line (SPEC.md section 5): 0 exact, 1 trim trailing space/tab, 2 trim both ends. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** First tier (0, 1, 2) at which O occurs in fileLines at or after `from`, and its positions. */
function findOccurrences(fileLines: string[], O: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (tierKey(fileLines[i + j]!, tier) !== tierKey(O[j]!, tier)) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: `ctx` is the index in O it is a context line of, else null (a new line). */
interface NLine { text: string; ctx: number | null }
/** Build the replacement lines: context lines come from the file, other lines are re-indented at tier 2. */
function buildNew(N: NLine[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const F = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  return N.map((n) => {
    if (n.ctx !== null) return fileLines[pos + n.ctx]!;
    if (tier === 2) {
      const t = n.text;
      if (t === '' || /^[ \t]+$/.test(t)) return t;
      if (t.startsWith(P)) return F + t.slice(P.length);
      return t;
    }
    return n.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output line. */
  readonly moves: [string, string][] = [];
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

type Edit = (tree: Tree) => void;

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

/* ---- Section 6: unified diffs ---- */

type BodyItem = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };
interface HunkRaw { a: number; items: BodyItem[] }
interface SectionRaw {
  dashOld: string | null; dashNew: string | null;
  renameOld: string | null; renameNew: string | null;
  diffOld: string | null; diffNew: string | null;
  newFileMode: boolean; deletedFileMode: boolean;
  hunks: HunkRaw[];
}

/** O and N of a hunk, and whether a `\` line follows its last context or `+` line. */
function hunkON(h: HunkRaw): { O: string[]; N: NLine[]; noEol: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const it of h.items) {
    if (it.kind === 'ctx') { O.push(it.text); N.push({ text: it.text, ctx: O.length - 1 }); }
    else if (it.kind === 'old') O.push(it.text);
    else if (it.kind === 'new') N.push({ text: it.text, ctx: null });
  }
  let noEol = false;
  let last = -1;
  for (let k = 0; k < h.items.length; k++) {
    if (h.items[k]!.kind === 'ctx' || h.items[k]!.kind === 'new') last = k;
  }
  if (last >= 0 && last + 1 < h.items.length && h.items[last + 1]!.kind === 'bs') noEol = true;
  return { O, N, noEol };
}

/** Whether a `\` line follows the last `+` line of all hunks (for a created file). */
function createNoEol(hunks: HunkRaw[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const items = hunks[hi]!.items;
    for (let k = items.length - 1; k >= 0; k--) {
      if (items[k]!.kind === 'new') return k + 1 < items.length && items[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Apply a section's hunks, in order, to a file's text; throws Fail on a hunk failure. */
function applyHunks(fileText: string, hunks: HunkRaw[], strict: boolean, filePath: string): string {
  const parts = splitFile(fileText);
  let lines = parts.lines;
  let finalBreak = parts.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { O, N, noEol } = hunkON(h);
    if (O.length === 0) {
      const L = lines.length;
      const idx = Math.max(0, Math.min(h.a + d, L));
      const add = N.map((x) => x.text);
      lines = [...lines.slice(0, idx), ...add, ...lines.slice(idx)];
      if (idx === L) finalBreak = !noEol;
      d += N.length;
    } else {
      const found = findOccurrences(lines, O, strict);
      if (!found) throw new Fail('no-match', filePath);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) { pos = p; best = dist; }
      }
      const atEnd = pos + O.length === lines.length;
      const repl = buildNew(N, lines, pos, O, found.tier);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
      if (atEnd) finalBreak = !noEol;
      d += N.length - O.length;
    }
  }
  return joinFile(lines, parts.br, finalBreak);
}

/** Path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, leading a/ or b/ removed. */
function dashPath(s: string): string {
  let p = s.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(.+) b\/(.+)$/;
  const sections: SectionRaw[] = [];
  const blankSection = (): SectionRaw => ({
    dashOld: null, dashNew: null, renameOld: null, renameNew: null,
    diffOld: null, diffNew: null, newFileMode: false, deletedFileMode: false, hunks: [],
  });
  let cur: SectionRaw | null = null;
  let inHeader = false;
  let hasPair = false;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = blankSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      hasPair = false;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const items: BodyItem[] = [];
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') { items.push({ kind: 'ctx', text: '' }); i++; continue; }
        const c = b[0]!;
        if (c === ' ') { items.push({ kind: 'ctx', text: b.slice(1) }); i++; continue; }
        if (c === '-') { items.push({ kind: 'old', text: b.slice(1) }); i++; continue; }
        if (c === '+') { items.push({ kind: 'new', text: b.slice(1) }); i++; continue; }
        if (c === '\\') { items.push({ kind: 'bs', text: b }); i++; continue; }
        break;
      }
      while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') items.pop();
      cur.hunks.push({ a, items });
      inHeader = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur === null || !inHeader || hasPair) {
          cur = blankSection();
          sections.push(cur);
          inHeader = true;
        }
        cur.dashOld = dashPath(line.slice(4));
        cur.dashNew = dashPath(lines[i + 1]!.slice(4));
        hasPair = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ') && cur !== null && inHeader) {
      cur.dashNew = dashPath(line.slice(4));
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFileMode = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFileMode = true;
    }
    i++;
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

function unifiedSectionEdit(sec: SectionRaw, strict: boolean): Edit {
  return (tree) => {
    let oldPath = sec.dashOld ?? sec.renameOld ?? sec.diffOld;
    let newPath = sec.dashNew ?? sec.renameNew ?? sec.diffNew;
    const oldDevNull = oldPath === '/dev/null';
    const newDevNull = newPath === '/dev/null';
    if (oldDevNull) oldPath = null;
    if (newDevNull) newPath = null;
    const isCreate = oldDevNull || sec.newFileMode;
    const isDelete = newDevNull || sec.deletedFileMode;
    for (const p of [oldPath, newPath]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate) {
      const target = newPath ?? oldPath;
      if (target === null) return;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      const noEol = createNoEol(sec.hunks);
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldPath ?? newPath;
      if (target === null) return;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunks(tree.get(oldPath)!, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const target = oldPath ?? newPath;
    if (target === null) return;
    if (tree.get(target) === null) throw new Fail('missing', target);
    tree.now.set(target, applyHunks(tree.get(target)!, sec.hunks, strict, target));
  };
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < n) {
    const searchIdx = lines.findIndex((l, idx) => idx >= i && isSearch(l));
    if (searchIdx < 0) break;
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const nextSearch = lines.findIndex((l, idx) => idx > searchIdx && isSearch(l));
    const limit = nextSearch < 0 ? n : nextSearch;
    const eqIdx = lines.findIndex((l, idx) => idx > searchIdx && idx < limit && l.trimEnd() === '=======');
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const repIdx = lines.findIndex((l, idx) => idx > eqIdx && idx < limit && l.trimEnd() === '>>>>>>> REPLACE');
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findOccurrences(parts.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const repl = buildNew(N, parts.lines, pos, oldLines, found.tier);
    const out = [...parts.lines.slice(0, pos), ...repl, ...parts.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, parts.br, parts.finalBreak));
  };
}

/* ---- Section 8: V4A patches ---- */

interface VChunk { anchor: string | null; body: BodyItem[]; eof: boolean }

function chunkON(ch: VChunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const it of ch.body) {
    if (it.kind === 'ctx') { O.push(it.text); N.push({ text: it.text, ctx: O.length - 1 }); }
    else if (it.kind === 'old') O.push(it.text);
    else if (it.kind === 'new') N.push({ text: it.text, ctx: null });
  }
  return { O, N };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  const isBody = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
  const bodyItem = (l: string): BodyItem => {
    if (l === '') return { kind: 'ctx', text: '' };
    const c = l[0]!;
    if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
    if (c === '-') return { kind: 'old', text: l.slice(1) };
    return { kind: 'new', text: l.slice(1) };
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const startNum = i + 1;
      const sec: { text: string; num: number }[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        sec.push({ text: l, num: i + 1 });
        i++;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      const fileLines: string[] = [];
      for (const s of sec) {
        if (s.text === '') fileLines.push('');
        else if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
        else throw new Exit2(`error: parse ${s.num}`);
      }
      edits.push(((p, fl) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      })(path, fileLines));
      void startNum;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const sec: { text: string; num: number }[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        sec.push({ text: l, num: i + 1 });
        i++;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      if (sec.length > 0) throw new Exit2(`error: parse ${sec[0]!.num}`);
      edits.push(((p) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateNum = i + 1;
      const sec: { text: string; num: number }[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        sec.push({ text: l, num: i + 1 });
        i++;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      let moveTo: string | null = null;
      let j = 0;
      if (j < sec.length && sec[j]!.text.startsWith('*** Move to: ')) {
        moveTo = sec[j]!.text.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      while (j < sec.length) {
        const l = sec[j]!;
        let anchor: string | null = null;
        if (l.text.startsWith('@@')) {
          anchor = l.text.slice(2).trim();
          if (anchor === '') anchor = null;
          j++;
        } else if (chunks.length === 0 && isBody(l.text)) {
          anchor = null;
        } else {
          throw new Exit2(`error: parse ${l.num}`);
        }
        const body: BodyItem[] = [];
        let eof = false;
        while (j < sec.length) {
          const b = sec[j]!;
          if (isBody(b.text)) { body.push(bodyItem(b.text)); j++; continue; }
          if (b.text.startsWith('@@')) break;
          if (b.text.trim() === '*** End of File') { eof = true; j++; break; }
          throw new Exit2(`error: parse ${b.num}`);
        }
        chunks.push({ anchor, body, eof });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNum}`);
      edits.push(((p, m, chs) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (m !== null && !safe(m)) throw new Fail('unsafe', m);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (m !== null && tree.get(m) !== null) throw new Fail('exists', m);
        const parts = splitFile(before);
        let curLines = parts.lines;
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            const foundA = findOccurrences(curLines, [ch.anchor], strict, cursor);
            if (!foundA) throw new Fail('no-match', p);
            cursor = foundA.positions[0]! + 1;
          }
          const { O, N } = chunkON(ch);
          if (O.length === 0) {
            const idx = ch.eof ? curLines.length : cursor;
            const add = N.map((x) => x.text);
            curLines = [...curLines.slice(0, idx), ...add, ...curLines.slice(idx)];
            cursor = idx + add.length;
          } else {
            const found = findOccurrences(curLines, O, strict, cursor);
            if (!found) throw new Fail('no-match', p);
            let pos: number | null = null;
            for (const q of found.positions) {
              if (ch.eof) {
                if (q + O.length === curLines.length) { pos = q; break; }
              } else {
                pos = q;
                break;
              }
            }
            if (pos === null) throw new Fail('no-match', p);
            const repl = buildNew(N, curLines, pos, O, found.tier);
            curLines = [...curLines.slice(0, pos), ...repl, ...curLines.slice(pos + O.length)];
            cursor = pos + repl.length;
          }
        }
        const out = joinFile(curLines, parts.br, parts.finalBreak);
        if (m !== null) {
          tree.now.set(p, null);
          tree.now.set(m, out);
          tree.moves.push([p, m]);
        } else {
          tree.now.set(p, out);
        }
      })(path, moveTo, chunks));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rMoves = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rMoves.set(newP, oldP);
    }
  }
  const rOlds = new Set([...rMoves.values()]);
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rMoves.has(p) || rOlds.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, oldP] of rMoves) rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
