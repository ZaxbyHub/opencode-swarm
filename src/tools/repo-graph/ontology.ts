import * as path from 'node:path';
import type {
	ConventionFact,
	DataOperationFact,
	FileOntology,
	FileRole,
	OntologyFinding,
	OntologyLink,
	OntologyLinkConfidence,
	RouteFact,
	RouteMethod,
	SecurityFact,
} from './types';
import { inferPackageBoundary } from './types';

export interface ExtractFileOntologyInput {
	moduleName: string;
	filePath: string;
	content: string;
	language: string;
	exports: string[];
	imports: string[];
	/**
	 * Optional callback returning true when a workspace-relative directory
	 * contains a package manifest (`package.json`, `Cargo.toml`,
	 * `pyproject.toml`, `go.mod`). When provided, the package-boundary rule
	 * becomes manifest-driven; otherwise it falls back to the static segment
	 * rules (issue #1985, defect A8). The extractor stays pure — no fs I/O.
	 */
	hasManifest?: (relDir: string) => boolean;
}

const HTTP_METHODS: RouteMethod[] = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
	'HEAD',
];

const MAX_FACTS_PER_KIND = 50;
const MAX_LINKS_PER_FILE = 200;
const MAX_CONFIGURES_PER_FILE = 20;

function stripComments(content: string): string {
	let out = '';
	let i = 0;
	let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' =
		'code';
	while (i < content.length) {
		const ch = content[i];
		const next = i + 1 < content.length ? content[i + 1] : '';
		switch (state) {
			case 'code':
				if (ch === '/' && next === '/') {
					state = 'line';
					i += 2;
				} else if (ch === '/' && next === '*') {
					state = 'block';
					i += 2;
				} else {
					if (ch === "'") state = 'single';
					else if (ch === '"') state = 'double';
					else if (ch === '`') state = 'template';
					out += ch;
					i++;
				}
				break;
			case 'single':
			case 'double':
			case 'template': {
				const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
				if (ch === '\\') {
					out += ch + next;
					i += 2;
				} else {
					if (ch === quote) state = 'code';
					out += ch;
					i++;
				}
				break;
			}
			case 'line':
				if (ch === '\n') {
					state = 'code';
					out += ch;
				}
				i++;
				break;
			case 'block':
				if (ch === '*' && next === '/') {
					state = 'code';
					i += 2;
				} else {
					if (ch === '\n') out += ch;
					i++;
				}
				break;
		}
	}
	return out;
}

