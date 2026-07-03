import * as fs from 'node:fs';
import * as path from 'node:path';
import { containsControlChars } from '../utils/path-security';
import type { ImportEdge, ImportType } from './types';

/**
 * Extract import edges from a source file.
 *
 * Uses regex-based parsing (the same proven approach as `src/tools/imports.ts`
 * and `src/tools/co-change-analyzer.ts`). Tree-sitter is intentionally not used
 * here because:
 *   1. The existing regex patterns are battle-tested across the codebase.
 *   2. Import statements have stable, simple syntax that regex handles reliably.
 *   3. Avoiding the per-file Tree-sitter parse keeps full-graph builds fast
 *      enough to be interactive (target: <5s for 50k LOC).
 *
 * Supported languages:
 *   - TypeScript / JavaScript (.ts/.tsx/.js/.jsx/.mjs/.cjs) — ES modules + CJS require
 *   - Python (.py) — `import x` and `from x import y`
 *   - Go (.go) — `import "path"` and `import (...)` blocks
 *   - Rust (.rs) — `use path::module`
 *
 * Only RELATIVE imports are tracked as graph edges. External package imports
 * (e.g. 'react', 'fmt', 'std::fs') are skipped — they are not part of the
 * intra-repo dependency graph.
 */

export interface ExtractImportsOptions {
	/** Absolute path to the source file (used for relative resolution). */
	absoluteFilePath: string;
	/** Absolute workspace root (used for relative path computation). */
	workspaceRoot: string;
	/** Optional pre-read content; if omitted the file is read from disk. */
	content?: string;
}

/** Source file extensions we know how to scan. */
export const SOURCE_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.py',
	'.pyw',
	'.go',
	'.rs',
	'.java',
	'.kt',
	'.kts',
	'.cs',
	'.csx',
] as const;

const TS_JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// Direct extension candidates (concatenated to baseAbs).
const RESOLVE_EXTENSION_CANDIDATES = [
	'',
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
];

// Index-file candidates resolved via `path.join(baseAbs, candidate)` so the
// directory separator matches the host OS (avoids mixed `C:\dir\/index.ts`).
const RESOLVE_INDEX_CANDIDATES = [
	'index.ts',
	'index.tsx',
	'index.js',
	'index.jsx',
	'index.mjs',
];

const PY_EXTENSION_CANDIDATES = ['.py', '.pyw'];
const PY_INDEX_CANDIDATES = ['__init__.py', '__init__.pyw'];
const JAVA_KOTLIN_ROOTS = ['', 'src/main/java', 'src/main/kotlin', 'src'];
const CSHARP_ROOTS = ['', 'src'];

export function getLanguageFromExtension(ext: string): string | null {
	const lower = ext.toLowerCase();
	if (TS_JS_EXTENSIONS.includes(lower)) {
		return lower === '.ts' || lower === '.tsx' ? 'typescript' : 'javascript';
	}
	if (lower === '.py' || lower === '.pyw') return 'python';
	if (lower === '.go') return 'go';
	if (lower === '.rs') return 'rust';
	if (lower === '.java') return 'java';
	if (lower === '.kt' || lower === '.kts') return 'kotlin';
	if (lower === '.cs' || lower === '.csx') return 'csharp';
	return null;
}

function toRelForwardSlash(absPath: string, root: string): string {
	return path.relative(root, absPath).replace(/\\/g, '/');
}

function tryResolveTSJS(
	rawModule: string,
	sourceFileAbs: string,
): string | null {
	if (!rawModule.startsWith('.') && !rawModule.startsWith('/')) {
		return null; // package import
	}
	const sourceDir = path.dirname(sourceFileAbs);
	const baseAbs = path.resolve(sourceDir, rawModule);
	const probe = (basePath: string): string | null => {
		for (const ext of RESOLVE_EXTENSION_CANDIDATES) {
			const test = basePath + ext;
			try {
				const stat = fs.statSync(test);
				if (stat.isFile()) return test;
			} catch {
				// continue
			}
		}
		for (const indexFile of RESOLVE_INDEX_CANDIDATES) {
			// Use path.join so the directory separator matches the host OS
			// (prevents mixed `C:\dir\/index.ts` on Windows).
			const test = path.join(basePath, indexFile);
			try {
				const stat = fs.statSync(test);
				if (stat.isFile()) return test;
			} catch {
				// continue
			}
		}
		return null;
	};
	const direct = probe(baseAbs);
	if (direct) return direct;
	// Strip a written .js / .ts extension and retry (common for ESM ".js" suffixes pointing at .ts)
	const stripped = baseAbs.replace(/\.(m?[jt]sx?|c[jt]s)$/i, '');
	if (stripped !== baseAbs) {
		const fallback = probe(stripped);
		if (fallback) return fallback;
	}
	return null;
}

