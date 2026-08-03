/**
 * Source scanner for the Phase 4.2 `session.create` guardrail.
 *
 * Extracted from `tests/unit/config/session-create-directory-guardrail.test.ts`
 * to keep that file under the FR-006 500-line cap, and so the tokenizer can be
 * exercised directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Blanks comments while preserving line numbering and byte offsets.
 *
 * This MUST understand string, template-literal and regex-literal context. A
 * naive three-state (code/line/block) stripper treats the first `/*` inside a
 * string literal as the start of a block comment and blanks the entire rest of
 * the file — so any `session.create(` after it becomes invisible and the
 * guardrail silently stops guarding. Seven files in `src/` contain such a
 * literal today (glob patterns like `'**''/*.ts'`, `'/*'` in prose strings),
 * including this feature's own `src/config/lane-permissions.ts`.
 *
 * The returned `state` must be `'code'` for well-formed TypeScript. Any other
 * terminal state means the tokenizer lost track and the scan for that file is
 * untrustworthy — {@link discoverSites} asserts on it rather than silently
 * producing a short list.
 */
type StripState =
	| 'code'
	| 'line'
	| 'block'
	| 'single'
	| 'double'
	| 'template'
	| 'regex';

/**
 * Characters/keywords after which a `/` begins a regex literal rather than a
 * division operator. Standard heuristic; ambiguity in JS is unresolvable
 * without a full parser, and the terminal-state assertion catches a mistake.
 */
const REGEX_PRECEDING_PUNCT = new Set([
	'(',
	',',
	'=',
	':',
	'[',
	'!',
	'&',
	'|',
	'?',
	'{',
	'}',
	';',
	'\n',
	'+',
	'-',
	'*',
	'%',
	'<',
	'>',
	'~',
	'^',
]);
const REGEX_PRECEDING_KEYWORDS = [
	'return',
	'typeof',
	'instanceof',
	'in',
	'of',
	'new',
	'delete',
	'void',
	'throw',
	'do',
	'else',
	'yield',
	'await',
	'case',
];

/**
 * Longest keyword in {@link REGEX_PRECEDING_KEYWORDS} is `instanceof` (10), plus
 * a boundary char and trailing whitespace. 32 emitted characters is comfortably
 * more than any decision needs.
 */
const REGEX_LOOKBEHIND = 32;

/**
 * Last few emitted characters, WITHOUT rebuilding the whole output buffer.
 *
 * `out.join('')` here was O(n) per `/` in code state, i.e. O(n^2) over a file —
 * measured at 5.92 s across `src/`. The regex-start decision only ever looks at
 * the trailing token, so a bounded tail is equivalent.
 */
function recentTail(out: readonly string[]): string {
	let tail = '';
	for (
		let i = out.length - 1;
		i >= 0 && tail.length < REGEX_LOOKBEHIND;
		i -= 1
	) {
		tail = out[i] + tail;
	}
	return tail;
}

function regexCanStartHere(emitted: string): boolean {
	const trimmed = emitted.replace(/\s+$/, '');
	if (trimmed === '') return true;
	const last = trimmed[trimmed.length - 1];
	if (REGEX_PRECEDING_PUNCT.has(last)) return true;
	return REGEX_PRECEDING_KEYWORDS.some((kw) =>
		new RegExp(`(^|[^A-Za-z0-9_$])${kw}$`).test(trimmed),
	);
}

