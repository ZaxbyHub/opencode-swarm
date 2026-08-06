#!/usr/bin/env bun
/**
 * CI enforcement for issue #2029 acceptance criterion AC6 — event contract
 * completeness.
 *
 * Given a new event type is added, this hard-fails CI unless it has: a
 * catalog entry, a resolvable producer citation, an intended
 * consumer/retention owner, a privacy class, a test, documentation, and an
 * OTel-mapping decision. Mirrors the structure, error formatting, and
 * exit-code semantics of `scripts/check-tool-registration.ts` (issue #507):
 * pure TS, repo-wide, hard-fail, no enforce/warn env var.
 *
 * Usage: bun run scripts/check-event-contract.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CATALOG_KINDS,
	EVENT_CATALOG,
	type OtelMappingKind,
} from '../src/observability/catalog';
import { LEGACY_ADAPTER_RULES } from '../src/observability/legacy';
import { mappingForEntry } from '../src/observability/otel-mapping';
import {
	assertBoundedCardinality,
	METRIC_LABEL_ALLOWLIST,
} from '../src/observability/sampling';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

const TELEMETRY_FILE = path.join(REPO_ROOT, 'src', 'telemetry.ts');
const CONTRACT_DOC = path.join(
	REPO_ROOT,
	'docs',
	'observability-event-contract.md',
);

const MIN_RETENTION_OWNER_ISSUE = 2030;
const MAX_RETENTION_OWNER_ISSUE = 2051;

const OTEL_MAPPING_KINDS: readonly OtelMappingKind[] = [
	'genai',
	'openinference',
	'none',
];

/**
 * Parse `src/telemetry.ts` as TEXT to extract the `TelemetryEvent` union
 * members. Deliberately text-based (not a TS compiler API parse) to keep
 * this check cheap and dependency-free, mirroring the regex-driven approach
 * in `scripts/check-tool-registration.ts`.
 *
 * Only matches LINE-ANCHORED `| 'name'` union-member lines (leading
 * whitespace then `|` then a quoted string). This deliberately does not
 * search for the union's closing `;` as a bare character scan: several
 * member lines carry explanatory `//` comments that themselves contain a
 * literal `;` (e.g. "...this issue targets; the cast is now gone."), which
 * would truncate a naive `indexOf(';', ...)` scan before the real closing
 * semicolon. Comment lines start with `//`, never with `|`, so anchoring on
 * `|` at line-start is immune to that. The scan stops at the first member
 * line whose own `;` immediately follows its closing quote — the true end
 * of the union.
 */
export function extractTelemetryEventUnionMembers(source: string): string[] {
	const startMarker = 'export type TelemetryEvent =';
	const startIdx = source.indexOf(startMarker);
	if (startIdx === -1) {
		throw new Error(
			`Could not find "${startMarker}" in ${path.relative(REPO_ROOT, TELEMETRY_FILE)}.`,
		);
	}
	const bodyStart = startIdx + startMarker.length;
	const members: string[] = [];
	const memberLineRe = /^[ \t]*\|[ \t]*'([^']+)'[ \t]*(;)?/gm;
	memberLineRe.lastIndex = bodyStart;
	let m: RegExpExecArray | null;
	let terminated = false;
	while ((m = memberLineRe.exec(source)) !== null) {
		members.push(m[1]);
		if (m[2]) {
			terminated = true;
			break;
		}
	}
	if (!terminated) {
		throw new Error(
			`Could not find the closing ";" of the TelemetryEvent union in ${path.relative(REPO_ROOT, TELEMETRY_FILE)}.`,
		);
	}
	return members;
}

/** GitHub-flavored-markdown-ish heading slugify: lowercase, strip
 * non-alphanumeric (keep spaces/hyphens/underscores), spaces -> hyphens. */
export function slugifyHeading(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9 _-]/g, '')
		.replace(/\s+/g, '-');
}

/** Extract the set of heading slugs from a markdown document's text. */
export function extractHeadingSlugs(markdown: string): Set<string> {
	const slugs = new Set<string>();
	const re = /^#{1,6}\s+(.+)$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) {
		slugs.add(slugifyHeading(m[1]));
	}
	return slugs;
}

const PRODUCER_PATTERN = /^src\/.+\.ts:(\d+)$/;

