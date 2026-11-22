// main.ts is mend, the CLI SPEC.md specifies. It applies an edit an AI model wrote — a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON text-editor calls — to a tree of text files, all or nothing, with three-tier line
// matching (exact, trailing-whitespace-insensitive, fully-trimmed with re-indentation). Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Tier matching (SPEC.md section 5). */
const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in lines at one tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!tierEq(O[k]!, lines[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (tier 0 only when strict), with its positions. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a replacement: `ctx` is its index in O for a context line, -1 for an added line. */
interface RepLine {
  text: string;
  ctx: number;
}

/** The lines N writes over O matched at `pos`: context lines come from the file itself, added lines are
 *  re-indented at tier 2 (SPEC.md section 5). */
function buildReplacement(lines: string[], pos: number, O: string[], N: RepLine[], tier: number): string[] {
  const F = O.length > 0 ? leadWs(lines[pos]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  const out: string[] = [];
  for (const nl of N) {
    if (nl.ctx >= 0) {
      out.push(lines[pos + nl.ctx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk. `noeol` is set by a `\` line after it. */
type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyEntry {
  kind: BodyKind;
  text: string;
  noeol: boolean;
}

interface Hunk {
  a: number;
  body: BodyEntry[];
}

/** O and N of a hunk or chunk body, in body order. */
function hunkON(h: { body: BodyEntry[] }): { O: string[]; N: RepLine[] } {
  const O: string[] = [];
  const N: RepLine[] = [];
  for (const e of h.body) {
    if (e.kind === ' ') {
      O.push(e.text);
      N.push({ text: e.text, ctx: O.length - 1 });
    } else if (e.kind === '-') {
      O.push(e.text);
    } else if (e.kind === '+') {
      N.push({ text: e.text, ctx: -1 });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxPlusNoeol(h: { body: BodyEntry[] }): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const e = h.body[k]!;
    if (e.kind === ' ' || e.kind === '+') return e.noeol;
  }
  return false;
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h);
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const ins = buildReplacement(f.lines, at, O, N, 0);
      const atEnd = at === f.lines.length;
      f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
      if (atEnd) f.final = !lastCtxPlusNoeol(h);
      d += N.length;
    } else {
      const found = findTier(O, f.lines, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const ins = buildReplacement(f.lines, best, O, N, found.tier);
      const atEnd = best + O.length === f.lines.length;
      f.lines = [...f.lines.slice(0, best), ...ins, ...f.lines.slice(best + O.length)];
      if (atEnd) f.final = !lastCtxPlusNoeol(h);
      d += N.length - O.length;
    }
  }
  return joinFile(f);
}

/** One unified-diff section (SPEC.md section 6). Paths are undefined when unnamed, null for /dev/null. */
interface USection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  rnOld: string | undefined;
  rnNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:[ \t].*)?$/;
  const pathOf = (l: string): string | null => {
    const t = l.slice(4).split('\t')[0]!.trim();
    if (t === '/dev/null') return null;
    if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
    return t;
  };
  const newSection = (s: USection): void => {
    cur = s;
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = diffRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection({ gitOld: m[1]!, gitNew: m[2]!, hdrOld: undefined, hdrNew: undefined, rnOld: undefined, rnNew: undefined, create: false, del: false, hunks: [] });
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          if (bl[0] === '\\') {
            const prev = hunk.body[hunk.body.length - 1];
            if (prev === undefined) throw new Exit2(`error: parse ${i + 1}`);
            prev.noeol = true;
            hunk.body.push({ kind: '\\', text: bl.slice(1), noeol: false });
          } else {
            hunk.body.push({ kind: bl === '' ? ' ' : (bl[0] as BodyKind), text: bl.slice(1), noeol: false });
          }
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        newSection({ gitOld: undefined, gitNew: undefined, hdrOld: pathOf(l), hdrNew: pathOf(lines[i + 1]!), rnOld: undefined, rnNew: undefined, create: false, del: false, hunks: [] });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.hdrOld === undefined) cur.hdrOld = pathOf(l);
        if (cur.hdrNew === undefined) cur.hdrNew = pathOf(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        if (cur.hdrNew === undefined) cur.hdrNew = pathOf(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (cur.rnOld === undefined) cur.rnOld = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (cur.rnNew === undefined) cur.rnNew = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      newSection({ gitOld: undefined, gitNew: undefined, hdrOld: pathOf(l), hdrNew: pathOf(lines[i + 1]!), rnOld: undefined, rnNew: undefined, create: false, del: false, hunks: [] });
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldP = sec.hdrOld !== undefined ? sec.hdrOld : sec.rnOld !== undefined ? sec.rnOld : sec.gitOld;
    const newP = sec.hdrNew !== undefined ? sec.hdrNew : sec.rnNew !== undefined ? sec.rnNew : sec.gitNew;
    const hunks = sec.hunks;
    if (oldP === null || sec.create) {
      const np = newP;
      return (tree: Tree): void => {
        if (np === undefined || np === null) return;
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const out: string[] = [];
        let lastPlusNoeol = false;
        for (const h of hunks) {
          for (const e of h.body) {
            if (e.kind === '+') {
              out.push(e.text);
              lastPlusNoeol = e.noeol;
            }
          }
        }
        tree.now.set(np, out.length === 0 ? '' : out.join('\n') + (lastPlusNoeol ? '' : '\n'));
      };
    }
    if (newP === null || sec.del) {
      const op = oldP;
      return (tree: Tree): void => {
        if (op === undefined || op === null) return;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      };
    }
    if (oldP !== undefined && newP !== undefined && oldP !== newP) {
      return (tree: Tree): void => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const result = applyHunks(before, hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, result);
        tree.moves.push([oldP, newP]);
      };
    }
    const p = oldP !== undefined ? oldP : newP;
    return (tree: Tree): void => {
      if (p === undefined || p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, hunks, strict, p));
    };
  });
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    nw: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old: lines.slice(searchIdx + 1, sep), nw: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const p = b.path;
    const oldLines = b.old;
    const newLines = b.nw;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(oldLines, f.lines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const ins = buildReplacement(f.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), found.tier);
      f.lines = [...f.lines.slice(0, pos), ...ins, ...f.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile(f));
    };
  });
}

/** One V4A chunk (SPEC.md section 8). `anchor` null means the chunk started at a body line. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

/** V4A patches (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = sectionKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(l.indexOf(': ') + 2).trim();
    const startLine = i;
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < last) {
      if (sectionKind(lines[i]!) !== null) break;
      raw.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const out: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) out.push(r.text.slice(1));
        else if (r.text === '') out.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (const r of raw) throw new Exit2(`error: parse ${r.no}`);
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | undefined;
      let k = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const pushChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          pushChunk();
          cur = { anchor: t.slice(2).trim(), eof: false, body: [] };
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ kind: (t === '' ? ' ' : t[0] as BodyKind), text: t === '' ? '' : t.slice(1), noeol: false });
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          pushChunk();
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${startLine + 1}`);
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null && chunk.anchor !== '') {
            const found = findTier([chunk.anchor], f.lines, strict, cursor);
            if (found === null) throw new Fail('no-match', path);
            cursor = found.pos[0]! + 1;
          }
          const { O, N } = hunkON(chunk);
          if (O.length === 0) {
            const at = chunk.eof ? f.lines.length : cursor;
            const ins = buildReplacement(f.lines, at, O, N, 0);
            f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
            cursor = at + ins.length;
          } else {
            const found = findTier(O, f.lines, strict, cursor);
            if (found === null) throw new Fail('no-match', path);
            let positions = found.pos;
            if (chunk.eof) positions = positions.filter((pos) => pos + O.length === f.lines.length);
            if (positions.length === 0) throw new Fail('no-match', path);
            const pos = positions[0]!;
            const ins = buildReplacement(f.lines, pos, O, N, found.tier);
            f.lines = [...f.lines.slice(0, pos), ...ins, ...f.lines.slice(pos + O.length)];
            cursor = pos + ins.length;
          }
        }
        const result = joinFile(f);
        if (moveTo !== undefined) {
          tree.now.set(path, null);
          tree.now.set(moveTo, result);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, result);
        }
      });
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
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
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && !consumed.has(oldP) && !consumed.has(newP)) {
      consumed.add(oldP);
      consumed.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!consumed.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
