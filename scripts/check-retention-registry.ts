#!/usr/bin/env bun
/**
 * CI enforcement for issue #2036 — the retention and read-amplification
 * registry completeness gate.
 *
 * Given a new durable writer is added under `src/`, this hard-fails CI
 * unless the writer's module appears in a registry row (or the explicit
 * EXEMPT_WRITER_MODULES plumbing list) in `scripts/retention-registry.data.ts`.
 * Also validates every row's disposition against the issue's allowed set
 * (fix-in-issue within the sequence window / retain-by-design with citation /
 * not-a-defect with proof) and keeps the registry doc in lockstep with the
 * data. Mirrors `scripts/check-event-contract.ts` (issue #2029): pure TS,
 * repo-wide, hard-fail, exported collectors for tests, injectable root.
 *
 * DB-mediated boundary (issue #2480 redesign — the fs-write scan could not
 * see writes through an acquired SQLite handle):
 *   1. The swarm.db STORE-OP seam is enumerated: every durable store
 *      mutation (appendInsightCandidatesDb / consumeInsightCandidatesDb /
 *      upsertPhaseReportDb / importLegacyJsonl / importLegacyJsonFiles) is a
 *      WRITER_PATTERN, so a module calling one needs a registry row.
 *   2. RAW-handle confinement: the `Database` type may only be referenced
 *      outside `src/db/**` by modules in RAW_DB_HANDLE_MODULES (each already
 *      covered by a registry row) — new handle-mediated writers outside the
 *      store seam fail the gate instead of silently bypassing it.
 *   3. Reverse-staleness for `src/db/**`: a foundation module declared as a
 *      writer that no longer calls ANY enumerated seam is flagged (it has
 *      moved to an un-enumerated raw seam).
 * Honest boundary: this is an enumerated-seam ratchet, not a type-system
 * guarantee — a hypothetical `db.run(INSERT…)` on a handle smuggled past the
 * confinement list is still invisible. The confinement list is the enforced
 * surface; growing it requires a reviewed registry change.
 *
 * Usage: bun run scripts/check-retention-registry.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type CloseLifecycleFacts,
	type IdentifierResolver,
	isSqliteArtifact,
	parseCloseLifecycleFacts,
} from './close-lifecycle-facts';
import {
	CLOSE_ARTIFACTS_WITHOUT_REGISTRY_ROW,
	DISPOSITION_FORBIDDEN_STRINGS,
	EXEMPT_WRITER_MODULES,
	PROJECT_SWARM_ROWS_WITH_INDIRECT_ROOT,
	RETENTION_ISSUE_SEQUENCE,
	RETENTION_REGISTRY,
	type RetentionRow,
	SQLITE_ARTIFACTS_EXEMPT_FROM_ARCHIVE_CLEAN,
} from './retention-registry.data';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

const REGISTRY_DOC = path.join(
	REPO_ROOT,
	'docs',
	'observability-retention-registry.md',
);

/**
 * Write-API patterns that mark a module as a durable writer. Matched against
 * non-`//`-comment lines. `writeFile`/`appendFile` are lowercase-matched on a
 * word boundary immediately followed by `(`, so `atomicWriteFile(` (capital W)
 * and `appendFileSync(` (trailing S) do not satisfy the bare patterns — they
 * have their own explicit entries. SQLite handles are caught at the
 * open/acquire seam, and — since issue #2480 — at the swarm.db STORE-OP seam
 * (every durable store mutation goes through a named, enumerated function).
 */