function tryResolvePython(
	rawModule: string,
	sourceFileAbs: string,
	workspaceRoot: string,
): string | null {
	// Only handle relative ('.foo' / '..foo') module specifiers and dotted local modules.
	if (!rawModule.startsWith('.')) {
		return null;
	}
	// Convert "..pkg.mod" -> "../../pkg/mod"
	let leadingDots = 0;
	while (leadingDots < rawModule.length && rawModule[leadingDots] === '.') {
		leadingDots++;
	}
	const remainder = rawModule.slice(leadingDots).replace(/\./g, '/');
	const upDirs = '../'.repeat(Math.max(0, leadingDots - 1));
	const sourceDir = path.dirname(sourceFileAbs);
	const baseAbs = path.resolve(sourceDir, upDirs + remainder);
	const accept = (test: string): string | null => {
		try {
			const stat = fs.statSync(test);
			if (stat.isFile()) {
				const rel = path.relative(workspaceRoot, test).replace(/\\/g, '/');
				if (rel.startsWith('..')) return null; // outside workspace
				return test;
			}
		} catch {
			// continue
		}
		return null;
	};
	const sourceExt = path.extname(sourceFileAbs).toLowerCase();
	const extensionCandidates =
		sourceExt === '.pyw' ? ['.pyw', '.py'] : [...PY_EXTENSION_CANDIDATES];
	for (const ext of extensionCandidates) {
		const hit = accept(baseAbs + ext);
		if (hit) return hit;
	}
	for (const indexFile of PY_INDEX_CANDIDATES) {
		// path.join → host-correct separator on Windows.
		const hit = accept(path.join(baseAbs, indexFile));
		if (hit) return hit;
	}
	return null;
}

function acceptWorkspaceFile(
	test: string,
	workspaceRoot: string,
): string | null {
	try {
		const stat = fs.statSync(test);
		if (!stat.isFile()) return null;
		const rel = path.relative(workspaceRoot, test).replace(/\\/g, '/');
		if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
		return test;
	} catch {
		return null;
	}
}

function tryResolveDottedModule(
	rawModule: string,
	workspaceRoot: string,
	extensions: readonly string[],
	roots: readonly string[],
): string | null {
	if (!/^[A-Za-z_][\w.]*(?:\.\*)?$/.test(rawModule)) return null;
	const cleaned = rawModule.replace(/\.\*$/, '');
	const parts = cleaned.split('.');
	const candidates = [parts.join(path.sep)];
	if (parts.length > 1) {
		candidates.push(parts.slice(0, -1).join(path.sep));
	}

	for (const rootPrefix of roots) {
		for (const candidate of candidates) {
			const base = path.join(workspaceRoot, rootPrefix, candidate);
			for (const ext of extensions) {
				const hit = acceptWorkspaceFile(base + ext, workspaceRoot);
				if (hit) return hit;
			}
			try {
				if (fs.statSync(base).isDirectory()) {
					const first = fs
						.readdirSync(base)
						.filter((entry) =>
							extensions.some((ext) => entry.toLowerCase().endsWith(ext)),
						)
						.sort((a, b) => a.localeCompare(b))[0];
					if (first) {
						const hit = acceptWorkspaceFile(
							path.join(base, first),
							workspaceRoot,
						);
						if (hit) return hit;
					}
				}
			} catch {
				// continue
			}
		}
	}
	return null;
}

interface ParsedImport {
	rawModule: string;
	importedSymbols: string[];
	importType: ImportType;
	line: number;
}