/**
 * Verify a `src/path.ts:LINE` citation resolves AND that the cited line mentions
 * `'<kind>'`. Returns error strings; empty when the citation is sound.
 */
export function checkCitationMentions(
	citation: string,
	kind: string,
	label: string,
	remedy: string,
	/** Injectable so tests can drive fixture trees instead of the real repo. */
	root: string = REPO_ROOT,
): string[] {
	const match = citation.match(PRODUCER_PATTERN);
	if (!match) {
		return [
			`${label} "${citation}" does not match the required "src/<path>.ts:<line>" format. ${remedy}`,
		];
	}
	const relPath = citation.slice(0, citation.lastIndexOf(':'));
	const lineNo = Number(match[1]);
	const absPath = path.join(root, relPath);
	if (!fs.existsSync(absPath)) {
		return [`${label} file "${relPath}" does not exist. ${remedy}`];
	}
	const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
	if (lineNo < 1 || lineNo > lines.length) {
		return [
			`${label} line ${lineNo} is out of range for "${relPath}" (${lines.length} lines). ${remedy}`,
		];
	}
	const cited = lines[lineNo - 1] ?? '';
	if (!cited.includes(`'${kind}'`)) {
		return [
			`${label} citation "${citation}" does not mention '${kind}'. ` +
				`Line ${lineNo} of ${relPath} is: ${cited.trim()}. The citation has gone stale — ${remedy}`,
		];
	}
	return [];
}

/**
 * Files whose prose `path:line` citations are resolved by check 10.
 *
 * Rationale: four independent review rounds of issue #2029 each found FALSE
 * hand-written citations that the structured catalog checks could not see —
 * including an inverted range (`:73-70`) produced by a mechanical fix, and a
 * fabricated matrix row naming a file that never mentions the store it claimed
 * to read. Manual re-auditing demonstrably does not converge, so the RESOLVABLE
 * subclass is closed by machinery instead.
 *
 * SCOPE, stated honestly so this docstring does not overclaim the way an earlier
 * revision did: check 10 verifies that a citation RESOLVES — the file exists, the
 * range is not inverted, and the line is within EOF. It does NOT judge semantic
 * aptness of arbitrary prose. A citation that resolves but points at unrelated
 * code is caught only where the expected token is known, i.e. by the per-entry
 * producer/consumer checks above. Do not read a green run as "every citation in
 * these files has been verified true".
 */
const CITATION_SCAN_GLOBS: readonly string[] = [
	'src/observability',
	'docs/observability-event-contract.md',
	'docs/releases/pending/2029-observability-event-contract.md',
	'docs/engineering-invariants.md',
];

/**
 * Opt-out marker for a DELIBERATE quotation of a bad citation.
 *
 * The scanner cannot distinguish a citation from a quotation of one, and
 * `docs/engineering-invariants.md` exists precisely to record defects — an entry
 * documenting "the citation `foo.ts:73-70` was inverted" is correct prose that
 * would otherwise turn CI red with no way out. A line carrying this marker is
 * skipped.
 *
 * This is a real trap, not a hypothetical: it fired on this very issue's own
 * write-up of its own defect.
 */
const CITATION_IGNORE_MARKER = 'citation-check:ignore';

/** `src/foo/bar.ts:12` or `src/foo/bar.ts:12-34`, as written in prose. */
const PROSE_CITATION_RE =
	/\b((?:src|scripts|tests)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|sh|json|md)):(\d+)(?:-(\d+))?\b/g;

function listScanFiles(
	root: string = REPO_ROOT,
	scanGlobs: readonly string[] = CITATION_SCAN_GLOBS,
): string[] {
	const out: string[] = [];
	for (const entry of scanGlobs) {
		const abs = path.join(root, entry);
		if (!fs.existsSync(abs)) continue;
		if (fs.statSync(abs).isDirectory()) {
			for (const name of fs.readdirSync(abs)) {
				const isSource = name.endsWith('.ts') && !name.endsWith('.test.ts');
				const isDoc = name.endsWith('.md');
				if (isSource || isDoc) out.push(path.join(abs, name));
			}
		} else {
			out.push(abs);
		}
	}
	return out;
}

