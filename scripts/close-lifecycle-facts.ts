/**
 * Fact extraction from `src/commands/close.ts` for the issue #1534 recurrence
 * guardrail (consumed by `scripts/check-retention-registry.ts`).
 *
 * DEFECT CLASS (issue #1534): a durable `.swarm/` artifact whose CREATION is
 * wired but whose `/swarm close` LIFECYCLE is not. Three wirings are each easy
 * to omit and were each nearly omitted when `repo-memory.sqlite` was added:
 *
 *   (a) the artifact is missing from `ARCHIVE_ARTIFACTS` / `ACTIVE_STATE_TO_CLEAN`,
 *       so `/swarm close` orphans it;
 *   (b) a SQLite artifact is archived by raw file copy instead of
 *       `archiveSqliteSnapshot` (VACUUM INTO), which is not a transactionally
 *       consistent snapshot of a WAL-mode DB;
 *   (c) the cached DB handle is not closed before `fs.unlink`, which fails with
 *       EBUSY on Windows only — invisible on a Linux CI host.
 *
 * This module answers, mechanically, "what does close.ts ACTUALLY do?" so the
 * retention registry's per-artifact declarations can be checked against it.
 * It is deliberately a SOURCE parser rather than an import of close.ts:
 * importing that module would execute the whole command/plugin graph inside a
 * build-time gate, and hoisting the arrays into a leaf module would renumber
 * the `close.ts:NNN` line citations that ~40 registry rows carry in their
 * `closePolicy` prose (a real correctness cost for marginal robustness gain).
 *
 * Every extraction FAILS CLOSED: an array line the parser does not recognise,
 * an identifier it cannot resolve, or a dispatch site it cannot find becomes a
 * `parseErrors` entry rather than a silently-missing fact. The consuming gate
 * additionally anchors on `swarm.db` — a fact true independently of any
 * artifact being added — so parser rot surfaces as a failure instead of a
 * vacuously green run.
 *
 * Lives under `scripts/` — NOT `src/` — so it can never drift into the plugin
 * bundle or the initialization path (AGENTS.md invariants 1 and 2).
 */

/** Resolves a bare identifier used inside close.ts to its string literal value. */
export type IdentifierResolver = (name: string) => string | undefined;

export interface CloseLifecycleFacts {
	/** Literal artifact names in `ARCHIVE_ARTIFACTS`. */
	archiveArtifacts: readonly string[];
	/** Literal artifact names in `ACTIVE_STATE_TO_CLEAN`. */
	activeStateToClean: readonly string[];
	/**
	 * Artifact names routed through the `archiveSqliteSnapshot` (VACUUM INTO)
	 * branch of the archive stage — i.e. the operands of the `artifact === X`
	 * comparisons in the `if` that guards that call. Sub-defect (b).
	 */
	sqliteArchiveDispatch: readonly string[];
	/**
	 * Artifact names for which the clean stage closes a cached handle before
	 * `fs.unlink` — the operands of single-comparison `if (artifact === X) {`
	 * blocks whose body calls a `closeXxx(...)` function. Sub-defect (c).
	 */
	sqliteCleanHandleClose: readonly string[];
	/** Fail-closed diagnostics; a non-empty list means the facts are untrustworthy. */
	parseErrors: readonly string[];
}

/** Filenames that denote a SQLite database (the (b)/(c) sub-defect surface). */
export function isSqliteArtifact(name: string): boolean {
	return /\.(?:db|sqlite|sqlite3)$/i.test(name);
}

/**
 * Extract the body of a top-level `const <name> = [ ... ];` array literal.
 * Returns undefined when the declaration or its terminator is not found.
 */
function sliceArrayBody(source: string, name: string): string | undefined {
	const marker = `const ${name} = [`;
	const start = source.indexOf(marker);
	if (start < 0) return undefined;
	const bodyStart = start + marker.length;
	// Terminator: a line that is exactly `];` or `] as const;` at column 0.
	const term = /^\] *(?:as const)? *;$/m;
	const rest = source.slice(bodyStart);
	const m = term.exec(rest);
	if (!m) return undefined;
	return rest.slice(0, m.index);
}

const STRING_ENTRY = /^(?:'([^']*)'|"([^"]*)")\s*,?$/;
const IDENT_ENTRY = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*,?$/;

function parseArtifactArray(
	source: string,
	name: string,
	resolve: IdentifierResolver,
	parseErrors: string[],
): string[] {
	const body = sliceArrayBody(source, name);
	if (body === undefined) {
		parseErrors.push(
			`close.ts: could not locate the \`const ${name} = [ ... ];\` array literal. The issue #1534 close-lifecycle gate cannot verify anything without it — if the array was renamed or restructured, update scripts/close-lifecycle-facts.ts rather than leaving the gate vacuously green.`,
		);
		return [];
	}
	const out: string[] = [];
	let inBlockComment = false;
	for (const rawLine of body.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		if (inBlockComment) {
			if (line.includes('*/')) inBlockComment = false;
			continue;
		}
		if (line.startsWith('/*')) {
			if (!line.includes('*/')) inBlockComment = true;
			continue;
		}
		if (line.startsWith('//') || line.startsWith('*')) continue;
		const str = STRING_ENTRY.exec(line);
		if (str) {
			out.push(str[1] ?? str[2] ?? '');
			continue;
		}
		const ident = IDENT_ENTRY.exec(line);
		if (ident) {
			const value = resolve(ident[1]);
			if (value === undefined) {
				parseErrors.push(
					`close.ts: ${name} entry \`${ident[1]}\` could not be resolved to a string literal. The issue #1534 gate fails closed on unresolvable entries — export it as \`export const ${ident[1]} = '<filename>';\` from a module close.ts imports, or teach scripts/close-lifecycle-facts.ts how to resolve it.`,
				);
				continue;
			}
			out.push(value);
			continue;
		}
		parseErrors.push(
			`close.ts: unrecognised ${name} entry \`${line}\`. Only string literals and bare identifiers resolvable to string literals are supported; an unparsed entry would silently drop an artifact from the issue #1534 close-lifecycle gate.`,
		);
	}
	return out;
}

