/**
 * A small, safe formula evaluator. A spec writes its formula as text ("L / (Kd + L)") and this turns it into a function.
 * There is no eval and no new Function: the text is parsed into a tree and the tree is turned into closures.
 *
 *   numbers       3   0.5   .5   1e-6   2.5E3
 *   operators     + - * / ^   (^ binds tighter than unary minus, so -2^2 is -4, and is right-associative)
 *   brackets      ( )
 *   functions     ln log10 exp sqrt abs min max sin cos tan asin acos atan   (trigonometry is in radians)
 *   constants     pi
 *   symbols       any name the caller lists: letters (Latin or Greek), digits and underscores, not starting with a digit
 *
 * Pure: no DOM.
 */

export class ExprError extends Error {
  constructor(message: string, readonly position: number) { super(message); this.name = 'ExprError'; }
}

type Node =
  | { t: 'num'; v: number }
  | { t: 'sym'; name: string; pos: number }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[]; pos: number };

const FUNCTIONS: Record<string, { arity: [number, number]; run: (...a: number[]) => number }> = {
  ln: { arity: [1, 1], run: Math.log },
  log10: { arity: [1, 1], run: Math.log10 },
  exp: { arity: [1, 1], run: Math.exp },
  sqrt: { arity: [1, 1], run: Math.sqrt },
  abs: { arity: [1, 1], run: Math.abs },
  sin: { arity: [1, 1], run: Math.sin },
  cos: { arity: [1, 1], run: Math.cos },
  tan: { arity: [1, 1], run: Math.tan },
  asin: { arity: [1, 1], run: Math.asin },
  acos: { arity: [1, 1], run: Math.acos },
  atan: { arity: [1, 1], run: Math.atan },
  min: { arity: [2, 8], run: Math.min },
  max: { arity: [2, 8], run: Math.max },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI };
/** Own properties only: "constructor" and "toString" are not words of the formula. */
const has = (table: object, name: string) => Object.prototype.hasOwnProperty.call(table, name);

/** Words a symbol cannot use, because the formula already gives them a meaning. */
export const RESERVED = new Set([...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)]);

const MAX_LENGTH = 400;
const MAX_DEPTH = 40;

interface Token { kind: 'num' | 'id' | 'op' | 'end'; text: string; value?: number; pos: number }

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT = /^[A-Za-z_Ͱ-Ͽἀ-῿][A-Za-z0-9_Ͱ-Ͽἀ-῿]*/;

function tokenise(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = src.slice(i);
    const n = NUMBER.exec(rest);
    if (n) {
      // "2x" or "3(": a missing sign is the usual slip, and guessing what was meant would hide it.
      out.push({ kind: 'num', text: n[0], value: Number(n[0]), pos: i });
      i += n[0].length;
      continue;
    }
    const id = IDENT.exec(rest);
    if (id) { out.push({ kind: 'id', text: id[0], pos: i }); i += id[0].length; continue; }
    const op = ({ '×': '*', '·': '*', '÷': '/', '−': '-', '–': '-', '**': '^' } as Record<string, string>)[ch] ?? ch;
    if (rest.startsWith('**')) { out.push({ kind: 'op', text: '^', pos: i }); i += 2; continue; }
    if ('+-*/^(),'.includes(op)) { out.push({ kind: 'op', text: op, pos: i }); i++; continue; }
    throw new ExprError(`"${ch}" is not allowed in a formula`, i);
  }
  out.push({ kind: 'end', text: '', pos: src.length });
  return out;
}