const TS_IMPORT_RE =
	/(?:^|[\n;])\s*import\s+(?:type\s+)?(?:(\*\s+as\s+(\w+))|(\{[\s\S]*?\})|(\w+))?(?:\s*,\s*(?:(\*\s+as\s+\w+)|(\{[\s\S]*?\})|(\w+)))?\s*(?:from\s+)?['"`]([^'"`]+)['"`]/g;
const TS_SIDEEFFECT_RE = /(?:^|[\n;])\s*import\s+['"`]([^'"`]+)['"`]/g;
const TS_REQUIRE_RE = /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const TS_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

/**
 * Returns true when the keyword at `keywordIndex` is the member of a member
 * expression (`obj.require(...)`, `obj?.import(...)`, etc.). The regex word
 * boundary `\b` is satisfied by a `.` immediately before the keyword, so we
 * have to filter member-access calls explicitly to avoid phantom edges.
 */
function isMemberAccessAt(content: string, keywordIndex: number): boolean {
	let i = keywordIndex - 1;
	// Skip horizontal whitespace between the dot and the keyword.
	while (i >= 0 && (content[i] === ' ' || content[i] === '\t')) i--;
	if (i < 0) return false;
	if (content[i] !== '.') return false;
	// Allow `?.` optional chaining as well — still member access.
	return true;
}

function lineNumberFor(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < content.length; i++) {
		if (content.charCodeAt(i) === 10 /* \n */) line++;
	}
	return line;
}

function parseNamedSpecifiers(braceText: string): string[] {
	// braceText includes "{ ... }"
	const inner = braceText.replace(/^\{|\}$/g, '');
	const names: string[] = [];
	for (const piece of inner.split(',')) {
		const trimmed = piece.trim();
		if (!trimmed) continue;
		// "Foo" or "Foo as Bar" or "type Foo" or "type Foo as Bar"
		const stripped = trimmed.replace(/^type\s+/, '');
		const aliasMatch = stripped.match(/^(\w+)\s+as\s+(\w+)$/);
		if (aliasMatch) {
			// Record the ORIGINAL exported name (aliasMatch[1]), not the local
			// binding (aliasMatch[2]). Symbol-consumer queries match against
			// exported names, so storing the alias would under-report usage of
			// `import { add as sum }` when callers ask "who imports add?".
			names.push(aliasMatch[1]);
		} else {
			const nameMatch = stripped.match(/^(\w+)/);
			if (nameMatch) names.push(nameMatch[1]);
		}
	}
	return names;
}

function parseTSJSImports(content: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	const seen = new Set<string>();

	const stripped = stripTSJSComments(content);
	// String-literal content ranges (excluding the source-string of legitimate
	// import / require / dynamic-import statements). Used to filter out false
	// positives where the regex matches `import ... from ...` text that lives
	// inside an unrelated string literal (codegen templates, docs, examples).
	const stringRanges = findNonImportStringRanges(stripped);

	const isInString = (pos: number): boolean => isInsideRange(pos, stringRanges);

	for (
		let m = TS_IMPORT_RE.exec(stripped);
		m !== null;
		m = TS_IMPORT_RE.exec(stripped)
	) {
		const rawModule = m[8];
		if (!rawModule) continue;
		// The `import` keyword sits after the leading "(?:^|[\n;])\s*". The
		// `m.index` itself points at the consumed `\n`/`;`, so use the
		// keyword position both for the in-string check AND for line numbering
		// (otherwise non-first imports report `line - 1`).
		const importKw = m.index + m[0].search(/\bimport\b/);
		if (isInString(importKw)) continue;
		const line = lineNumberFor(stripped, importKw);
		const namespaceA = m[1];
		const bracesA = m[3];
		const defaultA = m[4];
		const namespaceB = m[5];
		const bracesB = m[6];
		const defaultB = m[7];

		const importedSymbols: string[] = [];
		let importType: ImportType = 'named';
		let any = false;
		if (defaultA) {
			importedSymbols.push(defaultA);
			importType = 'default';
			any = true;
		}
		if (defaultB) {
			importedSymbols.push(defaultB);
			importType = importType === 'named' ? 'default' : importType;
			any = true;
		}
		if (bracesA) {
			importedSymbols.push(...parseNamedSpecifiers(bracesA));
			importType = any ? importType : 'named';
			any = true;
		}
		if (bracesB) {
			importedSymbols.push(...parseNamedSpecifiers(bracesB));
			any = true;
		}
		if (namespaceA || namespaceB) {
			importType = 'namespace';
			any = true;
		}
		if (!any) {
			// no clause matched: this can't actually happen because the leading group is optional;
			// fall through and treat as side-effect via the side-effect pass.
			continue;
		}
		const key = `${rawModule}::${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ rawModule, importedSymbols, importType, line });
	}

	for (
		let m = TS_SIDEEFFECT_RE.exec(stripped);
		m !== null;
		m = TS_SIDEEFFECT_RE.exec(stripped)
	) {
		const importKw = m.index + m[0].search(/\bimport\b/);
		if (isInString(importKw)) continue;
		const rawModule = m[1];
		// Use the keyword position (not m.index) so the consumed leading
		// `\n`/`;` doesn't shift the reported line down by 1.
		const line = lineNumberFor(stripped, importKw);
		const key = `${rawModule}::${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			rawModule,
			importedSymbols: [],
			importType: 'sideeffect',
			line,
		});
	}

	for (
		let m = TS_REQUIRE_RE.exec(stripped);
		m !== null;
		m = TS_REQUIRE_RE.exec(stripped)
	) {
		// `\brequire\s*\(` — the `require` keyword is at m.index. The `\b`
		// boundary is satisfied by `.|r`, so `obj.require(...)` would also
		// match. Reject member-expression calls explicitly.
		if (isInString(m.index)) continue;
		if (isMemberAccessAt(stripped, m.index)) continue;
		const rawModule = m[1];
		const line = lineNumberFor(stripped, m.index);
		const key = `require:${rawModule}::${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			rawModule,
			importedSymbols: [],
			importType: 'require',
			line,
		});
	}

	for (
		let m = TS_DYNAMIC_IMPORT_RE.exec(stripped);
		m !== null;
		m = TS_DYNAMIC_IMPORT_RE.exec(stripped)
	) {
		// `\bimport\s*\(` — the `import` keyword is at m.index. Same
		// member-expression false-positive as `require` above.
		if (isInString(m.index)) continue;
		if (isMemberAccessAt(stripped, m.index)) continue;
		const rawModule = m[1];
		const line = lineNumberFor(stripped, m.index);
		const key = `dyn:${rawModule}::${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			rawModule,
			importedSymbols: [],
			importType: 'require',
			line,
		});
	}

	return out;
}