export function stripCommentsWithState(source: string): {
	source: string;
	state: StripState;
} {
	const out: string[] = [];
	// Nesting stack for `${ ... }` inside template literals: each entry counts
	// open braces so the matching `}` returns to template context.
	const templateStack: number[] = [];
	let state: StripState = 'code';
	let i = 0;
	const blank = (c: string): string => (c === '\n' ? '\n' : ' ');

	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1] ?? '';

		switch (state) {
			case 'code': {
				if (c === '/' && next === '*') {
					state = 'block';
					out.push('  ');
					i += 2;
					continue;
				}
				if (c === '/' && next === '/') {
					state = 'line';
					out.push('  ');
					i += 2;
					continue;
				}
				if (c === '/' && regexCanStartHere(recentTail(out))) {
					state = 'regex';
					out.push(c);
					i += 1;
					continue;
				}
				if (c === "'") state = 'single';
				else if (c === '"') state = 'double';
				else if (c === '`') state = 'template';
				else if (c === '}' && templateStack.length > 0) {
					const depth = templateStack[templateStack.length - 1];
					if (depth === 0) {
						templateStack.pop();
						state = 'template';
					} else {
						templateStack[templateStack.length - 1] = depth - 1;
					}
				} else if (c === '{' && templateStack.length > 0) {
					templateStack[templateStack.length - 1] += 1;
				}
				out.push(c);
				i += 1;
				continue;
			}
			case 'block': {
				if (c === '*' && next === '/') {
					state = 'code';
					out.push('  ');
					i += 2;
					continue;
				}
				out.push(blank(c));
				i += 1;
				continue;
			}
			case 'line': {
				if (c === '\n') {
					state = 'code';
					out.push('\n');
					i += 1;
					continue;
				}
				out.push(' ');
				i += 1;
				continue;
			}
			case 'single':
			case 'double':
			case 'template':
			case 'regex': {
				if (c === '\\') {
					out.push(c, source[i + 1] ?? '');
					i += 2;
					continue;
				}
				if (state === 'template' && c === '$' && next === '{') {
					templateStack.push(0);
					state = 'code';
					out.push('${');
					i += 2;
					continue;
				}
				const closer =
					state === 'single'
						? "'"
						: state === 'double'
							? '"'
							: state === 'template'
								? '`'
								: '/';
				if (c === closer) state = 'code';
				// A newline terminates an unterminated single/double string or
				// regex (a syntax error in real code); recover to `code` so one
				// oddity cannot blank the remainder of the file.
				else if (c === '\n' && state !== 'template') state = 'code';
				out.push(c);
				i += 1;
				continue;
			}
		}
	}
	return { source: out.join(''), state };
}

function listSourceFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
			listSourceFiles(full, acc);
			continue;
		}
		if (!entry.name.endsWith('.ts')) continue;
		if (entry.name.endsWith('.test.ts')) continue;
		acc.push(full);
	}
	return acc;
}

export interface DiscoveredSite {
	file: string;
	line: number;
	directoryExpr: string;
}

/** Extracts the balanced argument text of a `session.create(` call. */
function callBody(source: string, startIndex: number): string {
	let depth = 1;
	let i = startIndex;
	while (i < source.length && depth > 0) {
		if (source[i] === '(') depth += 1;
		else if (source[i] === ')') depth -= 1;
		i += 1;
	}
	return source.slice(startIndex, i - 1);
}

function extractDirectoryExpr(body: string): string {
	const explicit = /directory:\s*([A-Za-z0-9_$.[\]?!]+)/.exec(body);
	if (explicit) return explicit[1];
	// `query: { directory }` shorthand.
	if (/\{\s*directory\s*[,}]/.test(body)) return 'directory';
	// Helper form: `someHelper(firstArg, ...)`.
	const helper = /([A-Za-z0-9_$]+)\(\s*([A-Za-z0-9_$.]+)/.exec(body.trim());
	if (helper) return `HELPER ${helper[1]}(${helper[2]})`;
	return 'UNRECOGNISED';
}

/** Files whose tokenizer terminal state was not `code` — see the assertion. */
export const tokenizerFailures: string[] = [];

export function discoverSites(srcRoot: string): DiscoveredSite[] {
	const found: DiscoveredSite[] = [];
	tokenizerFailures.length = 0;
	for (const file of listSourceFiles(srcRoot)) {
		const stripped = stripCommentsWithState(fs.readFileSync(file, 'utf-8'));
		if (stripped.state !== 'code') {
			tokenizerFailures.push(
				`${path.relative(path.resolve(srcRoot, '..'), file).split(path.sep).join('/')} (ended in '${stripped.state}')`,
			);
		}
		const source = stripped.source;
		const pattern = /session\.create\(/g;
		let match = pattern.exec(source);
		while (match !== null) {
			const body = callBody(source, match.index + match[0].length);
			found.push({
				file: path
					.relative(path.resolve(srcRoot, '..'), file)
					.split(path.sep)
					.join('/'),
				line: source.slice(0, match.index).split('\n').length,
				directoryExpr: extractDirectoryExpr(body),
			});
			match = pattern.exec(source);
		}
	}
	return found;
}