function normalizeModuleName(moduleName: string): string {
	return moduleName.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

function uniqueSorted<T extends string>(values: Iterable<T>): T[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function addRole(roles: Set<FileRole>, role: FileRole): void {
	roles.add(role);
}

/**
 * Infer the package boundary for a module. Delegates to the shared, pure
 * `inferPackageBoundary` helper so ontology extraction and the query-side
 * no-ontology fallback stay in lockstep (issue #1985, defect A8). The
 * previous `src/tools/repo-graph` special case is removed: user repos should
 * not inherit this project's internal layout.
 */
function boundaryForModule(
	moduleName: string,
	hasManifest?: (relDir: string) => boolean,
): string {
	return inferPackageBoundary(moduleName, hasManifest);
}

const blankKeepingNewlines = (m: string): string => m.replace(/[^\n]/g, ' ');

/**
 * Blank the CONTENTS of multi-line string literals, preserving newlines and
 * length so line-anchored matching still lines up.
 *
 * `stripComments` removes comments but keeps string literals verbatim, so a
 * line-initial `package` / `namespace` token inside a C# verbatim string
 * (`@"…"`), a C# raw string, or a Java/Kotlin text block (`"""…"""`) matched the
 * anchored regexes below and won the boundary — the real declaration lost,
 * because `String.match` takes the first hit. That is legal, compilable source
 * (a `@"…"` block holding SQL or config is ordinary C#), not a crafted spoof.
 *
 * Single-line string literals are not masked: their literal TEXT cannot contain
 * a raw newline, so no interior line can be line-initial. The one exception is a
 * C# interpolated string, which may span lines inside an interpolation hole —
 * but a hole contains code, not literal text, so leaving it unmasked is correct.
 * Only the multi-line forms are masked, which keeps the change narrow.
 */

/**
 * @internal Exported only so the scanner's structural invariants (termination,
 * length preservation, line-count preservation) can be fuzzed directly. Not
 * re-exported from the package index; call `extractFileOntology` instead.
 */
export function maskMultilineStringLiterals(
	text: string,
	language: string,
): string {
	// SINGLE LEFT-TO-RIGHT SCAN, deliberately not a set of independent regexes.
	//
	// Two successive regex-only attempts each over-reached and DELETED a real
	// declaration, in ways the previous fix did not anticipate:
	//   - masking `"""` before `@"` let the escaped-quote tail of `@"say ""hi"""`
	//     open a spurious region running to the next `"""` in the file;
	//   - a bare `@"` start pattern fired on the `@"` inside an ORDINARY string
	//     ending in `@` (`"team@"`), running forward to the next quote anywhere.
	// Both were WORSE than the bug being fixed: the declaration was lost
	// entirely rather than merely mis-chosen. The root cause is that a regex has
	// no notion of already being inside a literal. Scanning once — and CONSUMING
	// ordinary strings and char literals rather than ignoring them — closes those
	// two specific holes: a quote or `@` inside an ordinary literal can no longer
	// open a multi-line one.
	//
	// It is NOT a proof of total correctness, and this comment has twice been
	// written as if it were. Known surviving gaps, all documented in
	// docs/repo-graph-symbol-graph.md: an unterminated multi-line literal leaves
	// the file remainder unmasked; Kotlin's nesting block comments defeat
	// `stripComments`; and a C# verbatim path literal (`@"C:\dir\"`) makes
	// `stripComments` swallow its own terminator, leaving a later block comment
	// live. This scanner runs downstream of `stripComments` and cannot fix that.
	const csharp = language === 'csharp';
	let out = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];

		// Raw/text-block literal: Java text block, Kotlin raw string, C# 11 raw
		// string. The delimiter is NOT always three quotes. A C# raw string opens
		// with a run of N >= 3, which is the whole point of the form:
		// `""""…""""` is how you embed a literal `"""`.
		// Matching a hard-coded `"""` closed such a literal on its own CONTENT,
		// resuming the scan inside the string and deleting a real declaration
		// below it. Java and Kotlin only ever open with three.
		const openLen = quoteRunLength(text, i);
		if (openLen >= 3) {
			const delim = csharp ? openLen : 3;
			const end = findClosingQuoteRun(
				text,
				i + delim,
				delim,
				language === 'java',
			);
			if (end === -1) {
				// Unterminated: emit the remainder untouched rather than blanking
				// the rest of the file.
				out += text.slice(i);
				break;
			}
			const fence = '"'.repeat(delim);
			out += `${fence}${blankKeepingNewlines(text.slice(i + delim, end))}${fence}`;
			i = end + delim;
			continue;
		}

		// C# verbatim, in all three legal prefix orderings: @"…", $@"…", @$"…".
		//
		// The `csharp` gate is DEFENSIVE and deliberately has no test: widening it
		// to every language is an equivalent mutation on valid source, because in
		// Java and Kotlin `@` must be followed by an identifier, so `@"` adjacency
		// in a code position is not parseable input at all. It is kept because the
		// masker runs over arbitrary workspace files, including truncated and
		// generated ones, where that guarantee does not hold.
		const prefixLen = csharp ? matchVerbatimPrefix(text, i) : 0;
		if (prefixLen > 0) {
			const bodyStart = i + prefixLen;
			let j = bodyStart;
			let closed = -1;
			while (j < text.length) {
				if (text[j] === '"') {
					// A doubled "" is an escaped quote and continues the literal.
					if (text[j + 1] === '"') {
						j += 2;
						continue;
					}
					closed = j;
					break;
				}
				j++;
			}
			if (closed === -1) {
				out += text.slice(i);
				break;
			}
			out += `${text.slice(i, bodyStart)}${blankKeepingNewlines(
				text.slice(bodyStart, closed),
			)}"`;
			i = closed + 1;
			continue;
		}

		// Ordinary string / char literal: CONSUMED, never blanked. Consuming is
		// the whole point — it is what stops a `@` or a quote inside one from
		// being read as the start of a multi-line literal.
		//
		// The consume is bounded to the current LINE. None of java/kotlin/csharp
		// permits a raw newline in the literal TEXT of an ordinary string or char
		// literal (a C# interpolation hole may span lines, but it holds code, not
		// literal text, so leaving it unmasked is correct), so a
		// quote with no partner on its own line is not a delimiter at all — it is
		// an odd quote in text this scanner does not tokenize, most commonly a C#
		// preprocessor directive (`#warning check "`, `#region Customer's data`),
		// whose message is arbitrary input-characters and is never string-tokenized.
		// Consuming such a quote to EOF desynchronizes every branch below it:
		// code is read as literal and literal as code, which both DELETED a real
		// `namespace` declaration and left the FB-011 spoof winning. An unpaired
		// quote is therefore emitted as a single ordinary character.
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < text.length && text[j] !== ch && text[j] !== '\n') {
				// A backslash escapes the next character, but never a newline.
				if (text[j] === '\\' && text[j + 1] !== '\n') j++;
				j++;
			}
			if (j >= text.length || text[j] === '\n') {
				out += ch;
				i++;
				continue;
			}
			out += text.slice(i, j + 1);
			i = j + 1;
			continue;
		}

		out += ch;
		i++;
	}
	return out;
}