/**
 * Replace comment bodies with spaces of equal length so regex matches stay
 * aligned to original line numbers. String literal contents are preserved
 * because the import regex needs the source-string content (the path inside
 * `from '...'`); false-positive matches inside unrelated string literals are
 * filtered out separately via {@link findNonImportStringRanges}.
 */
function stripTSJSComments(content: string): string {
	let out = '';
	let i = 0;
	const len = content.length;
	while (i < len) {
		const ch = content[i];
		const next = content[i + 1];
		// line comment
		if (ch === '/' && next === '/') {
			while (i < len && content[i] !== '\n') {
				out += content[i] === '\n' ? '\n' : ' ';
				i++;
			}
			continue;
		}
		// block comment
		if (ch === '/' && next === '*') {
			out += '  ';
			i += 2;
			while (i < len) {
				if (content[i] === '*' && content[i + 1] === '/') {
					out += '  ';
					i += 2;
					break;
				}
				out += content[i] === '\n' ? '\n' : ' ';
				i++;
			}
			continue;
		}
		// string literals — preserve verbatim (including the quote chars)
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			out += ch;
			i++;
			while (i < len) {
				if (content[i] === '\\' && i + 1 < len) {
					out += content[i];
					out += content[i + 1];
					i += 2;
					continue;
				}
				if (content[i] === quote) {
					out += content[i];
					i++;
					break;
				}
				out += content[i];
				i++;
			}
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Walk comment-stripped content and return the [startInclusive, endExclusive]
 * positions of every string-literal *content* range (the chars between the
 * quote markers, exclusive of the quotes).
 *
 * Source-strings of legitimate `from '…'`, `require('…')`, and `import('…')`
 * statements are *excluded* — they must remain visible to the import regexes.
 *
 * Used to suppress false-positive import matches that appear inside unrelated
 * string literals (codegen templates, prose, examples).
 */
function findNonImportStringRanges(content: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let i = 0;
	const len = content.length;
	while (i < len) {
		const ch = content[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			const contentStart = i + 1;
			i++;
			let endExclusive = -1;
			while (i < len) {
				if (content[i] === '\\' && i + 1 < len) {
					i += 2;
					continue;
				}
				if (content[i] === quote) {
					endExclusive = i;
					i++;
					break;
				}
				i++;
			}
			if (endExclusive === -1) continue; // unterminated; nothing to record
			// Look back for an `import-source` context. Only a literal
			// `from`, `require(` or `import(` keyword preceding the open
			// quote (modulo whitespace) qualifies — a bare `(` alone is too
			// permissive and would whitelist arbitrary call arguments like
			// `someFn("require('./x')")`, which then leak phantom edges via
			// the require/dynamic-import regexes inside the string.
			let j = contentStart - 2; // char before the opening quote
			while (j >= 0 && (content[j] === ' ' || content[j] === '\t')) j--;
			let isImportSource = false;
			if (j >= 3 && content.slice(j - 3, j + 1) === 'from') {
				// Word boundary: char before `from` must be non-identifier.
				const before = j - 4;
				if (before < 0 || !/[\w$]/.test(content[before])) {
					isImportSource = true;
				}
			} else if (j >= 0 && content[j] === '(') {
				// Walk back across whitespace to the call-target keyword.
				let k = j - 1;
				while (k >= 0 && (content[k] === ' ' || content[k] === '\t')) k--;
				const tail7 = content.slice(Math.max(0, k - 6), k + 1);
				const tail6 = content.slice(Math.max(0, k - 5), k + 1);
				const matchKeyword = (kw: string, tail: string): boolean => {
					if (!tail.endsWith(kw)) return false;
					const before = k - kw.length;
					if (before >= 0 && /[\w$]/.test(content[before])) return false;
					// A leading `.` (member access, e.g. `obj.require("x")`) is
					// also a non-import call — `\b` accepts it but we don't.
					if (before >= 0 && content[before] === '.') return false;
					return true;
				};
				if (matchKeyword('require', tail7) || matchKeyword('import', tail6)) {
					isImportSource = true;
				}
			}
			if (!isImportSource) {
				ranges.push([contentStart, endExclusive]);
			}
			continue;
		}
		i++;
	}
	return ranges;
}

/** Linear-scan range membership check (ranges are emitted in source order). */
function isInsideRange(
	pos: number,
	ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
	for (const [start, end] of ranges) {
		if (pos < start) return false;
		if (pos < end) return true;
	}
	return false;
}

const PY_FROM_IMPORT_RE = /^(\s*)from\s+([.\w]+)\s+import\s+([^\n#]+)/gm;
const PY_IMPORT_RE = /^(\s*)import\s+([.\w][.\w,\s]*)/gm;

function parsePythonImports(content: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	for (
		let m = PY_FROM_IMPORT_RE.exec(content);
		m !== null;
		m = PY_FROM_IMPORT_RE.exec(content)
	) {
		const rawModule = m[2];
		const namesPart = m[3].trim();
		const importedSymbols =
			namesPart === '*'
				? []
				: namesPart
						.replace(/[()]/g, '')
						.split(',')
						.map((s) => {
							const t = s.trim();
							const aliasMatch = t.match(/^(\w+)\s+as\s+(\w+)$/);
							// Record the original exported name, not the local alias —
							// symbol-consumer queries match against exported names.
							if (aliasMatch) return aliasMatch[1];
							const nameMatch = t.match(/^(\w+)/);
							return nameMatch ? nameMatch[1] : '';
						})
						.filter(Boolean);
		out.push({
			rawModule,
			importedSymbols,
			importType: namesPart === '*' ? 'namespace' : 'named',
			line: lineNumberFor(content, m.index),
		});
	}
	for (
		let m = PY_IMPORT_RE.exec(content);
		m !== null;
		m = PY_IMPORT_RE.exec(content)
	) {
		const namesPart = m[2].trim();
		for (const piece of namesPart.split(',')) {
			const trimmed = piece.trim();
			if (!trimmed) continue;
			const aliasMatch = trimmed.match(/^([.\w]+)\s+as\s+(\w+)$/);
			const rawModule = aliasMatch ? aliasMatch[1] : trimmed.split(/\s/)[0];
			out.push({
				rawModule,
				importedSymbols: [],
				importType: 'namespace',
				line: lineNumberFor(content, m.index),
			});
		}
	}
	return out;
}

const GO_SINGLE_IMPORT_RE = /^\s*import\s+(?:(\.|_|\w+)\s+)?["`]([^"`]+)["`]/gm;
const GO_BLOCK_IMPORT_RE = /^\s*import\s*\(([\s\S]*?)\)/gm;
const GO_BLOCK_LINE_RE = /(?:(\.|_|\w+)\s+)?["`]([^"`]+)["`]/g;

function parseGoImports(content: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	for (
		let m = GO_SINGLE_IMPORT_RE.exec(content);
		m !== null;
		m = GO_SINGLE_IMPORT_RE.exec(content)
	) {
		out.push({
			rawModule: m[2],
			importedSymbols: [],
			importType: m[1] === '_' ? 'sideeffect' : 'namespace',
			line: lineNumberFor(content, m.index),
		});
	}
	for (
		let m = GO_BLOCK_IMPORT_RE.exec(content);
		m !== null;
		m = GO_BLOCK_IMPORT_RE.exec(content)
	) {
		const block = m[1];
		const blockStart = m.index;
		for (
			let inner = GO_BLOCK_LINE_RE.exec(block);
			inner !== null;
			inner = GO_BLOCK_LINE_RE.exec(block)
		) {
			out.push({
				rawModule: inner[2],
				importedSymbols: [],
				importType: inner[1] === '_' ? 'sideeffect' : 'namespace',
				line: lineNumberFor(content, blockStart + inner.index),
			});
		}
		GO_BLOCK_LINE_RE.lastIndex = 0;
	}
	return out;
}

const RUST_USE_RE = /^\s*use\s+(.+?)\s*;/gm;

function parseRustUses(content: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	for (
		let m = RUST_USE_RE.exec(content);
		m !== null;
		m = RUST_USE_RE.exec(content)
	) {
		const raw = m[1].trim();
		const grouped = raw.match(/^(.+?)::\{(.+)\}$/);
		if (grouped) {
			const importedSymbols = grouped[2]
				.split(',')
				.map((part) => part.trim())
				.map((part) => {
					const [_full, _path_prefix, symbol, alias] =
						part.match(/^(?:(.+?)::)?(\w+)(?:\s+as\s+(\w+))?$/) ?? [];
					// If there's an alias, use it; otherwise use the symbol (last path segment)
					return alias ?? symbol;
				})
				.filter((part): part is string => Boolean(part));
			out.push({
				rawModule: grouped[1].trim(),
				importedSymbols,
				importType: 'named',
				line: lineNumberFor(content, m.index),
			});
			continue;
		}
		const alias = raw.match(/^(.+?)\s+as\s+\w+$/);
		out.push({
			rawModule: alias ? alias[1].trim() : raw,
			importedSymbols: [],
			importType: alias ? 'named' : 'namespace',
			line: lineNumberFor(content, m.index),
		});
	}
	return out;
}

const JAVA_IMPORT_RE =
	/^\s*import\s+(static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)\s*;?\s*$/gm;

function finalDottedName(value: string): string {
	const parts = value.split('.').filter(Boolean);
	return parts[parts.length - 1] ?? value;
}

function parseJavaImports(content: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	for (
		let m = JAVA_IMPORT_RE.exec(content);
		m !== null;
		m = JAVA_IMPORT_RE.exec(content)
	) {
		const isStatic = Boolean(m[1]);
		const raw = m[2];
		const isStar = raw.endsWith('.*');
		const specifier =
			isStatic && !isStar ? raw.split('.').slice(0, -1).join('.') : raw;
		const importedSymbols =
			isStatic && !isStar
				? [finalDottedName(raw)]
				: isStar
					? ['*']
					: [finalDottedName(raw)];
		out.push({
			rawModule: specifier,
			importedSymbols,
			importType: isStar ? 'namespace' : 'named',
			line: lineNumberFor(content, m.index),
		});
	}
	return out;
}

const KOTLIN_IMPORT_RE =
	/^\s*import\s+([A-Za-z_][\w.]*(?:\.\*)?)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/gm;

function parseKotlinImports(content: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	for (
		let m = KOTLIN_IMPORT_RE.exec(content);
		m !== null;
		m = KOTLIN_IMPORT_RE.exec(content)
	) {
		const raw = m[1];
		const isStar = raw.endsWith('.*');
		out.push({
			rawModule: raw,
			importedSymbols: isStar ? ['*'] : [finalDottedName(raw)],
			importType: isStar ? 'namespace' : 'named',
			line: lineNumberFor(content, m.index),
		});
	}
	return out;
}

const CSHARP_USING_RE =
	/^\s*using\s+(static\s+)?(?:(\w+)\s*=\s*)?([A-Za-z_][\w.]*)\s*;?/gm;

function parseCSharpUsings(content: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	for (
		let m = CSHARP_USING_RE.exec(content);
		m !== null;
		m = CSHARP_USING_RE.exec(content)
	) {
		const isStatic = Boolean(m[1]);
		const alias = m[2];
		const raw = m[3];
		out.push({
			rawModule: raw,
			importedSymbols: alias ? [finalDottedName(raw)] : isStatic ? ['*'] : [],
			importType: alias ? 'named' : 'namespace',
			line: lineNumberFor(content, m.index),
		});
	}
	return out;
}

/**
 * Extract import edges for a single file. Returns an empty array when the
 * language is unsupported or the file cannot be parsed.
 *
 * Resolution strategy for edge.target:
 *   - TS/JS: probe extensions (.ts, .tsx, .js, .jsx, .mjs, .cjs, /index.*).
 *   - Python: probe .py and /__init__.py for relative imports only.
 *   - Go/Rust: target left empty (intra-repo resolution requires module/crate
 *     metadata that is out of scope for Phase 1). The raw module is preserved.
 */
export function extractImports(opts: ExtractImportsOptions): ImportEdge[] {
	const { absoluteFilePath, workspaceRoot } = opts;
	const ext = path.extname(absoluteFilePath).toLowerCase();
	const language = getLanguageFromExtension(ext);
	if (!language) return [];

	let content = opts.content;
	if (content === undefined) {
		try {
			content = fs.readFileSync(absoluteFilePath, 'utf-8');
		} catch {
			return [];
		}
	}

	let parsed: ParsedImport[];
	if (language === 'typescript' || language === 'javascript') {
		parsed = parseTSJSImports(content);
	} else if (language === 'python') {
		parsed = parsePythonImports(content);
	} else if (language === 'go') {
		parsed = parseGoImports(content);
	} else if (language === 'rust') {
		parsed = parseRustUses(content);
	} else if (language === 'java') {
		parsed = parseJavaImports(content);
	} else if (language === 'kotlin') {
		parsed = parseKotlinImports(content);
	} else if (language === 'csharp') {
		parsed = parseCSharpUsings(content);
	} else {
		return [];
	}

	const sourceRel = toRelForwardSlash(absoluteFilePath, workspaceRoot);
	const edges: ImportEdge[] = [];

	for (const p of parsed) {
		// Belt-and-suspenders: skip any specifier that contains control characters
		// (\0, \t, \r, \n). These can appear when binary or malformed files are
		// scanned; allowing them through would corrupt the graph with dirty
		// rawModule values — the same fix applied to src/tools/repo-graph.ts in #538.
		if (containsControlChars(p.rawModule)) continue;

		let resolvedAbs: string | null = null;
		if (language === 'typescript' || language === 'javascript') {
			resolvedAbs = tryResolveTSJS(p.rawModule, absoluteFilePath);
		} else if (language === 'python') {
			resolvedAbs = tryResolvePython(
				p.rawModule,
				absoluteFilePath,
				workspaceRoot,
			);
		} else if (language === 'java' || language === 'kotlin') {
			resolvedAbs = tryResolveDottedModule(
				p.rawModule,
				workspaceRoot,
				language === 'java' ? ['.java'] : ['.kt', '.kts'],
				JAVA_KOTLIN_ROOTS,
			);
		} else if (language === 'csharp') {
			resolvedAbs = tryResolveDottedModule(
				p.rawModule,
				workspaceRoot,
				['.cs', '.csx'],
				CSHARP_ROOTS,
			);
		}

		const target = resolvedAbs
			? toRelForwardSlash(resolvedAbs, workspaceRoot)
			: '';

		// Skip imports that resolve outside the workspace
		if (target.startsWith('..')) continue;

		edges.push({
			source: sourceRel,
			target,
			rawModule: p.rawModule,
			importedSymbols: p.importedSymbols,
			importType: p.importType,
			line: p.line,
		});
	}

	return edges;
}