const WRITER_PATTERNS: readonly RegExp[] = [
	/\bwriteFileSync\s*\(/,
	/\bwriteFile\s*\(/,
	/\bappendFileSync\s*\(/,
	/\bappendFile\s*\(/,
	/\bcreateWriteStream\s*\(/,
	/\bbunWrite\s*\(/,
	/\batomicWriteSwarmFile\s*\(/,
	/\batomicWriteSwarmFileSync\s*\(/,
	/\batomicWriteFile\s*\(/,
	/\batomicWriteFileSync\s*\(/,
	/\batomicWriteFileAnyRoot\s*\(/,
	/\bwriteFileFsyncedThenRename\s*\(/,
	/\bwriteDurableFileSync\s*\(/,
	/\bnew Database\s*\(/,
	/\bDatabaseSync\s*\(/,
	/\bloadDatabaseCtor\s*\(/,
	/\bgetProjectDb\s*\(/,
	/\bgetGlobalDb\s*\(/,
	// issue #2480: the swarm.db durable-store seam. Mutations AND the legacy
	// import (which renames legacy artifacts on disk) are durable-state
	// changes and must be row-owned.
	/\bappendInsightCandidatesDb\s*\(/,
	/\bconsumeInsightCandidatesDb\s*\(/,
	/\bupsertPhaseReportDb\s*\(/,
	/\bimportLegacyJsonl\s*\(/,
	/\bimportLegacyJsonFiles\s*\(/,
];

/**
 * DELETER BLINDNESS (issue #2483, accepted and recorded here): WRITER_PATTERNS
 * contains no unlink/rm/rename-reaper patterns, so pure deletion paths (the
 * retention sweep, close clean lists, residue scanner) are invisible to the
 * coverage ratchet. Extending the pattern set would flag every existing
 * cleanup path with no registry row to own it — reapers are not durable
 * writers. The two-rung disposition rules below (RESOLVED_SCOPE_ISSUES and
 * the authoritative direct-file exemption) bound the streams themselves
 * instead of trying to enumerate deleters.
 */

/**
 * Raw SQLite-handle confinement (issue #2480). Patterns that indicate a
 * module holds or types a raw `Database` handle (as opposed to going through
 * an enumerated store-op or open seam). Outside `src/db/**`, only
 * RAW_DB_HANDLE_MODULES members may do this.
 */
const RAW_HANDLE_PATTERNS: readonly RegExp[] = [
	/\bfrom 'bun:sqlite'/,
	/\bfrom "bun:sqlite"/,
	/:\s*Database\b/,
	/ReturnType<typeof getProjectDb>/,
	/ReturnType<typeof getGlobalDb>/,
];

/** Modules outside `src/db/**` permitted to hold raw Database handles. */
const RAW_DB_HANDLE_MODULES: Readonly<Record<string, string>> = {
	'src/commands/archive-sqlite.ts':
		'VACUUM INTO snapshot/verify connections — owned by the swarm.db / repo-memory registry rows',
	'src/memory/sqlite-provider.ts':
		'memory.db provider (own DB file) — owned by the memory-sqlite registry row',
	'src/tools/repo-graph/indexed-storage.ts':
		'repo-memory.sqlite store — owned by the repo-memory-index registry row',
};

export function moduleReferencesRawDbHandle(source: string): boolean {
	const executable = stripLineComments(source);
	return RAW_HANDLE_PATTERNS.some((pattern) => pattern.test(executable));
}

/** Strip `//` line comments (same approach as check-event-contract.ts). */
function stripLineComments(source: string): string {
	return source
		.split('\n')
		.filter((line) => !line.trim().startsWith('//'))
		.join('\n');
}

export function moduleWritesDurableState(source: string): boolean {
	const executable = stripLineComments(source);
	return WRITER_PATTERNS.some((pattern) => pattern.test(executable));
}

function listSourceModules(root: string): string[] {
	const srcRoot = path.join(root, 'src');
	if (!fs.existsSync(srcRoot)) return [];
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, {
			withFileTypes: true,
		})) {
			// Never follow symlinks: a planted symlink under src/ must not expand
			// the scan (or the CI read surface) beyond the repository checkout.
			if (entry.isSymbolicLink()) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts')) continue;
			if (entry.name.endsWith('.test.ts')) continue;
			if (entry.name.endsWith('.d.ts')) continue;
			const rel = path.relative(root, full).replace(/\\/g, '/');
			out.push(rel);
		}
	};
	walk(srcRoot);
	return out.sort();
}

/**
 * Enumerate every module under `src/` (excluding tests) that contains a
 * durable-write API call. Injectable root so tests can drive fixture trees.
 */
export function enumerateWriterModules(root: string = REPO_ROOT): string[] {
	return listSourceModules(root).filter((rel) => {
		try {
			return moduleWritesDurableState(
				fs.readFileSync(path.join(root, rel), 'utf-8'),
			);
		} catch {
			// Unreadable module (permissions, transient I/O): fail CLOSED — treat
			// it as a writer so the ratchet demands an explicit registration or
			// exemption rather than silently skipping coverage (PRR-011a).
			return true;
		}
	});
}

const CITATION_PATH_PATTERN = /(?:src|docs|scripts|tests)\/[A-Za-z0-9._/-]+\.(?:ts|md|json|sh)/g;

/** Extract repo-relative file paths from a citation string. */
export function extractCitationPaths(citation: string): string[] {
	return citation.match(CITATION_PATH_PATTERN) ?? [];
}

function dispositionIssueIsValid(issue: number): boolean {
	const { first, last, amendments } = RETENTION_ISSUE_SEQUENCE;
	return (
		(issue >= first && issue <= last) || amendments.includes(issue)
	);
}

/**
 * Issue #2483 ratchet rung 2 — FROZEN recurrence-hatch set. Issues whose
 * scope #2483 closed (the residual-durable-streams umbrella #2309 and #2483
 * itself) or that were closed as superseded (#2045/#2046 closure comments
 * flag the still-open accumulation gaps; #2047/#2048 were superseded by the
 * merged #2482 SQLite observability sink/index). A `fix-in-issue`
 * disposition naming one of these is rejected: pointing at a resolved
 * umbrella no longer passes — a new unbounded stream must carry a real bound
 * (cap/sweep/close) or a reviewed exemption under an OPEN owning issue.
 */
export const RESOLVED_SCOPE_ISSUES: ReadonlySet<number> = new Set<number>([
	2045, 2046, 2047, 2048, 2309, 2483,
]);

const VALID_STATE_CLASSES = new Set([
	'authoritative',
	'operational',
	'derived-rebuildable',
	'governed-content',
]);
const VALID_PRIVACY_CLASSES = new Set(['metadata', 'content', 'mixed']);
const VALID_LIMIT_SCOPES = new Set([
	'global',
	'per-trigger',
	'per-key',
	'session-scoped',
	'none',
]);
const VALID_CANONICAL_ROOTS = new Set([
	'project-swarm',
	'platform-config',
	'xdg-cache',
	'worktree',
	'outside-swarm',
	'planned',
]);

/**
 * Per-row shape/disposition validation over a SYNTHESIA-injectable row —
 * exported so tests can drive deliberately malformed rows through the real
 * gate logic (duplicate/empty/enum/forbidden cases; PRR-006).
 */
export function collectRowShapeErrors(row: RetentionRow): string[] {
	const errors: string[] = [];
	const label = `Row "${row.id}"`;

	if (!row.id || !row.pathGrammar) {
		errors.push(`${label}: id and pathGrammar must be non-empty.`);
	}
	if (!Number.isInteger(row.category) || row.category < 1 || row.category > 9) {
		errors.push(`${label}: category must be 1..9 (issue #2036 numbering).`);
	}
	if (!VALID_STATE_CLASSES.has(row.stateClass)) {
		errors.push(
			`${label}: stateClass "${row.stateClass}" is not one of authoritative | operational | derived-rebuildable | governed-content.`,
		);
	}
	if (!VALID_PRIVACY_CLASSES.has(row.privacyClass)) {
		errors.push(
			`${label}: privacyClass "${row.privacyClass}" is not one of metadata | content | mixed.`,
		);
	}
	// Issue #2483 ratchet rung 1 (frozen check C2/C6): an AUTHORITATIVE stream
	// on a direct-file store — a pathGrammar that does not route through
	// swarm.db — must carry a reviewed directFileExemption.reason restating
	// the row's own durability justification. New authoritative stores belong
	// in swarm.db unless a reviewed reason exempts them; a silent new
	// authoritative direct file is the #2483 defect class.
	if (
		row.stateClass === 'authoritative' &&
		!row.pathGrammar.includes('swarm.db') &&
		(typeof row.directFileExemption?.reason !== 'string' ||
			!row.directFileExemption.reason.trim())
	) {
		errors.push(
			`${label}: stateClass "authoritative" on a direct-file store (pathGrammar does not route through swarm.db) with no reviewed directFileExemption.reason — an authoritative direct-file exemption must restate the durability requirement that rules out the swarm.db surface (issue #2483 ratchet rung 1).`,
		);
	}
	if (!VALID_LIMIT_SCOPES.has(row.writeLimits.scope)) {
		errors.push(
			`${label}: writeLimits.scope "${row.writeLimits.scope}" is not one of global | per-trigger | per-key | session-scoped | none.`,
		);
	}
	if (!VALID_CANONICAL_ROOTS.has(row.canonicalRoot)) {
		errors.push(
			`${label}: canonicalRoot "${row.canonicalRoot}" is not a known root kind.`,
		);
	}
	if (row.canonicalRoot === 'planned' && row.writerModules.length > 0) {
		errors.push(
			`${label}: planned rows (category 9) must have no writerModules — no implementation may exist yet.`,
		);
	}
	for (const field of [
		'schemaVersion',
		'lockModel',
		'crashBehavior',
		'closePolicy',
		'resetPolicy',
		'legacyCompatibility',
		'healthSignal',
		'owner',
	] as const) {
		if (!row[field] || !String(row[field]).trim()) {
			errors.push(`${label}: required field "${field}" is empty.`);
		}
	}
	if (row.writerCitations.length === 0 && row.canonicalRoot !== 'planned') {
		errors.push(`${label}: at least one writer citation is required.`);
	}
	if (row.readerCitations.length === 0 && row.canonicalRoot !== 'planned') {
		errors.push(`${label}: at least one reader citation is required (a genuinely read-less stream still documents that fact as a reader citation).`);
	}
	if (!row.writeLimits.bound || !row.writeLimits.citation) {
		errors.push(`${label}: writeLimits.bound and .citation are required.`);
	}
	if (!row.readBound.bound || !row.readBound.citation) {
		errors.push(`${label}: readBound.bound and .citation are required.`);
	}
	if (!row.readBound.pattern) {
		errors.push(`${label}: readBound.pattern is required.`);
	}
	errors.push(...collectDispositionErrors(row));
	// Issue #2483 ratchet rung 2 (the recurrence hatch): a fix-in-issue
	// disposition may not name an issue in the frozen RESOLVED_SCOPE_ISSUES
	// set. #2309 is how every unbounded residual stream entered the registry
	// and persisted; closing that hatch means a resolved umbrella can never
	// again absorb a new unbounded stream.
	if (
		row.disposition.kind === 'fix-in-issue' &&
		RESOLVED_SCOPE_ISSUES.has(row.disposition.issue)
	) {
		errors.push(
			`${label} (disposition): fix-in-issue names #${row.disposition.issue}, a resolved scope issue (RESOLVED_SCOPE_ISSUES, issue #2483) — its scope was closed or superseded by #2483/#2482. A new unbounded stream must carry a real bound (writer cap, sweep family, or close lifecycle) with a not-a-defect/retain-by-design proof, or point at an OPEN owning issue.`,
		);
	}
	// Verified-unbounded streams (scope "none") may never be whitewashed as
	// bounded-by-design — the issue's no-owner-waiver rule. (Also pinned in
	// tests/unit/scripts/retention-registry-rows.test.ts.)
	if (row.writeLimits.scope === 'none' && row.disposition.kind !== 'fix-in-issue') {
		errors.push(
			`${label}: writeLimits.scope is "none" (verified unbounded) but the disposition is "${row.disposition.kind}" — an unbounded stream must be fix-in-issue.`,
		);
	}
	errors.push(...collectKeyspaceBoundErrors(row));
	for (const forbidden of DISPOSITION_FORBIDDEN_STRINGS) {
		const texts = [
			...Object.values(row.disposition).filter(
				(v): v is string => typeof v === 'string',
			),
			row.writeLimits.bound,
			// The #2038 keyspace declaration is held to the same no-owner-waiver
			// bar as every other bound statement: "TBD"/"defer"/"unknown" is not
			// an answer to "what makes this keyspace finite".
			row.writeLimits.keyspaceBound ?? '',
			row.readBound.bound,
			...row.writerCitations,
			...row.readerCitations,
		];
		for (const text of texts) {
			if (text.toLowerCase().includes(forbidden.toLowerCase())) {
				errors.push(
					`${label}: "${forbidden}" is not a completed disposition (issue #2036 no-owner-waiver rule).`,
				);
			}
		}
	}
	return errors;
}


/**
 * Phrases by which a keyspace declaration admits that the keyspace is NOT
 * finite. Matching one is not a formatting problem — it means the row is the
 * #2038 defect class and its disposition is wrong.
 *
 * Deliberately narrow (whole-word `unbounded`, plus the two idioms this
 * registry already uses for the same admission — see the `skill-changelogs`
 * row's "NO global ceiling across skills"). A broad heuristic here would fire
 * on honest finite justifications that merely mention the word in passing.
 */
const KEYSPACE_NOT_FINITE_PATTERNS: readonly RegExp[] = [
	/\bunbounded\b/i,
	/\bno (?:hard |aggregate )?(?:global )?ceiling\b/i,
	/\bnothing (?:deletes|reaps|removes|prunes)\b/i,
];

/**
 * Issue #2038 recurrence guardrail — the CI-check rung.
 *
 * DEFECT CLASS: a retention policy scoped PER-KEY was mistaken for a global
 * bound. A per-key cap bounds each key's history but not the store, because
 * steady-state size is O(distinct-keys x per-key-cap) — which is a bound only
 * when the KEYSPACE is finite. In #2038 the keyspace was `skillPath`
 * (unbounded: one key per distinct skill name), so a 500-entry-per-skill cap
 * yielded growth with no ceiling, and the row passed CI because the pre-#2038
 * gate constrained only `scope: 'none'` and said nothing about `per-key`.
 *
 * WHY THIS RUNG, AND NOT A STRONGER ONE. The stronger rungs are infeasible
 * here, not merely unattractive:
 *
 *   - Not a TYPE constraint. The obligation is a CONJUNCTION across sibling
 *     fields — `writeLimits.scope === 'per-key'` AND
 *     `disposition.kind !== 'fix-in-issue'`. `disposition` is a sibling of
 *     `writeLimits`, not a member of it, so no discriminated union on `scope`
 *     can express it. Narrowing `scope` alone would force the field onto every
 *     per-key row including the fix-in-issue ones the rule deliberately
 *     exempts — a different, stricter rule. And a type can require presence but
 *     can check neither non-emptiness nor whether the prose actually answers
 *     the question (`keyspaceBound: ''` and `keyspaceBound: 'TBD'` both
 *     typecheck).
 *   - Not a LINT rule. Biome lints syntax and local semantics; this is a
 *     cross-field semantic property of a specific DATA registry, keyed on
 *     values (`'per-key'`) rather than on code shape. Encoding it as a lint
 *     rule would mean teaching a general-purpose linter about one project data
 *     file.
 *   - Not a RUNTIME assertion. The registry is build-time documentation-as-data
 *     under `scripts/`; it is deliberately never loaded by the plugin
 *     (AGENTS.md invariants 1 and 2), so there is no runtime in which to assert.
 *
 * CI check over the data artifact is therefore the strongest rung available,
 * and it is the same rung the sibling `scope: 'none'` rule already occupies.
 */
export function collectKeyspaceBoundErrors(row: RetentionRow): string[] {
	if (row.writeLimits.scope !== 'per-key') return [];
	// fix-in-issue rows are exempt: they already declare the stream a defect
	// with a named owning issue, so there is nothing to whitewash.
	if (row.disposition.kind === 'fix-in-issue') return [];

	const label = `Row "${row.id}"`;
	const declared = (row.writeLimits.keyspaceBound ?? '').trim();

	if (!declared) {
		return [
			`${label}: writeLimits.scope is "per-key" and the disposition is "${row.disposition.kind}", but writeLimits.keyspaceBound is missing. A per-key retention cap bounds each KEY's history, NOT the store — steady-state size is O(distinct-keys x per-key-cap), which is a bound only if the KEYSPACE is finite. This is the issue #2038 defect class: a 500-entry-per-skillPath prune was registered as an adequate bound while the set of skill paths was unbounded, and the gate passed it because it only ever constrained scope "none". Declare what makes this keyspace finite, with a path:line citation — either a closed key domain (an enum/union, or an index bounded by a max-concurrency constant) or a reaper that deletes keys on a GLOBAL trigger. A per-key cap is not an answer. If nothing bounds the keyspace, the honest disposition is fix-in-issue, not "${row.disposition.kind}".`,
		];
	}

	const admission = KEYSPACE_NOT_FINITE_PATTERNS.find((p) => p.test(declared));
	if (admission) {
		return [
			`${label}: writeLimits.keyspaceBound declares the keyspace NOT finite (matched ${admission}) while the disposition is "${row.disposition.kind}". A per-key cap over an unbounded keyspace is the issue #2038 defect class, not a bounded-by-design stream — O(distinct-keys x per-key-cap) has no ceiling. Set the disposition to fix-in-issue under an owning issue (see the "skill-changelogs" row, which carries this same admission honestly under #2309), or bound the keyspace in code and restate this field.`,
		];
	}

	return [];
}

function collectDispositionErrors(row: RetentionRow): string[] {
	const errors: string[] = [];
	const label = `Row "${row.id}" (disposition)`;
	const d = row.disposition;
	if (d.kind === 'fix-in-issue') {
		if (!dispositionIssueIsValid(d.issue)) {
			errors.push(
				`${label}: fix-in-issue #${d.issue} is outside the #2029–#2051 sequence and the #2309 amendment issue.`,
			);
		}
		if (!d.note || !d.note.trim()) {
			errors.push(`${label}: fix-in-issue requires an explanatory note.`);
		}
	} else if (d.kind === 'retain-by-design') {
		if (!d.citation || !d.citation.trim()) {
			errors.push(
				`${label}: retain-by-design requires an authoritative durability/lifecycle citation.`,
			);
		}
	} else if (d.kind === 'not-a-defect') {
		if (!d.proof || !d.proof.trim()) {
			errors.push(`${label}: not-a-defect requires a source proof citation.`);
		}
	} else {
		errors.push(
			`${label}: disposition kind "${(d as { kind: string }).kind}" is not one of fix-in-issue | retain-by-design | not-a-defect.`,
		);
	}
	return errors;
}

/** Every cited repo path must exist and stay inside the repo root. */
export function collectCitationResolutionErrors(
	row: RetentionRow,
	root: string,
): string[] {
	const errors: string[] = [];
	const citations = [
		...row.writerCitations,
		...row.readerCitations,
		row.writeLimits.citation,
		// #2038 keyspace declarations carry their own path:line evidence; run it
		// through the same rot detector. Purely additive — a value with no repo
		// path in it yields no citations and so cannot fail here.
		row.writeLimits.keyspaceBound ?? '',
		row.readBound.citation,
	];
	if (row.disposition.kind === 'retain-by-design') {
		citations.push(row.disposition.citation);
	}
	if (row.disposition.kind === 'not-a-defect') {
		citations.push(row.disposition.proof);
	}
	const checked = new Set<string>();
	const rootAbs = path.resolve(root);
	for (const citation of citations) {
		for (const relPath of extractCitationPaths(citation)) {
			if (checked.has(relPath)) continue;
			checked.add(relPath);
			const abs = path.resolve(root, relPath);
			if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
				errors.push(
					`Row "${row.id}": citation path "${relPath}" escapes the repo root (malformed citation).`,
				);
				continue;
			}
			if (!fs.existsSync(abs)) {
				errors.push(
					`Row "${row.id}": citation path "${relPath}" does not exist in the repo (rotted citation).`,
				);
			}
		}
	}
	return errors;
}

/**
 * The coverage ratchet in isolation (writer enumeration → ownership +
 * stale-exemption checks). Exported separately from
 * collectRetentionRegistryErrors so fixture tests can drive a synthetic tree
 * with synthetic rows instead of the real repo + registry.
 */
export function collectCoverageRatchetErrors(
	root: string,
	registryRows: readonly { writerModules: readonly string[] }[],
	exemptModules: Readonly<Record<string, string>>,
): string[] {
	const errors: string[] = [];
	const declared = new Set<string>();
	for (const row of registryRows) {
		for (const m of row.writerModules) declared.add(m);
	}
	for (const m of Object.keys(exemptModules)) declared.add(m);

	const scanned = enumerateWriterModules(root);
	if (scanned.length === 0) {
		errors.push(
			`Writer enumeration scanned 0 modules under ${root}/src — the scanner is broken, so its results would be vacuously green.`,
		);
	}
	for (const modulePath of scanned) {
		if (!declared.has(modulePath)) {
			errors.push(
				`${modulePath} contains durable-write API calls but has no retention-registry row and is not in EXEMPT_WRITER_MODULES. Add it to a row's writerModules in scripts/retention-registry.data.ts (or the exempt plumbing list with a reason) — issue #2036 acceptance: a newly added durable writer cannot bypass the registry.`,
			);
		}
	}

	for (const modulePath of declared) {
		const abs = path.join(root, modulePath);
		if (!fs.existsSync(abs)) {
			errors.push(
				`Registry declares writer module "${modulePath}" which no longer exists — remove the stale entry.`,
			);
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(exemptModules, modulePath)) {
			let source: string;
			try {
				source = fs.readFileSync(abs, 'utf-8');
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				errors.push(
					`EXEMPT_WRITER_MODULES entry "${modulePath}" is unreadable (${reason}) — fix the entry or the file; the gate will not guess.`,
				);
				continue;
			}
			if (!moduleWritesDurableState(source)) {
				errors.push(
					`EXEMPT_WRITER_MODULES entry "${modulePath}" no longer contains any enumerated write API call — plumbing that stopped writing is a stale exemption; remove it.`,
				);
			}
		}
	}
	return errors;
}

const CLOSE_MODULE_REL = 'src/commands/close.ts';

/**
 * Issue #2480: raw-handle confinement. Every non-test module under `src/`
 * (outside `src/db/**`) that references the `Database` type must be a
 * RAW_DB_HANDLE_MODULES member — otherwise a new module can acquire a raw
 * handle and mediate writes invisibly to the fs-write scan. Injectable root
 * for fixture tests.
 */
export function collectDbHandleConfinementErrors(
	root: string = REPO_ROOT,
	allowlist: Readonly<Record<string, string>> = RAW_DB_HANDLE_MODULES,
): string[] {
	const errors: string[] = [];
	for (const rel of listSourceModules(root)) {
		if (rel === 'src/db' || rel.startsWith('src/db/')) continue;
		let source: string;
		try {
			source = fs.readFileSync(path.join(root, rel), 'utf-8');
		} catch {
			continue;
		}
		if (!moduleReferencesRawDbHandle(stripLineComments(source))) continue;
		if (!Object.prototype.hasOwnProperty.call(allowlist, rel)) {
			errors.push(
				`${rel} references a raw SQLite Database handle outside src/db/ and is not in RAW_DB_HANDLE_MODULES (scripts/check-retention-registry.ts, issue #2480). Raw handles bypass the enumerated durable-store seam: route the writes through a swarm.db store module (src/db/*-store.ts) or add the module to the confinement allowlist with a registry-backed reason.`,
			);
		}
	}
	for (const rel of Object.keys(allowlist)) {
		if (!fs.existsSync(path.join(root, rel))) {
			errors.push(
				`RAW_DB_HANDLE_MODULES entry "${rel}" no longer exists — remove the stale entry.`,
			);
		}
	}
	return errors;
}

/**
 * Issue #2480: reverse-staleness for the DB foundation. A `src/db/**` module
 * declared as a registry writer that no longer calls ANY enumerated write seam
 * has moved to an un-enumerated raw seam — the gate fails instead of passing
 * vacuously. (General reverse-staleness for ALL rows is deliberately out of
 * scope: rows outside src/db legitimately use bespoke durable seams that are
 * not enumerated, e.g. appendFsynced.)
 */
export function collectDbFoundationStalenessErrors(
	root: string = REPO_ROOT,
	registryRows: readonly { writerModules: readonly string[] }[] = RETENTION_REGISTRY,
): string[] {
	const errors: string[] = [];
	for (const row of registryRows) {
		for (const rel of row.writerModules) {
			if (rel !== 'src/db' && !rel.startsWith('src/db/')) continue;
			const abs = path.join(root, rel);
			if (!fs.existsSync(abs)) continue;
			let source: string;
			try {
				source = fs.readFileSync(abs, 'utf-8');
			} catch {
				continue;
			}
			if (!moduleWritesDurableState(source)) {
				errors.push(
					`Registry row "${row.id}" declares src/db module "${rel}" as a writer, but it no longer calls any enumerated write seam (issue #2480 reverse-staleness). It has moved to an un-enumerated raw seam — either enumerate the new seam in WRITER_PATTERNS or remove the stale writer entry.`,
				);
			}
		}
	}
	return errors;
}

/**
 * Resolve a bare identifier used inside close.ts (e.g. `REPO_MEMORY_FILENAME`)
 * to its string literal, by following close.ts's own import statements to the
 * exporting module. Fail-closed: an unresolvable identifier yields undefined,
 * which the parser turns into a hard error rather than a dropped artifact.
 */
export function makeCloseIdentifierResolver(
	root: string,
	closeSource: string,
): IdentifierResolver {
	const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g;
	const specsByName = new Map<string, string>();
	for (const m of closeSource.matchAll(importRe)) {
		for (const raw of m[1].split(',')) {
			const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
			if (name) specsByName.set(name.trim(), m[2]);
		}
	}
	return (name: string): string | undefined => {
		const spec = specsByName.get(name);
		if (!spec || !spec.startsWith('.')) return undefined;
		const base = path.resolve(
			path.dirname(path.join(root, CLOSE_MODULE_REL)),
			spec.replace(/\.js$/, ''),
		);
		for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
			let source: string;
			try {
				source = fs.readFileSync(candidate, 'utf-8');
			} catch {
				continue;
			}
			const decl = new RegExp(
				`export const ${name}\\s*(?::[^=]+)?=\\s*(?:'([^']*)'|"([^"]*)")`,
			).exec(source);
			if (decl) return decl[1] ?? decl[2];
		}
		return undefined;
	};
}

/** Load close.ts and extract its close-lifecycle facts for the real repo. */
export function loadCloseLifecycleFacts(root: string): CloseLifecycleFacts {
	let source: string;
	try {
		source = fs.readFileSync(path.join(root, CLOSE_MODULE_REL), 'utf-8');
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			archiveArtifacts: [],
			activeStateToClean: [],
			sqliteArchiveDispatch: [],
			sqliteCleanHandleClose: [],
			parseErrors: [
				`${CLOSE_MODULE_REL} could not be read (${reason}) — the issue #1534 close-lifecycle gate fails closed rather than passing vacuously.`,
			],
		};
	}
	return parseCloseLifecycleFacts(
		source,
		makeCloseIdentifierResolver(root, source),
	);
}

/**
 * Flat files a row owns DIRECTLY under `.swarm/`, extracted deterministically
 * from `pathGrammar`: plain `.swarm/<file>` tokens plus `.swarm/{a, b, c}`
 * brace lists. Deliberately does NOT expand the registry's sidecar shorthand
 * (`.swarm/x.jsonl (+ .checkpoint.json)`) — an extractor that guesses would
 * accuse rows falsely, whereas one that misses merely under-requires, and the
 * close.ts-side totality rule catches those sidecars anyway.
 */
export function extractFlatSwarmFiles(pathGrammar: string): string[] {
	const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/;
	const out: string[] = [];
	for (const m of pathGrammar.matchAll(/\.swarm\/\{([^}]*)\}/g)) {
		for (const part of m[1].split(',')) {
			const token = part.trim();
			if (FILE.test(token)) out.push(token);
		}
	}
	for (const m of pathGrammar.matchAll(/\.swarm\/([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
		if (FILE.test(m[1])) out.push(m[1]);
	}
	return [...new Set(out)];
}

function membershipOf(
	file: string,
	facts: CloseLifecycleFacts,
): 'archive+clean' | 'archive-only' | 'clean-only' | 'neither' {
	const archived = facts.archiveArtifacts.includes(file);
	const cleaned = facts.activeStateToClean.includes(file);
	if (archived && cleaned) return 'archive+clean';
	if (archived) return 'archive-only';
	if (cleaned) return 'clean-only';
	return 'neither';
}

/**
 * Issue #1534 recurrence guardrail — the CI-check rung.
 *
 * DEFECT CLASS: a durable `.swarm/` artifact whose CREATION is wired but whose
 * `/swarm close` LIFECYCLE is not. In #1534 the new artifact was
 * `repo-memory.sqlite` (WAL-mode SQLite) and three wirings were each nearly
 * omitted: (a) absent from `ARCHIVE_ARTIFACTS`/`ACTIVE_STATE_TO_CLEAN`, so
 * close orphans it; (b) archived by raw file copy instead of
 * `archiveSqliteSnapshot` (VACUUM INTO), which is not a consistent snapshot of
 * a WAL DB; (c) the cached handle not closed before `fs.unlink`, which fails
 * EBUSY on Windows only — invisible on a Linux CI host.
 *
 * Before this gate the registry already forced every durable writer to have a
 * row, and each row declared a prose `closePolicy` — but NOTHING checked that a
 * row claiming "archived"/"cleaned" actually appeared in close.ts's arrays, nor
 * that a SQLite artifact was routed through VACUUM INTO, nor that its handle
 * was closed before unlink. The loop is closed here in both directions:
 * registry -> close.ts (a declaration must match reality) and close.ts ->
 * registry (an artifact in the arrays must be declared by exactly one row).
 *
 * WHY THIS RUNG, AND NOT A STRONGER ONE. As with the sibling #2038 rule above,
 * the stronger rungs are unavailable here, not merely unattractive:
 *
 *   - Not a TYPE constraint. `tsconfig.json` is a single config with
 *     `include: ["src/**\/*"]` and no CI step runs `tsc` over `scripts/`, so a
 *     required field on `RetentionRow` would be enforced by ZERO gates — the
 *     types are erased and `bun run check:retention` executes regardless.
 *     Even with a `scripts/` tsconfig, a type can require the field's PRESENCE
 *     but cannot check that the declared value MATCHES close.ts, which is the
 *     entire invariant. The type rung is a complement to this check, never a
 *     substitute; building it is out of scope for #1534.
 *   - Not a LINT rule. Biome's configured scope is `src/**` and `tests/**`
 *     (biome.json), and this is a cross-artifact semantic property keyed on
 *     data VALUES rather than code shape — teaching a general-purpose linter
 *     about one project data file and one command module.
 *   - Not a RUNTIME assertion. The registry is build-time
 *     documentation-as-data under `scripts/`, deliberately never loaded by the
 *     plugin (AGENTS.md invariants 1 and 2), so there is no runtime in which
 *     close.ts could assert against it.
 *
 * ANTI-VACUOUS ANCHORS. Every fact is parsed from close.ts source, so parser
 * rot would otherwise yield a silently green run. The gate therefore requires
 * both arrays to be non-empty and demands `swarm.db` in the SQLite archive
 * dispatch set and in the clean-stage handle-close set — facts true on `main`
 * independently of any artifact this change adds.
 */
export function collectCloseLifecycleCoherenceErrors(
	rows: readonly RetentionRow[],
	facts: CloseLifecycleFacts,
	allowlist: readonly string[] = CLOSE_ARTIFACTS_WITHOUT_REGISTRY_ROW,
	indirectRootRows: readonly string[] = PROJECT_SWARM_ROWS_WITH_INDIRECT_ROOT,
	sqliteExempt: Readonly<
		Record<string, string>
	> = SQLITE_ARTIFACTS_EXEMPT_FROM_ARCHIVE_CLEAN,
): string[] {
	const errors: string[] = [...facts.parseErrors];

	// --- Anti-vacuous anchors -------------------------------------------------
	if (facts.archiveArtifacts.length === 0) {
		errors.push(
			'close.ts ARCHIVE_ARTIFACTS parsed as EMPTY — the issue #1534 close-lifecycle gate would be vacuously green. Fix scripts/close-lifecycle-facts.ts.',
		);
	}
	if (facts.activeStateToClean.length === 0) {
		errors.push(
			'close.ts ACTIVE_STATE_TO_CLEAN parsed as EMPTY — the issue #1534 close-lifecycle gate would be vacuously green. Fix scripts/close-lifecycle-facts.ts.',
		);
	}
	if (!facts.sqliteArchiveDispatch.includes('swarm.db')) {
		errors.push(
			`close.ts SQLite archive dispatch set is ${JSON.stringify(facts.sqliteArchiveDispatch)} and does not contain "swarm.db". swarm.db has been routed through archiveSqliteSnapshot since issue #2030, so its absence means the parser lost track of the dispatch site, not that the wiring changed — the gate fails closed rather than passing vacuously.`,
		);
	}
	if (!facts.sqliteCleanHandleClose.includes('swarm.db')) {
		errors.push(
			`close.ts clean-stage handle-close set is ${JSON.stringify(facts.sqliteCleanHandleClose)} and does not contain "swarm.db". closeProjectDb has guarded the swarm.db unlink since the Windows EBUSY fix (swarm-pr-review F-005), so its absence means the parser lost track of the guard, not that the wiring changed.`,
		);
	}

	// --- Registry -> close.ts: declarations must match reality ----------------
	const declaredBy = new Map<string, string[]>();
	for (const row of rows) {
		for (const [file, declared] of Object.entries(row.closeArrayMembership ?? {})) {
			if (!declaredBy.has(file)) declaredBy.set(file, []);
			declaredBy.get(file)?.push(row.id);
			const actual = membershipOf(file, facts);
			// A flat .swarm/ SQLite artifact declared anything other than
			// archive+clean is issue #1534 sub-defect (a) reintroduced verbatim:
			// the declaration matches close.ts (which indeed does nothing), and
			// rules (b)/(c) below never fire because they key on real array
			// membership. Closing that escape is the point of the frozen exempt map.
			if (
				isSqliteArtifact(file) &&
				declared !== 'archive+clean' &&
				!Object.prototype.hasOwnProperty.call(sqliteExempt, file)
			) {
				errors.push(
					`Row "${row.id}": closeArrayMembership declares the SQLite artifact "${file}" as "${declared}", not "archive+clean". A WAL-mode database left on disk across /swarm close is exactly the orphaning issue #1534 was about, and declaring it "${declared}" also silently disables the VACUUM INTO and handle-close rules (both key on real array membership). Wire it into close.ts's ARCHIVE_ARTIFACTS and ACTIVE_STATE_TO_CLEAN, or add "${file}" to SQLITE_ARTIFACTS_EXEMPT_FROM_ARCHIVE_CLEAN with a reviewed reason.`,
				);
			}
			if (declared !== actual) {
				errors.push(
					`Row "${row.id}": closeArrayMembership declares "${file}" as "${declared}" but src/commands/close.ts actually has it as "${actual}" (ARCHIVE_ARTIFACTS=${facts.archiveArtifacts.includes(file)}, ACTIVE_STATE_TO_CLEAN=${facts.activeStateToClean.includes(file)}). This is the issue #1534 defect class: a durable .swarm/ artifact whose creation is wired but whose /swarm close lifecycle is not. Either wire the artifact into close.ts's arrays or correct the declaration — the two must agree.`,
				);
			}
		}
	}

	// --- Coverage prompt: in-scope rows must declare --------------------------
	for (const row of rows) {
		if (row.canonicalRoot !== 'project-swarm') continue;
		if (indirectRootRows.includes(row.id)) continue;
		if (!row.pathGrammar.startsWith('.swarm/')) {
			errors.push(
				`Row "${row.id}": canonicalRoot is "project-swarm" but pathGrammar "${row.pathGrammar}" does not start with ".swarm/". The issue #1534 gate derives which flat artifacts a row owns from pathGrammar; a non-conforming grammar would silently exempt the row from declaring closeArrayMembership. Restate the grammar, or add the row to PROJECT_SWARM_ROWS_WITH_INDIRECT_ROOT with its indirection reason.`,
			);
			continue;
		}
		const declared = row.closeArrayMembership ?? {};
		for (const file of extractFlatSwarmFiles(row.pathGrammar)) {
			if (file in declared) continue;
			errors.push(
				`Row "${row.id}": pathGrammar names the flat .swarm/ artifact "${file}" but closeArrayMembership does not declare it. Every durable artifact directly under .swarm/ must state what /swarm close does with it — issue #1534 was exactly a new .swarm/ artifact whose close lifecycle was never wired. Declare it as "${membershipOf(file, facts)}" if close.ts is already correct, or wire close.ts first.`,
			);
		}
	}

	// --- close.ts -> registry: every wired artifact must be declared ----------
	const wired = [
		...new Set([...facts.archiveArtifacts, ...facts.activeStateToClean]),
	].sort();
	for (const file of wired) {
		const owners = declaredBy.get(file) ?? [];
		if (owners.length === 1) continue;
		if (owners.length > 1) {
			errors.push(
				`close.ts artifact "${file}" is declared by ${owners.length} registry rows (${owners.join(', ')}). Exactly one row must own each artifact's closeArrayMembership, otherwise a later edit can leave contradictory declarations.`,
			);
			continue;
		}
		if (allowlist.includes(file)) continue;
		errors.push(
			`close.ts wires the artifact "${file}" into its archive/clean arrays but no registry row declares it in closeArrayMembership. Issue #1534 acceptance: an artifact cannot gain a /swarm close lifecycle without a retention-registry row stating that lifecycle. Add "${file}": "${membershipOf(file, facts)}" to the owning row in scripts/retention-registry.data.ts.`,
		);
	}
	for (const file of allowlist) {
		if (!wired.includes(file)) {
			errors.push(
				`CLOSE_ARTIFACTS_WITHOUT_REGISTRY_ROW lists "${file}" but close.ts no longer wires it — remove the stale allowlist entry (the list may only shrink).`,
			);
			continue;
		}
		if ((declaredBy.get(file) ?? []).length > 0) {
			errors.push(
				`CLOSE_ARTIFACTS_WITHOUT_REGISTRY_ROW lists "${file}" but a registry row now declares it — remove the allowlist entry (the list may only shrink).`,
			);
		}
	}

	for (const file of Object.keys(sqliteExempt)) {
		if (!declaredBy.has(file)) {
			errors.push(
				`SQLITE_ARTIFACTS_EXEMPT_FROM_ARCHIVE_CLEAN lists "${file}" but no registry row declares it any more — remove the stale exemption (the map may only shrink).`,
			);
		}
	}

	// --- SQLite sub-defects (b) and (c) --------------------------------------
	for (const file of wired) {
		if (!isSqliteArtifact(file)) continue;
		if (
			facts.archiveArtifacts.includes(file) &&
			!facts.sqliteArchiveDispatch.includes(file)
		) {
			errors.push(
				`close.ts archives the SQLite artifact "${file}" but does NOT route it through archiveSqliteSnapshot (dispatch set: ${JSON.stringify(facts.sqliteArchiveDispatch)}). This is issue #1534 sub-defect (b): a raw file copy of a WAL-mode database is not a transactionally consistent snapshot — committed rows still in the -wal sidecar are lost and an in-flight writer can be captured mid-transaction. Add it to the archiveSqliteSnapshot branch in runArchiveStage.`,
			);
		}
		if (
			facts.activeStateToClean.includes(file) &&
			!facts.sqliteCleanHandleClose.includes(file)
		) {
			errors.push(
				`close.ts cleans the SQLite artifact "${file}" but the clean stage never closes its cached handle before fs.unlink (handle-close set: ${JSON.stringify(facts.sqliteCleanHandleClose)}). This is issue #1534 sub-defect (c): on Windows a long-lived WAL-mode connection holds a file lock and the unlink fails with EBUSY — a platform-specific failure INVISIBLE on a Linux CI host. Add an \`if (artifact === ...) { closeXxx(ctx.directory); }\` guard before the unlink in runCleanStage.`,
			);
		}
	}

	return errors;
}

/** Duplicate-row-id and empty-registry guards over an injectable row set. */
export function collectRegistryIdentityErrors(
	rows: readonly RetentionRow[],
): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (seen.has(row.id)) {
			errors.push(`Duplicate registry row id "${row.id}".`);
		}
		seen.add(row.id);
	}
	if (rows.length === 0) {
		errors.push('RETENTION_REGISTRY is empty — the gate is vacuous.');
	}
	return errors;
}

export function collectRetentionRegistryErrors(root: string = REPO_ROOT): string[] {
	const errors: string[] = [];
	const seenIds = new Set<string>();

	// 1) Row-shape, disposition, and citation checks.
	for (const row of RETENTION_REGISTRY) {
		seenIds.add(row.id);
		errors.push(...collectRowShapeErrors(row));
		errors.push(...collectCitationResolutionErrors(row, root));
	}
	errors.push(...collectRegistryIdentityErrors(RETENTION_REGISTRY));

	// 2+3) Writer coverage ratchet and stale-declaration checks.
	errors.push(
		...collectCoverageRatchetErrors(root, RETENTION_REGISTRY, EXEMPT_WRITER_MODULES),
	);

	// 3a) Issue #2480: raw-handle confinement + src/db reverse-staleness.
	errors.push(...collectDbHandleConfinementErrors(root));
	errors.push(...collectDbFoundationStalenessErrors(root, RETENTION_REGISTRY));

	// 3b) Issue #1534: close-lifecycle coherence between each row's declared
	// closeArrayMembership and what src/commands/close.ts actually does.
	errors.push(
		...collectCloseLifecycleCoherenceErrors(
			RETENTION_REGISTRY,
			loadCloseLifecycleFacts(root),
		),
	);

	// 4) Doc coherence: every row id must appear in the registry doc as a
	// backtick-wrapped slug (the doc renders ids as `id` cells). The anchor
	// prevents substring masking — plain includes() would let a longer id
	// (e.g. repo-graph-fingerprint) satisfy a shorter one (repo-graph).
	// Markdown link-definition anchors, when present, must map back one-to-one.
	if (fs.existsSync(REGISTRY_DOC)) {
		const doc = fs.readFileSync(REGISTRY_DOC, 'utf-8');
		for (const row of RETENTION_REGISTRY) {
			if (!doc.includes(`\`${row.id}\``)) {
				errors.push(
					`Registry row "${row.id}" is not documented (as a \`\`${row.id}\`\` slug) in docs/observability-retention-registry.md — document the row or remove it.`,
				);
			}
		}
		const docAnchors = doc.match(/\[([a-z0-9-]+)\]:/g) ?? [];
		const anchorIds = new Set(
			docAnchors.map((a) => a.slice(1, -2)),
		);
		for (const anchor of anchorIds) {
			if (!seenIds.has(anchor)) {
				errors.push(
					`Doc anchor "[${anchor}]" has no matching registry row — stale documentation.`,
				);
			}
		}
	} else {
		errors.push(
			`docs/observability-retention-registry.md not found at ${REGISTRY_DOC} — the ratified registry document is part of the gate.`,
		);
	}

	return errors;
}

function main(): void {
	const errors = collectRetentionRegistryErrors();
	if (errors.length > 0) {
		console.error('Retention registry check FAILED:\n');
		for (const e of errors) console.error(`  - ${e}`);
		console.error(
			`\n${errors.length} violation(s). Every durable stream under src/ needs a registry row (scripts/retention-registry.data.ts) with writers, readers, limits, read bound, close policy, owner, and a completed disposition; see docs/observability-retention-registry.md.`,
		);
		process.exit(1);
	}
	const fix = RETENTION_REGISTRY.filter((r) => r.disposition.kind === 'fix-in-issue').length;
	const retain = RETENTION_REGISTRY.filter((r) => r.disposition.kind === 'retain-by-design').length;
	const nad = RETENTION_REGISTRY.filter((r) => r.disposition.kind === 'not-a-defect').length;
	console.log(
		`Retention registry check passed: ${RETENTION_REGISTRY.length} rows (${fix} fix-in-issue, ${retain} retain-by-design, ${nad} not-a-defect); every enumerated writer module is registered or exempt.`,
	);
}

if (import.meta.main) {
	main();
}