/** Number of consecutive `"` characters starting at `i`. */
function quoteRunLength(text: string, i: number): number {
	let n = 0;
	while (text[i + n] === '"') n++;
	return n;
}

/**
 * Index of the closing delimiter for a raw literal opened with `delim` quotes,
 * or -1. Runs are measured maximally, so a longer run is never mistaken for the
 * shorter delimiter it starts with, and the fence is taken as the LAST `delim`
 * quotes of the closing run.
 *
 * `escapes` is true only for Java. A Java text block is the one raw form with
 * escape sequences (JLS 3.10.6), and `\"""` is the JEP 378 idiom for embedding a
 * text block inside a text block — only two of those three quotes are unescaped,
 * so it must NOT terminate. Ignoring that closed the literal on its own content
 * and leaked a `package` declaration out of a text block. C# raw strings and
 * Kotlin raw strings have no escapes at all, so applying this to them would be
 * wrong in the other direction.
 *
 * Taking the last `delim` quotes rather than requiring an exact-length run is
 * deliberate. On compilable C# the two are indistinguishable — a longer closing
 * run is CS8998 — but on malformed or generated input, requiring exactness makes
 * the scan skip the run and hunt forward, blanking real code in between. The
 * looser rule bounds the damage, and matches Kotlin, which genuinely ends at the
 * last three quotes of a run.
 */
function findClosingQuoteRun(
	text: string,
	from: number,
	delim: number,
	escapes: boolean,
): number {
	let j = from;
	while (j < text.length) {
		if (escapes && text[j] === '\\') {
			j += 2;
			continue;
		}
		if (text[j] !== '"') {
			j++;
			continue;
		}
		const runLen = quoteRunLength(text, j);
		if (runLen >= delim) return j + runLen - delim;
		j += runLen;
	}
	return -1;
}

/**
 * Length of a C# verbatim-string prefix at `i` (`@"`, `$@"`, `@$"`), or 0.
 * C# accepts either order of the `$` and `@` sigils; matching only `@"` left
 * `@$"…"` unmasked, which kept alive the very spoof this masking prevents.
 */
function matchVerbatimPrefix(text: string, i: number): number {
	if (text.startsWith('@"', i)) return 2;
	if (text.startsWith('$@"', i) || text.startsWith('@$"', i)) return 3;
	return 0;
}