/**
 * Resolve every prose `path:line` / `path:start-end` citation in the observability
 * module and its docs. Catches: a file that does not exist, a line past EOF, and
 * an inverted range (`73-70`) — the exact defects that survived two review passes.
 *
 * It deliberately does NOT try to judge semantic aptness of arbitrary prose; the
 * per-entry producer/consumer checks above do that where the kind is known.
 */
export function collectCitationResolutionErrors(
	/** Injectable so tests can drive fixture trees instead of the real repo. */
	root: string = REPO_ROOT,
	scanGlobs: readonly string[] = CITATION_SCAN_GLOBS,
): string[] {
	const errors: string[] = [];
	const lineCounts = new Map<string, number>();
	const countLines = (relPath: string): number | null => {
		if (lineCounts.has(relPath)) return lineCounts.get(relPath) ?? null;
		const abs = path.join(root, relPath);
		if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
			lineCounts.set(relPath, -1);
			return null;
		}
		const n = fs.readFileSync(abs, 'utf-8').split('\n').length;
		lineCounts.set(relPath, n);
		return n;
	};

	for (const file of listScanFiles(root, scanGlobs)) {
		const rel = path.relative(root, file).replace(/\\/g, '/');
		const text = fs.readFileSync(file, 'utf-8');
		// Line-scoped so a deliberate quotation can opt out (see
		// CITATION_IGNORE_MARKER) and so error messages can name the line.
		const textLines = text.split('\n');
		PROSE_CITATION_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PROSE_CITATION_RE.exec(text)) !== null) {
			const lineIndex = text.slice(0, m.index).split('\n').length - 1;
			if ((textLines[lineIndex] ?? '').includes(CITATION_IGNORE_MARKER)) {
				continue;
			}
			const target = m[1];
			const start = Number(m[2]);
			const end = m[3] === undefined ? undefined : Number(m[3]);
			const total = countLines(target);
			if (total === null) {
				errors.push(
					`${rel}: citation "${target}:${m[2]}${m[3] ? `-${m[3]}` : ''}" names a file that does not exist.`,
				);
				continue;
			}
			if (end !== undefined && end < start) {
				errors.push(
					`${rel}: citation "${target}:${start}-${end}" is an INVERTED range (end < start). Fix the range.`,
				);
				continue;
			}
			const highest = end ?? start;
			if (start < 1 || highest > total) {
				errors.push(
					`${rel}: citation "${target}:${start}${end ? `-${end}` : ''}" is out of range — ${target} has ${total} lines.`,
				);
			}
		}
	}
	return errors;
}

/**
 * Pure collector for event-contract violations (issue #2029 AC6). Returns
 * the list of human-readable error strings (empty when the contract holds).
 * Exported so the CI drift checker (scripts/drift-check.ts, issue #1497) can
 * reuse the exact same logic without triggering the CLI's `process.exit`,
 * mirroring how it reuses `collectToolRegistrationErrors`.
 */
