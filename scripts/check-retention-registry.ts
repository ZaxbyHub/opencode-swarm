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
 * Known limitation (documented in docs/observability-retention-registry.md
 * Appendix A): a module that only mutates an existing SQLite handle passed in
 * from elsewhere (no getProjectDb/getGlobalDb/Database construction of its
 * own) is not flagged; the DB-opening seam is the enforced boundary.
 *
 * Usage: bun run scripts/check-retention-registry.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DISPOSITION_FORBIDDEN_STRINGS,
	EXEMPT_WRITER_MODULES,
	RETENTION_ISSUE_SEQUENCE,
	RETENTION_REGISTRY,
	type RetentionRow,
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
 * open/acquire seam.
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
];

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
	// Verified-unbounded streams (scope "none") may never be whitewashed as
	// bounded-by-design — the issue's no-owner-waiver rule. (Also pinned in
	// tests/unit/scripts/retention-registry-rows.test.ts.)
	if (row.writeLimits.scope === 'none' && row.disposition.kind !== 'fix-in-issue') {
		errors.push(
			`${label}: writeLimits.scope is "none" (verified unbounded) but the disposition is "${row.disposition.kind}" — an unbounded stream must be fix-in-issue.`,
		);
	}
	for (const forbidden of DISPOSITION_FORBIDDEN_STRINGS) {
		const texts = [
			...Object.values(row.disposition).filter(
				(v): v is string => typeof v === 'string',
			),
			row.writeLimits.bound,
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