/**
 * Extract the *declared* package / namespace from JVM and .NET source text.
 *
 * `boundaryForModule` derives a boundary from the file path, which for a Java
 * file at `src/main/java/com/example/Foo.java` yields a path prefix rather than
 * the package the compiler actually sees (issue #1529, RC-8). The declaration
 * in the source is the authoritative answer, so it wins when present.
 *
 * Declaration forms covered. Node names are given for orientation only: this
 * function is an anchored regex over comment-stripped, string-masked text, NOT a
 * parse. It never loads a grammar.
 * - Java `package_declaration` — `package a.b.c;` (trailing `;` required).
 * - Kotlin `package_header` — `package a.b.c` (no `;`).
 * - C# `namespace_declaration` — `namespace N { … }` (brace may be on the
 *   next line).
 * - C# `file_scoped_namespace_declaration` — `namespace N;` (the .NET 6+
 *   project-template default).
 *
 * Returns `null` for every other language *and* for JVM/.NET files with no
 * declaration (Java default package, C# top-level statements), so the existing
 * path-derived fallback still applies.
 *
 * @param language - tree-sitter grammar id (`java` | `kotlin` | `csharp` | …)
 * @param content - file content with comments already stripped, so a
 *   commented-out declaration cannot win
 */
function sourceBoundaryForLanguage(
	language: string,
	content: string,
): string | null {
	if (language !== 'java' && language !== 'kotlin' && language !== 'csharp') {
		return null;
	}
	const scanned = maskMultilineStringLiterals(content, language);
	if (language === 'java' || language === 'kotlin') {
		const pkg = scanned.match(/^[ \t]*package[ \t]+([A-Za-z_][\w.]*)[ \t]*;?/m);
		if (pkg?.[1]) return pkg[1];
		return null;
	}
	if (language === 'csharp') {
		// `\s*` (not `[ \t]*`) before the terminator so `namespace N` followed by
		// a newline and `{` on the next line is still recognised.
		const ns = scanned.match(/^[ \t]*namespace[ \t]+([A-Za-z_][\w.]*)\s*[;{]/m);
		if (ns?.[1]) return ns[1];
		return null;
	}
	return null;
}

function inferRoles(moduleName: string, content: string): FileRole[] {
	const normalized = normalizeModuleName(moduleName).toLowerCase();
	const roles = new Set<FileRole>();

	if (
		/(^|\/)(__tests__|tests?)\//.test(normalized) ||
		/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
	) {
		addRole(roles, 'test_file');
	}
	if (
		/(^|\/)(app\/api|pages\/api)\//.test(normalized) ||
		/(^|\/)(routes?|controllers?)\//.test(normalized) ||
		/\/route\.[cm]?[jt]sx?$/.test(normalized) ||
		/\b(router|app|server)\s*\.\s*(get|post|put|patch|delete|all)\s*\(/i.test(
			content,
		)
	) {
		addRole(roles, 'api_route');
	}
	if (/(^|\/)middleware\.[cm]?[jt]sx?$/.test(normalized)) {
		addRole(roles, 'middleware');
	}
	if (normalized.startsWith('src/tools/')) addRole(roles, 'swarm_tool');
	if (normalized.startsWith('src/hooks/')) addRole(roles, 'hook');
	if (normalized.startsWith('src/agents/')) addRole(roles, 'agent');
	if (
		normalized.startsWith('src/cli/') ||
		normalized.startsWith('src/commands/')
	) {
		addRole(roles, 'cli_command');
	}
	if (
		normalized.startsWith('src/config/') ||
		/(^|\/)(config|settings)\.[cm]?[jt]s$/.test(normalized)
	) {
		addRole(roles, 'config');
	}
	if (
		/(^|\/)(schema|schemas|types)\//.test(normalized) ||
		/\b(z\.object|type\s+\w+\s*=|interface\s+\w+)/.test(content)
	) {
		addRole(roles, 'schema');
	}
	if (
		/(^|\/)(db|database|repositories?|models?|migrations?)\//.test(
			normalized,
		) ||
		/\b(prisma|drizzle|sequelize|knex|sqlite|sql`|db\.)/i.test(content)
	) {
		addRole(roles, 'data_module');
	}
	if (
		/(^|\/)(services?|lib|utils?)\//.test(normalized) ||
		/\bexport\s+(async\s+)?function\b/.test(content)
	) {
		addRole(roles, 'service_module');
	}
	if (/\.(md|mdx|rst)$/.test(normalized)) addRole(roles, 'documentation');

	if (roles.size === 0) addRole(roles, 'source_module');
	return uniqueSorted(roles);
}

function pathRouteFromModule(moduleName: string): string | null {
	const normalized = normalizeModuleName(moduleName);
	const parts = normalized.split('/');
	const appApi = parts.findIndex((part, index) => {
		return part === 'api' && index > 0 && parts[index - 1] === 'app';
	});
	if (appApi >= 0) {
		const routeParts = parts
			.slice(appApi)
			.filter((part) => !/^route\.[cm]?[jt]sx?$/.test(part));
		return `/${routeParts.map(routeSegment).join('/')}`.replace(/\/+/g, '/');
	}
	const pagesApi = parts.findIndex((part, index) => {
		return part === 'api' && index > 0 && parts[index - 1] === 'pages';
	});
	if (pagesApi >= 0) {
		const last = parts[parts.length - 1]?.replace(/\.[^.]+$/, '');
		const routeParts = [...parts.slice(pagesApi, -1), last].filter(Boolean);
		return `/${routeParts.map(routeSegment).join('/')}`.replace(/\/+/g, '/');
	}
	return null;
}

function routeSegment(segment: string): string {
	return segment
		.replace(
			/^\[(\.\.\.)?(.+)]$/,
			(_m, rest: string | undefined, name: string) =>
				rest ? `:${name}*` : `:${name}`,
		)
		.replace(/\.[^.]+$/, '');
}

/**
 * Normalize one segment of a user-supplied route path so `route_trace` inputs
 * like `/api/users/[...slug]` match the normalized form RouteFacts store
 * (`/api/users/:slug*`). Exported for the query layer (KG-15, issue #1536).
 */
export function normalizeRoutePathInput(input: string): string {
	const segments = input
		.replace(/\\/g, '/')
		.split('/')
		.filter((segment) => segment.length > 0)
		.map((segment) => routeSegment(segment));
	return `/${segments.join('/')}`.replace(/\/+/g, '/');
}

function extractRoutes(moduleName: string, content: string): RouteFact[] {
	const routes: RouteFact[] = [];
	const pathRoute = pathRouteFromModule(moduleName);
	const lines = content.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const method of HTTP_METHODS) {
			const exportPattern = new RegExp(
				`\\bexport\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`,
			);
			if (pathRoute && exportPattern.test(line)) {
				routes.push({
					method,
					path: pathRoute,
					line: i + 1,
					source: 'handler_export',
				});
			}
		}

		const routerMatch = line.match(
			/\b(?:router|app|server)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`\0\r\n]+)['"`]/i,
		);
		if (routerMatch) {
			routes.push({
				method: routerMatch[1].toUpperCase() as RouteMethod,
				path: routerMatch[2],
				line: i + 1,
				source: 'router_call',
			});
		}
	}

	if (pathRoute && routes.length === 0) {
		routes.push({ method: 'ALL', path: pathRoute, source: 'file_path' });
	}

	return routes.slice(0, MAX_FACTS_PER_KIND);
}