export function collectEventContractErrors(): string[] {
	const errors: string[] = [];

	// 1) Catalog <-> TelemetryEvent union parity (both directions).
	let unionMembers: string[] = [];
	try {
		const telemetrySource = fs.readFileSync(TELEMETRY_FILE, 'utf-8');
		unionMembers = extractTelemetryEventUnionMembers(telemetrySource);
	} catch (err) {
		errors.push(
			`Could not parse the TelemetryEvent union from src/telemetry.ts: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	const unionSet = new Set(unionMembers);
	const catalogSet = new Set(CATALOG_KINDS);
	for (const kind of unionSet) {
		if (!catalogSet.has(kind)) {
			errors.push(
				`Event kind "${kind}" is a TelemetryEvent union member (src/telemetry.ts) but has no entry in EVENT_CATALOG (src/observability/catalog.ts). Add a catalog entry for it.`,
			);
		}
	}
	for (const kind of catalogSet) {
		if (!unionSet.has(kind)) {
			errors.push(
				`Catalog kind "${kind}" (src/observability/catalog.ts) is not a member of the TelemetryEvent union (src/telemetry.ts). Add it to the union, or remove the stale catalog entry.`,
			);
		}
	}

	// 2-8) Per-entry checks.
	for (const kind of CATALOG_KINDS) {
		const entry = EVENT_CATALOG[kind];
		if (!entry) continue;

		// 2) Per-entry completeness.
		if (!PRODUCER_PATTERN.test(entry.producer)) {
			errors.push(
				`Event "${kind}": producer "${entry.producer}" does not match the required "src/<path>.ts:<line>" format. Cite the real emit call site.`,
			);
		}
		if (!entry.privacyClass) {
			errors.push(
				`Event "${kind}": missing privacyClass. Declare the data-sensitivity classification for this event.`,
			);
		}
		if (!entry.category) {
			errors.push(`Event "${kind}": missing category.`);
		}
		if (!entry.severity) {
			errors.push(`Event "${kind}": missing severity.`);
		}
		if (
			!Number.isInteger(entry.retentionOwnerIssue) ||
			entry.retentionOwnerIssue < MIN_RETENTION_OWNER_ISSUE ||
			entry.retentionOwnerIssue > MAX_RETENTION_OWNER_ISSUE
		) {
			errors.push(
				`Event "${kind}": retentionOwnerIssue (${entry.retentionOwnerIssue}) must be an integer issue number in ${MIN_RETENTION_OWNER_ISSUE}..${MAX_RETENTION_OWNER_ISSUE}. Assign a retention-owner issue and cite it.`,
			);
		}
		if (!entry.docAnchor || entry.docAnchor.trim().length === 0) {
			errors.push(
				`Event "${kind}": missing docAnchor. Add a documented anchor in docs/observability-event-contract.md and reference it.`,
			);
		}
		if (!entry.testFile || entry.testFile.trim().length === 0) {
			errors.push(
				`Event "${kind}": missing testFile. Point to the test that asserts this entry's completeness.`,
			);
		}

		// 3) Producer reachability: the citation must resolve to a real file AND
		// the cited line must actually mention this event kind.
		//
		// A range-check alone is NOT sufficient, and that is not a hypothetical:
		// during issue #2029's own implementation review, all 26 `src/telemetry.ts`
		// citations silently went stale by +22 lines when the union and `emit()`
		// grew, and every one still "resolved" because the file was long enough.
		// A citation that points at unrelated code is exactly the silent drift this
		// catalog exists to prevent, so the gate reads the line.
		//
		// The cited line must mention the kind EXACTLY — no tolerance window. An
		// earlier version of this check allowed a 3-line forward window so a
		// formatted multi-line `emit(` could put the kind on the next line. The
		// final critic proved that window silently tolerated the very drift
		// direction that caused the original failure: when lines are inserted
		// ABOVE an emit, a stale citation points a line or two EARLY, which a
		// forward window swallows. Citations are therefore required to land on the
		// exact line bearing the kind literal.
		errors.push(
			...checkCitationMentions(
				entry.producer,
				kind,
				`Event "${kind}": producer`,
				'Repoint it at the exact line of the emit call.',
			),
		);

		// 3b) Consumer citations get the SAME treatment. Previously they were not
		// validated at all — and because rule 4 below treats a non-empty consumer
		// list as the escape hatch from the `futureOwnerIssue` requirement, an
		// unverified consumer string could silently exempt an entry from the owner
		// rule. A fabricated consumer is therefore load-bearing, not cosmetic.
		for (const consumer of entry.consumers) {
			errors.push(
				...checkCitationMentions(
					consumer,
					kind,
					`Event "${kind}": consumer`,
					'Repoint it at the exact line where the reader discriminates on this kind, or drop it and declare a futureOwnerIssue.',
				),
			);
		}

		// 4) Consumer/owner rule: an empty consumer list is allowed only
		// together with a valid futureOwnerIssue.
		if (entry.consumers.length === 0) {
			const owner = entry.futureOwnerIssue;
			if (
				owner === undefined ||
				!Number.isInteger(owner) ||
				owner < MIN_RETENTION_OWNER_ISSUE ||
				owner > MAX_RETENTION_OWNER_ISSUE
			) {
				errors.push(
					`Event "${kind}" has no consumer and no futureOwnerIssue (or an out-of-range one). Assign a futureOwnerIssue in ${MIN_RETENTION_OWNER_ISSUE}..${MAX_RETENTION_OWNER_ISSUE}, or add a real consumer.`,
				);
			}
		}

		// 5) Documentation exists and covers this entry's docAnchor.
		if (!fs.existsSync(CONTRACT_DOC)) {
			errors.push(
				`Event "${kind}": docs/observability-event-contract.md does not exist. Create it and document every catalog entry's docAnchor as a heading.`,
			);
		} else if (entry.docAnchor) {
			const docSource = fs.readFileSync(CONTRACT_DOC, 'utf-8');
			const headingSlugs = extractHeadingSlugs(docSource);
			const anchorTarget = entry.docAnchor.replace(/^#/, '');
			if (!headingSlugs.has(anchorTarget)) {
				errors.push(
					`Event "${kind}": docAnchor "${entry.docAnchor}" has no matching heading (slug "${anchorTarget}") in docs/observability-event-contract.md. Add a heading that slugifies to "${anchorTarget}".`,
				);
			}
		}

		// 6) Test file exists.
		if (entry.testFile) {
			const testAbsPath = path.join(REPO_ROOT, entry.testFile);
			if (!fs.existsSync(testAbsPath)) {
				errors.push(
					`Event "${kind}": testFile "${entry.testFile}" does not exist. Add the test that asserts this entry's completeness.`,
				);
			}
		}

		// 8) OTel mapping decision recorded.
		if (!OTEL_MAPPING_KINDS.includes(entry.otelMapping)) {
			errors.push(
				`Event "${kind}": otelMapping "${entry.otelMapping}" is not one of ${OTEL_MAPPING_KINDS.join(', ')}. Record an explicit OTel-mapping decision.`,
			);
		} else if (entry.otelMapping !== 'none') {
			const table = mappingForEntry(entry.otelMapping);
			if (Object.keys(table).length === 0) {
				errors.push(
					`Event "${kind}": otelMapping "${entry.otelMapping}" resolves to an empty attribute table via mappingForEntry(). Record a real mapping table, or declare "none".`,
				);
			}
		}
	}

	// 7) Bounded cardinality self-consistency: the allowlist itself must
	// pass its own cardinality rule.
	const allowlistResult = assertBoundedCardinality(METRIC_LABEL_ALLOWLIST);
	if (!allowlistResult.ok) {
		errors.push(
			`METRIC_LABEL_ALLOWLIST (src/observability/sampling.ts) fails its own assertBoundedCardinality() check: ${allowlistResult.violations.join(', ')}. A metric label allowlist must not contain a label its own rules reject.`,
		);
	}

	// 9) Legacy adapter rules (issue #2029 item 4) are exported as DATA, not
	// prose, precisely so the implementation and the documentation cannot drift
	// apart. Assert every exported rule is actually documented — otherwise the doc
	// could silently stop describing a rule the adapter still enforces.
	if (fs.existsSync(CONTRACT_DOC)) {
		const contractDoc = fs.readFileSync(CONTRACT_DOC, 'utf-8');
		for (const rule of LEGACY_ADAPTER_RULES) {
			const headline = (rule.split(':')[0] ?? rule).trim();
			if (!contractDoc.includes(headline)) {
				errors.push(
					`Legacy adapter rule "${headline}" (LEGACY_ADAPTER_RULES, src/observability/legacy.ts) is not documented in docs/observability-event-contract.md. Document the rule, or remove it from the exported list.`,
				);
			}
		}
	}

	// 10) Resolve every prose path:line citation in the observability module and
	// its docs (see CITATION_SCAN_GLOBS for why this is machinery, not review).
	errors.push(...collectCitationResolutionErrors());

	return errors;
}

function main(): void {
	const errors = collectEventContractErrors();
	if (errors.length > 0) {
		console.error('Event contract check FAILED:\n');
		for (const e of errors) console.error(`  - ${e}`);
		console.error(
			`\n${errors.length} violation(s). Every event kind needs: a catalog entry (src/observability/catalog.ts) in parity with the TelemetryEvent union (src/telemetry.ts), a resolvable producer citation, a consumer or a futureOwnerIssue, a retentionOwnerIssue, a privacy class, a documented anchor in docs/observability-event-contract.md, a test file, and a recorded OTel-mapping decision.`,
		);
		process.exit(1);
	}

	console.log(
		`Event contract check passed: ${CATALOG_KINDS.length} catalogued event kinds, coherent across the TelemetryEvent union, producers, consumers/owners, retention, documentation, tests, and OTel mapping.`,
	);
}

if (import.meta.main) {
	main();
}