export function parse(src: string): Node {
  if (typeof src !== 'string' || !src.trim()) throw new ExprError('the formula is empty', 0);
  if (src.length > MAX_LENGTH) throw new ExprError(`the formula is longer than ${MAX_LENGTH} characters`, MAX_LENGTH);
  const tokens = tokenise(src);
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const isOp = (text: string) => peek().kind === 'op' && peek().text === text;

  const expect = (text: string) => {
    if (!isOp(text)) {
      const t = peek();
      throw new ExprError(t.kind === 'end' ? `the formula ends where "${text}" was expected` : `expected "${text}" but found "${t.text}"`, t.pos);
    }
    take();
  };

  const expression = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new ExprError('the formula is nested too deeply', peek().pos);
    let left = term(depth);
    while (isOp('+') || isOp('-')) {
      const op = take().text as '+' | '-';
      left = { t: 'bin', op, a: left, b: term(depth) };
    }
    return left;
  };
  const term = (depth: number): Node => {
    let left = unary(depth);
    while (isOp('*') || isOp('/')) {
      const op = take().text as '*' | '/';
      left = { t: 'bin', op, a: left, b: unary(depth) };
    }
    return left;
  };
  const unary = (depth: number): Node => {
    if (isOp('-')) { take(); return { t: 'neg', a: unary(depth + 1) }; }
    if (isOp('+')) { take(); return unary(depth + 1); }
    return power(depth);
  };
  const power = (depth: number): Node => {
    const base = atom(depth);
    if (isOp('^')) { take(); return { t: 'bin', op: '^', a: base, b: unary(depth + 1) }; }
    return base;
  };
  const atom = (depth: number): Node => {
    const t = take();
    if (t.kind === 'num') {
      if (peek().kind === 'id' || isOp('(')) throw new ExprError(`put a "*" between "${t.text}" and "${peek().text}"`, peek().pos);
      return { t: 'num', v: t.value as number };
    }
    if (t.kind === 'id') {
      if (isOp('(')) {
        take();
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(expression(depth + 1));
          while (isOp(',')) { take(); args.push(expression(depth + 1)); }
        }
        expect(')');
        return { t: 'call', fn: t.text, args, pos: t.pos };
      }
      if (peek().kind === 'id' || peek().kind === 'num') throw new ExprError(`put a "*" between "${t.text}" and "${peek().text}"`, peek().pos);
      return { t: 'sym', name: t.text, pos: t.pos };
    }
    if (t.kind === 'op' && t.text === '(') {
      const inner = expression(depth + 1);
      expect(')');
      return inner;
    }
    throw new ExprError(t.kind === 'end' ? 'the formula ends too soon' : `unexpected "${t.text}"`, t.pos);
  };

  const tree = expression(0);
  if (peek().kind !== 'end') throw new ExprError(`unexpected "${peek().text}"`, peek().pos);
  return tree;
}

/** Every symbol a formula uses (not functions, not constants), in order of first use. */
export function symbolsOf(src: string): string[] {
  const found: string[] = [];
  const walk = (n: Node) => {
    if (n.t === 'sym') { if (!has(CONSTANTS, n.name) && !found.includes(n.name)) found.push(n.name); }
    else if (n.t === 'neg') walk(n.a);
    else if (n.t === 'bin') { walk(n.a); walk(n.b); }
    else if (n.t === 'call') n.args.forEach(walk);
  };
  walk(parse(src));
  return found;
}

/**
 * Turn a formula into a function. `names` lists the symbols the function will be given, in order, and anything else the
 * formula mentions is an error (so a typo is found when the spec is checked, not when a student reaches it).
 */
export function compile(src: string, names: readonly string[]): (values: readonly number[]) => number {
  const index = new Map(names.map((n, i) => [n, i]));
  const build = (n: Node): ((v: readonly number[]) => number) => {
    switch (n.t) {
      case 'num': { const k = n.v; return () => k; }
      case 'sym': {
        if (has(CONSTANTS, n.name)) { const k = CONSTANTS[n.name]; return () => k; }
        const i = index.get(n.name);
        if (i === undefined) throw new ExprError(`"${n.name}" is not a symbol this formula can use`, n.pos);
        return (v) => v[i];
      }
      case 'neg': { const a = build(n.a); return (v) => -a(v); }
      case 'bin': {
        const a = build(n.a); const b = build(n.b);
        switch (n.op) {
          case '+': return (v) => a(v) + b(v);
          case '-': return (v) => a(v) - b(v);
          case '*': return (v) => a(v) * b(v);
          case '/': return (v) => a(v) / b(v);
          default: return (v) => Math.pow(a(v), b(v));
        }
      }
      case 'call': {
        const f = has(FUNCTIONS, n.fn) ? FUNCTIONS[n.fn] : undefined;
        if (!f) throw new ExprError(`"${n.fn}" is not a function this formula knows (it knows ${Object.keys(FUNCTIONS).join(', ')})`, n.pos);
        const [lo, hi] = f.arity;
        if (n.args.length < lo || n.args.length > hi) throw new ExprError(`${n.fn} takes ${lo === hi ? lo : `${lo} to ${hi}`} value${hi === 1 ? '' : 's'}, not ${n.args.length}`, n.pos);
        const args = n.args.map(build);
        if (args.length === 1) { const [a] = args; return (v) => f.run(a(v)); }
        if (args.length === 2) { const [a, b] = args; return (v) => f.run(a(v), b(v)); }
        return (v) => f.run(...args.map((g) => g(v)));
      }
    }
  };
  return build(parse(src));
}