function classifyDataOperation(line: string): DataOperationFact | null {
	const trimmed = line.trim();
	const lower = trimmed.toLowerCase();
	const evidence = trimmed.slice(0, 160);
	let operation: DataOperationFact['operation'] | null = null;
	let access: DataOperationFact['access'] = 'unknown';
	let entity: string | undefined;

	if (/\b(transaction|begintransaction|commit|rollback)\b/i.test(trimmed)) {
		operation = 'transaction';
		access = 'database';
	}
	if (
		/\b(migrate|migration|schema\.alter|createTable|dropTable)\b/i.test(trimmed)
	) {
		operation = 'migration';
		access = 'database';
	}
	if (
		/\b(findMany|findUnique|findFirst|select|query|count|aggregate)\b/.test(
			trimmed,
		)
	) {
		operation ??= 'read';
	}
	if (/\b(create|insert|update|upsert|save|patch)\b/.test(trimmed)) {
		operation ??= 'write';
	}
	if (/\b(delete|deleteMany|remove|destroy)\b/.test(trimmed)) {
		operation = 'delete';
	}
	if (
		/\b(sql`|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bfrom\b)/i.test(
			trimmed,
		)
	) {
		access = 'sql';
	}
	if (
		/\b(prisma|drizzle|sequelize|knex|db\.|database\.|repository\.)/i.test(
			trimmed,
		)
	) {
		access = access === 'sql' ? 'sql' : 'orm';
	}
	if (/\b(readFile|writeFile|appendFile|rmSync|unlink)\b/.test(trimmed)) {
		access = 'filesystem';
		operation ??= lower.includes('read') ? 'read' : 'write';
	}
	if (/\b(fetch|axios|http\.|https\.)\b/.test(trimmed)) {
		access = 'network';
		operation ??= 'read';
	}

	const entityMatch = trimmed.match(/\b(?:prisma|db|database)\.(\w+)/i);
	if (entityMatch) entity = entityMatch[1];

	if (!operation) return null;
	return { operation, access, entity, line: 0, evidence };
}

function extractDataOperations(content: string): DataOperationFact[] {
	const facts: DataOperationFact[] = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const fact = classifyDataOperation(lines[i]);
		if (!fact) continue;
		fact.line = i + 1;
		facts.push(fact);
		if (facts.length >= MAX_FACTS_PER_KIND) break;
	}
	return facts;
}

function extractSecurityFacts(content: string): SecurityFact[] {
	const facts: SecurityFact[] = [];
	const lines = content.split(/\r?\n/);
	const push = (
		kind: SecurityFact['kind'],
		line: number,
		evidence: string,
		confidence: SecurityFact['confidence'],
	) => {
		facts.push({
			kind,
			line,
			evidence: evidence.trim().slice(0, 160),
			confidence,
		});
	};

	for (let i = 0; i < lines.length && facts.length < MAX_FACTS_PER_KIND; i++) {
		const line = lines[i];
		if (
			/\b(requireAuth|requireUser|getServerSession|currentUser|verifyToken|jwt|isAuthenticated|ctx\.user|session)\b/i.test(
				line,
			)
		) {
			push('authentication', i + 1, line, 'high');
		}
		if (
			/\b(requireRole|hasPermission|authorize|authorization|isAdmin|rbac|policy\.check|can\()\b/i.test(
				line,
			)
		) {
			push('authorization', i + 1, line, 'high');
		}
		if (
			/\b(z\.object|safeParse|\.parse\(|joi\.|yup\.|validate\w*)\b/i.test(line)
		) {
			push('input_validation', i + 1, line, 'high');
		}
		if (/\b(csrf|csrfToken|sameSite)\b/i.test(line)) {
			push('csrf', i + 1, line, 'medium');
		}
		if (/\b(sanitize|escapeHtml|DOMPurify|xss)\b/i.test(line)) {
			push('sanitization', i + 1, line, 'medium');
		}
		if (/\b(secret|api[_-]?key|token|password)\b/i.test(line)) {
			push('secret_handling', i + 1, line, 'low');
		}
	}
	return facts;
}

function extractConventions(
	moduleName: string,
	roles: FileRole[],
	routes: RouteFact[],
): ConventionFact[] {
	const conventions: ConventionFact[] = [];
	if (roles.includes('test_file')) {
		conventions.push({
			name: 'test_file_naming',
			evidence: `${path.basename(moduleName)} matches test/spec naming`,
		});
	}
	if (routes.some((route) => route.source === 'handler_export')) {
		conventions.push({
			name: 'next_app_route_handler',
			evidence: 'HTTP method exports map to route handlers',
		});
	}
	if (roles.includes('swarm_tool')) {
		conventions.push({
			name: 'swarm_tool_module',
			evidence: 'module lives under src/tools',
		});
	}
	if (roles.includes('hook')) {
		conventions.push({
			name: 'hook_module',
			evidence: 'module lives under src/hooks',
		});
	}
	return conventions;
}

function buildFindings(
	roles: FileRole[],
	routes: RouteFact[],
	dataOperations: DataOperationFact[],
	security: SecurityFact[],
): OntologyFinding[] {
	const findings: OntologyFinding[] = [];
	const hasAuth = security.some(
		(fact) =>
			fact.kind === 'authentication' ||
			fact.kind === 'authorization' ||
			fact.kind === 'csrf',
	);
	const hasValidation = security.some(
		(fact) => fact.kind === 'input_validation' || fact.kind === 'sanitization',
	);
	const mutatingRoute = routes.some((route) =>
		['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(route.method),
	);
	const writes = dataOperations.filter((fact) =>
		['write', 'delete', 'migration'].includes(fact.operation),
	);
	const hasTransaction = dataOperations.some(
		(fact) => fact.operation === 'transaction',
	);

	if (roles.includes('api_route') && routes.length > 0 && !hasAuth) {
		findings.push({
			code: 'api_route_without_detected_auth',
			severity: 'medium',
			message:
				'No authentication, authorization, or CSRF guard was detected near this route.',
			line: routes[0]?.line,
		});
	}
	if (mutatingRoute && !hasValidation) {
		findings.push({
			code: 'mutating_route_without_detected_validation',
			severity: 'medium',
			message:
				'Route appears to mutate state without a detected validation or sanitization fact.',
			line: routes.find((route) =>
				['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(route.method),
			)?.line,
		});
	}
	if (writes.length > 1 && !hasTransaction) {
		findings.push({
			code: 'multiple_writes_without_detected_transaction',
			severity: 'low',
			message:
				'Multiple write/delete operations were detected without a transaction fact.',
			line: writes[0]?.line,
		});
	}
	return findings;
}

/**
 * Extract the route-handler symbol for a router-call route line, when the
 * FINAL argument is a named identifier (e.g. `router.get('/x', getUser)` or
 * `app.post('/x', authMw, validate, createUser)`). Anchoring on the last
 * argument matters: capturing "the identifier after the path" bound the WRONG
 * symbol (a middleware) on 3+-argument calls. Inline arrow/function handlers
 * and trailing option objects return null — the binding is file-level.
 *
 * The length bail keeps the lazy-scan regex away from quadratic backtracking:
 * a pathological-but-legal multi-hundred-KB argument (giant inline string)
 * would otherwise stall the synchronous build loop for tens of seconds.
 */
function routerCallHandlerSymbol(line: string): string | null {
	if (line.length > 500) return null;
	const match = line.match(
		/\b(?:router|app|server)\s*\.\s*(?:get|post|put|patch|delete|options|head|all)\s*\([^(]*?([A-Za-z_$][\w$]*)\s*\)\s*[;,)]?\s*$/,
	);
	return match?.[1] ?? null;
}

const CONFIG_KEY_PATTERN =
	/\bprocess\.env\.([A-Za-z_$][A-Za-z0-9_$]*)\b|\bprocess\.env\[\s*['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]\s*\]|\bimport\.meta\.env\.([A-Za-z_$][A-Za-z0-9_$]*)\b|\bDeno\.env\.get\(\s*['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]\s*\)/g;

/**
 * Extract change-risk links (KG-15, issue #1536): symbol/fact bindings that
 * connect routes, data operations, security facts, and config keys to their
 * subject so reviewers, test engineers, and security agents can query them
 * without broad file exploration.
 *
 * Runs on the comment-stripped content and the ALREADY-CAPPED fact arrays.
 * Deterministic order: HANDLES_ROUTE (route array order) → READS/WRITES/
 * DELETES (line asc) → VALIDATES/AUTHORIZES (line asc) → CONFIGURES (line
 * asc, deduped by key, <= MAX_CONFIGURES_PER_FILE). TESTS and USES_FIXTURE
 * are derived at query time (see `buildTestPack`), never extracted here.
 */
function extractLinks(
	content: string,
	routes: RouteFact[],
	dataOperations: DataOperationFact[],
	security: SecurityFact[],
): OntologyLink[] {
	const lines = content.split(/\r?\n/);
	const links: OntologyLink[] = [];

	// HANDLES_ROUTE — bind each route fact to its handler when evidence exists.
	for (const route of routes) {
		if (route.source === 'handler_export') {
			links.push({
				kind: 'HANDLES_ROUTE',
				subject: `${route.method} ${route.path}`,
				...(route.line !== undefined ? { line: route.line } : {}),
				...(route.line !== undefined
					? { evidence: (lines[route.line - 1] ?? '').trim().slice(0, 160) }
					: {}),
				confidence: 'high',
				symbol: route.method,
			});
		} else if (route.source === 'router_call') {
			const handler =
				route.line !== undefined
					? routerCallHandlerSymbol(lines[route.line - 1] ?? '')
					: null;
			links.push({
				kind: 'HANDLES_ROUTE',
				subject: `${route.method} ${route.path}`,
				...(route.line !== undefined ? { line: route.line } : {}),
				...(route.line !== undefined
					? { evidence: (lines[route.line - 1] ?? '').trim().slice(0, 160) }
					: {}),
				confidence: 'medium',
				...(handler ? { symbol: handler } : {}),
			});
		} else {
			links.push({
				kind: 'HANDLES_ROUTE',
				subject: `${route.method} ${route.path}`,
				confidence: 'low',
			});
		}
	}

	// READS / WRITES / DELETES — entity-keyed data access. Only facts with a
	// known entity produce a link; entity-less facts remain queryable facts.
	const operationKind: Record<
		DataOperationFact['operation'],
		'READS' | 'WRITES' | 'DELETES' | null
	> = {
		read: 'READS',
		write: 'WRITES',
		delete: 'DELETES',
		transaction: 'WRITES',
		migration: 'WRITES',
	};
	const dataLinks: OntologyLink[] = [];
	for (const fact of dataOperations) {
		if (!fact.entity) continue;
		const kind = operationKind[fact.operation];
		if (!kind) continue;
		const confidence: OntologyLinkConfidence =
			fact.operation === 'transaction' || fact.operation === 'migration'
				? 'low'
				: 'medium';
		dataLinks.push({
			kind,
			subject: fact.entity,
			line: fact.line,
			evidence: fact.evidence,
			confidence,
		});
	}
	dataLinks.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	links.push(...dataLinks);

	// VALIDATES / AUTHORIZES — security fact binding (file-level).
	const securityLinks: OntologyLink[] = [];
	for (const fact of security) {
		if (fact.kind === 'input_validation') {
			securityLinks.push({
				kind: 'VALIDATES',
				line: fact.line,
				evidence: fact.evidence,
				confidence: fact.confidence,
			});
		} else if (fact.kind === 'authorization') {
			securityLinks.push({
				kind: 'AUTHORIZES',
				line: fact.line,
				evidence: fact.evidence,
				confidence: fact.confidence,
			});
		}
	}
	securityLinks.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	links.push(...securityLinks);

	// CONFIGURES — env/config key access, deduped by key (first occurrence).
	const seenKeys = new Set<string>();
	const configureLinks: OntologyLink[] = [];
	for (let i = 0; i < lines.length && configureLinks.length < MAX_CONFIGURES_PER_FILE; i++) {
		const line = lines[i];
		CONFIG_KEY_PATTERN.lastIndex = 0;
		let match: RegExpExecArray | null;
		while (
			(match = CONFIG_KEY_PATTERN.exec(line)) !== null &&
			configureLinks.length < MAX_CONFIGURES_PER_FILE
		) {
			const key = match[1] ?? match[2] ?? match[3] ?? match[4];
			if (!key || seenKeys.has(key)) continue;
			seenKeys.add(key);
			configureLinks.push({
				kind: 'CONFIGURES',
				subject: key,
				line: i + 1,
				evidence: line.trim().slice(0, 160),
				confidence: 'medium',
			});
		}
	}
	links.push(...configureLinks);

	return links.slice(0, MAX_LINKS_PER_FILE);
}

export function extractFileOntology(
	input: ExtractFileOntologyInput,
): FileOntology {
	const moduleName = normalizeModuleName(input.moduleName);
	const content = stripComments(input.content);
	const roles = inferRoles(moduleName, content);
	const routes = extractRoutes(moduleName, content);
	const dataOperations = extractDataOperations(content);
	const security = extractSecurityFacts(content);
	const conventions = extractConventions(moduleName, roles, routes);
	const findings = buildFindings(roles, routes, dataOperations, security);
	// Order invariant: links are computed LAST from the final (already-capped)
	// fact arrays; reordering breaks the deterministic link contract.
	const links = extractLinks(content, routes, dataOperations, security);

	return {
		roles,
		packageBoundary:
			sourceBoundaryForLanguage(input.language, content) ??
			boundaryForModule(moduleName, input.hasManifest),
		routes,
		dataOperations,
		security,
		conventions,
		findings,
		links,
	};
}
