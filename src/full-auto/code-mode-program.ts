/**
 * Strict recogniser for the only OpenCode v2 Code Mode programs Full-Auto may
 * pass through without a critic (#3446).
 *
 * The Code Mode sandbox is not limited to hooked tools: it also exposes
 * `fetch`, `Function`, `crypto`, `URL`, `Promise`, `JSON`, `Math` and `Date`
 * (observed on OpenCode 2.1.4), so "the wrapper only routes nested tool calls"
 * is false in general. A denylist over arbitrary JS cannot be made safe
 * (`Function(...)`, computed member access, string concatenation). Instead,
 * this module ACCEPTS a tiny grammar and rejects everything else:
 *
 *   program := ws [`return` ws] [`await` ws] callee ws `(` ws [value] ws `)` ws [`;`] ws
 *   callee  := `search` | `tools` segment+
 *   segment := `.` ident | `[` ws string ws `]`
 *   value   := string | number | `true` | `false` | `null` | object | array
 *   object  := `{` ws [pair (ws `,` ws pair)* [ws `,`]] ws `}`
 *   pair    := (ident | string) ws `:` ws value
 *
 * That is exactly one tool call whose argument is plain data: no identifiers
 * other than the callee path and object keys, so no other call, no member
 * access on a value, no computed keys, no templates, comments, regexes or
 * functions can appear. The nested call itself is still dispatched through the
 * same tool.execute.before chain under its own name and classified there.
 * Anything else (multi-statement, loops, variables, `fetch`, ...) returns
 * false and Full-Auto keeps escalating it to the critic.
 */

const MAX_PROGRAM_CHARS = 20_000;
const MAX_DEPTH = 8;

/** Property names that reach the prototype chain / the Function constructor. */
const BLOCKED_NAMES = new Set([
	'constructor',
	'prototype',
	'__proto__',
	'__defineGetter__',
	'__defineSetter__',
	'__lookupGetter__',
	'__lookupSetter__',
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
/**
 * Characters allowed in a bracketed tool-name literal, e.g. tools["mcp-mesh"].
 * No `.`: a dotted literal such as "a.b" could be resolved by the host as a
 * path, which is not a plain segment.
 */
const SEGMENT_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const WHITESPACE = /[ \t\r\n]/;
const SIMPLE_ESCAPES = new Set(['n', 'r', 't', '"', "'", '\\', '/']);

class Reader {
	pos = 0;
	constructor(readonly src: string) {}

	eof(): boolean {
		return this.pos >= this.src.length;
	}

	peek(): string {
		return this.src[this.pos] ?? '';
	}

	skipWs(): void {
		while (!this.eof() && WHITESPACE.test(this.peek())) this.pos += 1;
	}

	eat(ch: string): boolean {
		if (this.peek() === ch) {
			this.pos += 1;
			return true;
		}
		return false;
	}

	/** Consume `word` only when it is not the prefix of a longer identifier. */
	eatWord(word: string): boolean {
		if (!this.src.startsWith(word, this.pos)) return false;
		const next = this.src[this.pos + word.length] ?? '';
		if (next !== '' && IDENT_PART.test(next)) return false;
		this.pos += word.length;
		return true;
	}

	ident(): string | null {
		if (!IDENT_START.test(this.peek())) return null;
		const start = this.pos;
		this.pos += 1;
		while (!this.eof() && IDENT_PART.test(this.peek())) this.pos += 1;
		return this.src.slice(start, this.pos);
	}

	/** A quoted string with no template syntax and only simple escapes. */
	string(): string | null {
		const quote = this.peek();
		if (quote !== '"' && quote !== "'") return null;
		this.pos += 1;
		let out = '';
		while (!this.eof()) {
			const ch = this.peek();
			this.pos += 1;
			if (ch === quote) return out;
			if (ch === '\n' || ch === '\r') return null;
			if (ch === '\\') {
				const esc = this.peek();
				if (!SIMPLE_ESCAPES.has(esc)) return null;
				this.pos += 1;
				out += esc;
				continue;
			}
			out += ch;
		}
		return null; // unterminated
	}

	number(): boolean {
		const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
		if (!m) return false;
		this.pos += m[0].length;
		return true;
	}
}

function parseValue(r: Reader, depth: number): boolean {
	if (depth > MAX_DEPTH) return false;
	r.skipWs();
	const ch = r.peek();
	if (ch === '"' || ch === "'") return r.string() !== null;
	if (ch === '{') return parseObject(r, depth + 1);
	if (ch === '[') return parseArray(r, depth + 1);
	if (r.eatWord('true') || r.eatWord('false') || r.eatWord('null')) return true;
	return r.number();
}

function parseArray(r: Reader, depth: number): boolean {
	if (!r.eat('[')) return false;
	r.skipWs();
	if (r.eat(']')) return true;
	for (;;) {
		if (!parseValue(r, depth)) return false;
		r.skipWs();
		if (r.eat(',')) {
			r.skipWs();
			if (r.eat(']')) return true; // trailing comma
			continue;
		}
		return r.eat(']');
	}
}

function parseObject(r: Reader, depth: number): boolean {
	if (!r.eat('{')) return false;
	r.skipWs();
	if (r.eat('}')) return true;
	for (;;) {
		r.skipWs();
		const key = r.peek() === '"' || r.peek() === "'" ? r.string() : r.ident();
		if (key === null || BLOCKED_NAMES.has(key)) return false;
		r.skipWs();
		if (!r.eat(':')) return false;
		if (!parseValue(r, depth)) return false;
		r.skipWs();
		if (r.eat(',')) {
			r.skipWs();
			if (r.eat('}')) return true; // trailing comma
			continue;
		}
		return r.eat('}');
	}
}

function parseCallee(r: Reader): boolean {
	if (r.eatWord('search')) return true;
	if (!r.eatWord('tools')) return false;
	let segments = 0;
	for (;;) {
		r.skipWs();
		if (r.eat('.')) {
			r.skipWs();
			const name = r.ident();
			if (name === null || BLOCKED_NAMES.has(name)) return false;
			segments += 1;
			continue;
		}
		if (r.peek() === '[') {
			r.pos += 1;
			r.skipWs();
			const name = r.string();
			r.skipWs();
			if (
				name === null ||
				!SEGMENT_NAME.test(name) ||
				BLOCKED_NAMES.has(name) ||
				!r.eat(']')
			) {
				return false;
			}
			segments += 1;
			continue;
		}
		return segments > 0;
	}
}

/**
 * True only when `code` is exactly one `tools.<path>(<plain data>)` or
 * `search(<plain data>)` call, optionally prefixed by `return` and/or `await`.
 */
export function isSingleToolCallProgram(code: unknown): boolean {
	if (typeof code !== 'string') return false;
	if (code.length === 0 || code.length > MAX_PROGRAM_CHARS) return false;
	const r = new Reader(code);
	r.skipWs();
	r.eatWord('return');
	r.skipWs();
	r.eatWord('await');
	r.skipWs();
	if (!parseCallee(r)) return false;
	r.skipWs();
	if (!r.eat('(')) return false;
	r.skipWs();
	if (!r.eat(')')) {
		if (!parseValue(r, 0)) return false;
		r.skipWs();
		if (!r.eat(')')) return false;
	}
	r.skipWs();
	r.eat(';');
	r.skipWs();
	return r.eof();
}