/** Collect `artifact === <literal|IDENT>` operands from a condition fragment. */
function comparisonOperands(
	fragment: string,
	resolve: IdentifierResolver,
	parseErrors: string[],
	context: string,
): string[] {
	const out: string[] = [];
	const re = /artifact\s*===\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][A-Za-z0-9_$]*))/g;
	for (const m of fragment.matchAll(re)) {
		const literal = m[1] ?? m[2];
		if (literal !== undefined) {
			out.push(literal);
			continue;
		}
		const name = m[3];
		if (!name) continue;
		const value = resolve(name);
		if (value === undefined) {
			parseErrors.push(
				`close.ts: ${context} compares \`artifact === ${name}\` but \`${name}\` could not be resolved to a string literal (issue #1534 gate fails closed).`,
			);
			continue;
		}
		out.push(value);
	}
	return out;
}

/** Body of the `{ ... }` block that starts at `openBraceIndex`. */
function blockBody(source: string, openBraceIndex: number): string {
	let depth = 0;
	for (let i = openBraceIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return source.slice(openBraceIndex + 1, i);
		}
	}
	return source.slice(openBraceIndex + 1);
}

/**
 * Operands of the `if` that guards the `archiveSqliteSnapshot(` call — the
 * sub-defect (b) dispatch set.
 */
function parseSqliteArchiveDispatch(
	source: string,
	resolve: IdentifierResolver,
	parseErrors: string[],
): string[] {
	const callIndex = source.indexOf('archiveSqliteSnapshot({');
	if (callIndex < 0) {
		parseErrors.push(
			'close.ts: no `archiveSqliteSnapshot({` call site found in the archive stage. Sub-defect (b) of issue #1534 (a WAL-mode SQLite artifact archived by raw file copy instead of VACUUM INTO) cannot be detected without it.',
		);
		return [];
	}
	const ifIndex = source.lastIndexOf('if (', callIndex);
	if (ifIndex < 0) {
		parseErrors.push(
			'close.ts: found `archiveSqliteSnapshot({` but no enclosing `if (` condition before it — the issue #1534 SQLite archive-routing gate cannot determine which artifacts are routed through VACUUM INTO.',
		);
		return [];
	}
	const braceIndex = source.indexOf('{', ifIndex);
	if (braceIndex < 0 || braceIndex > callIndex) {
		parseErrors.push(
			'close.ts: the `if` preceding `archiveSqliteSnapshot({` has no opening brace before the call — unexpected shape; update scripts/close-lifecycle-facts.ts.',
		);
		return [];
	}
	const condition = source.slice(ifIndex, braceIndex);
	const operands = comparisonOperands(
		condition,
		resolve,
		parseErrors,
		'the archiveSqliteSnapshot dispatch condition',
	);
	if (operands.length === 0) {
		parseErrors.push(
			'close.ts: the `if` guarding `archiveSqliteSnapshot({` contains no `artifact === ...` comparison — the issue #1534 SQLite archive-routing gate would be vacuous.',
		);
	}
	return operands;
}

/**
 * Artifacts whose clean-stage branch closes a cached handle before unlink —
 * the sub-defect (c) guard set. Matches single-comparison
 * `if (artifact === X) {` blocks whose body calls a `closeXxx(` function.
 */
function parseSqliteCleanHandleClose(
	source: string,
	resolve: IdentifierResolver,
	parseErrors: string[],
): string[] {
	const out: string[] = [];
	const re =
		/if\s*\(\s*artifact\s*===\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*\)\s*\{/g;
	for (const m of source.matchAll(re)) {
		const braceIndex = (m.index ?? 0) + m[0].length - 1;
		const body = blockBody(source, braceIndex);
		// A handle-close call: `closeProjectDb(`, `_internals.closeRepoMemory(`, …
		if (!/\bclose[A-Z][A-Za-z0-9_]*\s*\(/.test(body)) continue;
		const literal = m[1] ?? m[2];
		if (literal !== undefined) {
			out.push(literal);
			continue;
		}
		const name = m[3];
		if (!name) continue;
		const value = resolve(name);
		if (value === undefined) {
			parseErrors.push(
				`close.ts: clean-stage handle-close guard compares \`artifact === ${name}\` but \`${name}\` could not be resolved to a string literal (issue #1534 gate fails closed).`,
			);
			continue;
		}
		out.push(value);
	}
	return out;
}

/** Parse every close-lifecycle fact this gate needs out of close.ts source. */
export function parseCloseLifecycleFacts(
	source: string,
	resolve: IdentifierResolver,
): CloseLifecycleFacts {
	const parseErrors: string[] = [];
	return {
		archiveArtifacts: parseArtifactArray(
			source,
			'ARCHIVE_ARTIFACTS',
			resolve,
			parseErrors,
		),
		activeStateToClean: parseArtifactArray(
			source,
			'ACTIVE_STATE_TO_CLEAN',
			resolve,
			parseErrors,
		),
		sqliteArchiveDispatch: parseSqliteArchiveDispatch(
			source,
			resolve,
			parseErrors,
		),
		sqliteCleanHandleClose: parseSqliteCleanHandleClose(
			source,
			resolve,
			parseErrors,
		),
		parseErrors,
	};
}
