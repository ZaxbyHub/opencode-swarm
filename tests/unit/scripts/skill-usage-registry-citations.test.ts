import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	RETENTION_REGISTRY,
	type RetentionRow,
} from '../../../scripts/retention-registry.data';

/**
 * `check-retention-registry.ts` validates that a cited PATH exists, but never
 * that the LINE is accurate — citation rot is otherwise invisible to CI (PR
 * #2347 FB-004: 43 stale `path:line` occurrences drifted into the
 * 'skill-usage' / 'skill-usage-pending' rows across three separate revisions
 * of skill-usage-log.ts / skill-usage-pending.ts).
 *
 * This suite re-derives the CURRENT definition line of every symbol the two
 * rows cite (via a regex anchor against the real source, same technique
 * `retention-registry-rows.test.ts` uses for the background-delegations-ledger
 * row) and asserts the registry text still names that line. A citation that
 * drifts stale — because the cited function moved, or someone hand-typed the
 * wrong number — makes the relevant assertion below fail.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

function sourceLines(relativePath: string): string[] {
	return readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8').split(
		/\r?\n/,
	);
}

/** 1-indexed line number of the first line matching `pattern`. */
function lineOf(lines: string[], pattern: RegExp): number {
	const index = lines.findIndex((line) => pattern.test(line));
	if (index < 0) throw new Error(`missing source anchor ${pattern}`);
	return index + 1;
}

/** 1-indexed line number of the first match at/after `startLine`. */
function lineOfAfter(
	lines: string[],
	startLine: number,
	pattern: RegExp,
): number {
	const index = lines
		.slice(startLine - 1)
		.findIndex((line) => pattern.test(line));
	if (index < 0) {
		throw new Error(`missing source anchor ${pattern} after ${startLine}`);
	}
	return startLine + index;
}

function row(id: string): RetentionRow {
	const found = (RETENTION_REGISTRY as RetentionRow[]).find((r) => r.id === id);
	if (!found) throw new Error(`missing "${id}" row in RETENTION_REGISTRY`);
	return found;
}

/**
 * Asserts that `lines[line]` (1-indexed, +/- `window` lines to tolerate a
 * docblock sitting between the cited anchor and the actual declaration) names
 * `symbol` literally. This is the "adjacent, within a couple lines" allowance
 * the task spec calls out for docblock-preceded declarations.
 */
function expectLineNames(
	lines: string[],
	line: number,
	symbol: string,
	window = 2,
): void {
	const start = Math.max(1, line - window);
	const end = Math.min(lines.length, line + window);
	const around = lines.slice(start - 1, end).join('\n');
	expect(
		around.includes(symbol),
		`expected ${symbol} near line ${line} (window ${start}-${end}), got:\n${around}`,
	).toBe(true);
}

/**
 * Every `path:line[-line] Symbol` occurrence in `text` where the symbol
 * follows the citation directly — the format every `writerCitations` /
 * `readerCitations` array entry in the two rows under test uses.
 */
function extractLeadingCitations(
	text: string,
): Array<{ file: string; line: number; symbol: string }> {
	const pattern =
		/(src\/[\w./-]+\.ts):(\d+)(?:-\d+)?\s+([A-Za-z_][A-Za-z0-9_]*)/g;
	const out: Array<{ file: string; line: number; symbol: string }> = [];
	for (const m of text.matchAll(pattern)) {
		out.push({ file: m[1], line: Number(m[2]), symbol: m[3] });
	}
	return out;
}

describe('skill-usage-log.ts / skill-usage-pending.ts registry citations stay pinned to real lines (PR #2347 FB-004)', () => {
	const log = sourceLines('src/hooks/skill-usage-log.ts');
	const pending = sourceLines('src/hooks/skill-usage-pending.ts');
	const filesByBasename: Record<string, string[]> = {
		'skill-usage-log.ts': log,
		'skill-usage-pending.ts': pending,
	};

	describe("'skill-usage' row — array citations name real, current lines", () => {
		const r = row('skill-usage');

		test('every writerCitations entry names a real definition line', () => {
			expect(r.writerCitations.length).toBeGreaterThan(0);
			for (const citation of r.writerCitations) {
				const [leading] = extractLeadingCitations(citation);
				expect(
					leading,
					`no leading path:line Symbol in: ${citation}`,
				).toBeTruthy();
				const lines = filesByBasename[path.basename(leading.file)];
				expect(
					lines,
					`unknown source file cited: ${leading.file}`,
				).toBeTruthy();
				expectLineNames(lines, leading.line, leading.symbol);
			}
		});

		test('every readerCitations entry names a real definition line', () => {
			expect(r.readerCitations.length).toBeGreaterThan(0);
			for (const citation of r.readerCitations) {
				const [leading] = extractLeadingCitations(citation);
				expect(
					leading,
					`no leading path:line Symbol in: ${citation}`,
				).toBeTruthy();
				if (leading.file.includes('session-reflection.ts')) continue; // checked below
				const lines = filesByBasename[path.basename(leading.file)];
				expect(
					lines,
					`unknown source file cited: ${leading.file}`,
				).toBeTruthy();
				expectLineNames(lines, leading.line, leading.symbol);
			}
		});

		test('gatherSkillViolations citation names the real line in session-reflection.ts', () => {
			const reflection = sourceLines('src/services/session-reflection.ts');
			const gather = lineOf(
				reflection,
				/^export function gatherSkillViolations\(/,
			);
			expect(
				r.readerCitations.some((c) =>
					c.includes(
						`src/services/session-reflection.ts:${gather} gatherSkillViolations`,
					),
				),
			).toBe(true);
		});
	});

	describe("'skill-usage' row — prose-embedded citations", () => {
		const r = row('skill-usage');

		test('writeLimits.bound cites the real applyRetention line', () => {
			const start = lineOf(log, /^function applyRetention\(/);
			expect(r.writeLimits.bound).toContain(`skill-usage-log.ts:${start}`);
			expectLineNames(log, start, 'applyRetention');
		});

		test('writeLimits.citation cites the real SKILL_USAGE_LIMITS block', () => {
			const start = lineOf(pending, /^export const SKILL_USAGE_LIMITS = \{/);
			expect(r.writeLimits.citation).toContain(
				`skill-usage-pending.ts:${start}-101`,
			);
			expectLineNames(pending, start, 'SKILL_USAGE_LIMITS');
		});

		test('readBound.citation cites the real readLogSlice and TAIL_BYTES_DEFAULT lines', () => {
			const readLogSlice = lineOf(log, /^function readLogSlice\(/);
			const tailBytes = lineOf(log, /^export const TAIL_BYTES_DEFAULT = /);
			expect(r.readBound.citation).toContain(
				`skill-usage-log.ts:${readLogSlice}`,
			);
			expect(r.readBound.citation).toContain(
				`:${tailBytes} TAIL_BYTES_DEFAULT`,
			);
			expectLineNames(log, readLogSlice, 'readLogSlice');
			expectLineNames(log, tailBytes, 'TAIL_BYTES_DEFAULT');
		});

		test('crashBehavior cites real lines for every anchor it names', () => {
			const parseEntries = lineOf(log, /^function parseEntriesFromText\(/);
			const streamLines = lineOf(log, /^function streamLogLines\(/);
			const prune = lineOf(log, /^export function pruneSkillUsageLog\(/);
			const save = lineOf(pending, /^export function savePendingDocument\(/);
			const saveAt = lineOf(pending, /^function savePendingDocumentAt\(/);
			const writeFile = lineOfAfter(
				pending,
				saveAt,
				/_internals\.writeFileSync\(tmpPath, serialized/,
			);
			const renameFile = lineOfAfter(
				pending,
				writeFile,
				/_internals\.renameSync\(tmpPath, resolved\);/,
			);

			expect(r.crashBehavior).toContain(
				`parseEntriesFromText :${parseEntries}`,
			);
			expect(r.crashBehavior).toContain(`streamLogLines :${streamLines}`);
			expect(r.crashBehavior).toContain(`pruneSkillUsageLog :${prune}`);
			expect(r.crashBehavior).toContain(`savePendingDocument :${save}`);
			expect(r.crashBehavior).toContain(
				`savePendingDocumentAt, skill-usage-pending.ts:${saveAt}`,
			);
			expect(r.crashBehavior).toContain(`writeFileSync :${writeFile}`);
			expect(r.crashBehavior).toContain(`renameSync :${renameFile}`);

			expectLineNames(log, parseEntries, 'parseEntriesFromText');
			expectLineNames(log, streamLines, 'streamLogLines');
			expectLineNames(log, prune, 'pruneSkillUsageLog');
			expectLineNames(pending, save, 'savePendingDocument');
			expectLineNames(pending, saveAt, 'savePendingDocumentAt');
			expectLineNames(pending, writeFile, 'writeFileSync');
			expectLineNames(pending, renameFile, 'renameSync');
		});

		test('legacyCompatibility cites real lines for every anchor it names', () => {
			const normalize = lineOf(
				log,
				/^export function normalizeComplianceVerdict\(/,
			);
			const legacyId = lineOf(log, /^function legacySkillUsageId\(/);
			const migrate = lineOf(log, /^function migrateLegacyLog\(/);
			const stage = lineOf(log, /^function stagePendingDocument\(/);
			const adopt = lineOf(log, /^function adoptStagedDocument\(/);

			expect(r.legacyCompatibility).toContain(
				`skill-usage-log.ts:${normalize}`,
			);
			expect(r.legacyCompatibility).toContain(`:${legacyId}`);
			expect(r.legacyCompatibility).toContain(`migrateLegacyLog (:${migrate}`);
			expect(r.legacyCompatibility).toContain(`stagePendingDocument :${stage}`);
			expect(r.legacyCompatibility).toContain(`adoptStagedDocument :${adopt}`);

			expectLineNames(log, normalize, 'normalizeComplianceVerdict');
			expectLineNames(log, legacyId, 'legacySkillUsageId');
			expectLineNames(log, migrate, 'migrateLegacyLog');
			expectLineNames(log, stage, 'stagePendingDocument');
			expectLineNames(log, adopt, 'adoptStagedDocument');
		});

		test("disposition.citation cites SKILL_USAGE_LOCK_STALE_MS at its OWN definition line, not the lock function's", () => {
			const staleMs = lineOf(
				pending,
				/^export const SKILL_USAGE_LOCK_STALE_MS = /,
			);
			const lockAcquire = lineOf(
				pending,
				/^export function acquireSkillUsageLock\(/,
			);
			expect(r.disposition.citation).toContain(
				`skill-usage-pending.ts:${staleMs}`,
			);
			expect(r.disposition.citation).not.toContain(
				`skill-usage-pending.ts:${lockAcquire}`,
			);
			expectLineNames(pending, staleMs, 'SKILL_USAGE_LOCK_STALE_MS');
		});

		test('disposition.citation cites the real enqueueSkillUsageFeedback call site', () => {
			const enqueue = lineOf(
				pending,
				/^export function enqueueSkillUsageFeedback\(/,
			);
			expect(r.disposition.citation).toContain(
				`enqueueSkillUsageFeedback (skill-usage-pending.ts:${enqueue}`,
			);
			expectLineNames(pending, enqueue, 'enqueueSkillUsageFeedback');
		});
	});

	describe("'skill-usage-pending' row — array citations name real, current lines", () => {
		const r = row('skill-usage-pending');

		test('every writerCitations entry names a real definition line', () => {
			expect(r.writerCitations.length).toBeGreaterThan(0);
			for (const citation of r.writerCitations) {
				const [leading] = extractLeadingCitations(citation);
				expect(
					leading,
					`no leading path:line Symbol in: ${citation}`,
				).toBeTruthy();
				const lines = filesByBasename[path.basename(leading.file)];
				expectLineNames(lines, leading.line, leading.symbol);
			}
		});

		test('every readerCitations entry names a real definition line', () => {
			expect(r.readerCitations.length).toBeGreaterThan(0);
			for (const citation of r.readerCitations) {
				const [leading] = extractLeadingCitations(citation);
				expect(
					leading,
					`no leading path:line Symbol in: ${citation}`,
				).toBeTruthy();
				const lines = filesByBasename[path.basename(leading.file)];
				expectLineNames(lines, leading.line, leading.symbol);
			}
		});
	});

	describe("'skill-usage-pending' row — prose-embedded citations", () => {
		const r = row('skill-usage-pending');

		test('readBound.citation cites the real loadPendingDocument / loadPendingDocumentAt span', () => {
			// `loadPendingDocument` is a thin wrapper; the actual bounded-read /
			// quarantine logic this citation describes lives in
			// `loadPendingDocumentAt`, which it delegates to. Derive BOTH lines
			// from source rather than hardcoding either, so a future refactor of
			// either function's location fails this test instead of drifting
			// silently (PR #2347 Stage-B review: the hardcoded-literal form of
			// this test passed against a stale citation).
			const load = lineOf(pending, /^export function loadPendingDocument\(/);
			const loadAt = lineOf(pending, /^function loadPendingDocumentAt\(/);
			expect(r.readBound.citation).toContain(
				`skill-usage-pending.ts:${load} loadPendingDocument`,
			);
			expect(r.readBound.citation).toContain(
				`loadPendingDocumentAt :${loadAt}-789`,
			);
			expectLineNames(pending, load, 'loadPendingDocument');
			expectLineNames(pending, loadAt, 'loadPendingDocumentAt');
		});

		test('lockModel cites SKILL_USAGE_LOCK_STALE_MS at its own definition line and acquireSkillUsageLockOrThrow at its real span', () => {
			const staleMs = lineOf(
				pending,
				/^export const SKILL_USAGE_LOCK_STALE_MS = /,
			);
			const lockAcquire = lineOf(
				pending,
				/^export function acquireSkillUsageLock\(/,
			);
			const orThrow = lineOf(
				pending,
				/^export function acquireSkillUsageLockOrThrow\(/,
			);
			expect(r.lockModel).toContain(`skill-usage-pending.ts:${staleMs}`);
			expect(r.lockModel).not.toContain(
				`skill-usage-pending.ts:${lockAcquire}`,
			);
			expect(r.lockModel).toContain(`acquireSkillUsageLockOrThrow :${orThrow}`);
			expectLineNames(pending, staleMs, 'SKILL_USAGE_LOCK_STALE_MS');
			expectLineNames(pending, orThrow, 'acquireSkillUsageLockOrThrow');
		});

		test('crashBehavior cites real lines for every anchor it names', () => {
			const save = lineOf(pending, /^export function savePendingDocument\(/);
			const saveAt = lineOf(pending, /^function savePendingDocumentAt\(/);
			const quarantine = lineOf(
				pending,
				/^function quarantinePendingDocument\(/,
			);
			const loadAt = lineOf(pending, /^function loadPendingDocumentAt\(/);
			const quarantineCall = lineOfAfter(
				pending,
				loadAt,
				/quarantinePendingDocument\(directory, resolved\);/,
			);
			const staleResolve = lineOf(
				pending,
				/^export function resolveStaleInFlight\(/,
			);

			expect(r.crashBehavior).toContain(`savePendingDocument :${save}`);
			expect(r.crashBehavior).toContain(`savePendingDocumentAt :${saveAt}`);
			expect(r.crashBehavior).toContain(
				`quarantinePendingDocument :${quarantine}`,
			);
			expect(r.crashBehavior).toContain(
				`loadPendingDocumentAt :${quarantineCall}`,
			);
			expect(r.crashBehavior).toContain(
				`resolveStaleInFlight :${staleResolve}`,
			);

			expectLineNames(pending, save, 'savePendingDocument');
			expectLineNames(pending, saveAt, 'savePendingDocumentAt');
			expectLineNames(pending, quarantine, 'quarantinePendingDocument');
			expectLineNames(pending, staleResolve, 'resolveStaleInFlight');
		});

		test('legacyCompatibility and healthSignal cite real lines', () => {
			const migrate = lineOf(log, /^function migrateLegacyLog\(/);
			const buildHealth = lineOf(
				pending,
				/^export function buildSkillUsageHealthPayload\(/,
			);
			const emitHealth = lineOf(
				pending,
				/^export function emitSkillUsageHealth\(/,
			);

			expect(r.legacyCompatibility).toContain(`skill-usage-log.ts:${migrate}`);
			expect(r.healthSignal).toContain(`skill-usage-pending.ts:${buildHealth}`);
			expect(r.healthSignal).toContain(`emitSkillUsageHealth (:${emitHealth}`);

			expectLineNames(log, migrate, 'migrateLegacyLog');
			expectLineNames(pending, buildHealth, 'buildSkillUsageHealthPayload');
			expectLineNames(pending, emitHealth, 'emitSkillUsageHealth');
		});

		test('disposition.citation cites real lines for applySkillUsageFeedback, enforceQueueBounds, evictionRank, savePendingDocument', () => {
			const applyFeedback = lineOf(
				log,
				/^export async function applySkillUsageFeedback\(/,
			);
			const enforceBounds = lineOf(
				pending,
				/^export function enforceQueueBounds\(/,
			);
			const evictionRank = lineOf(pending, /^function evictionRank\(/);
			// The divergence rationale this citation actually points readers at
			// lives in `evictionRank`'s DOCBLOCK, not its 5-line body — derive the
			// docblock's own start rather than the declaration line, so the
			// citation stays anchored to where the prose it claims to cite
			// actually is (Stage-B review, PR #2347 round 2).
			const evictionRankDocblockStart = lineOfAfter(
				pending,
				evictionRank - 40,
				/^\/\*\*/,
			);
			const save = lineOf(pending, /^export function savePendingDocument\(/);
			const saveAt = lineOf(pending, /^function savePendingDocumentAt\(/);

			expect(r.disposition.citation).toContain(
				`applySkillUsageFeedback (src/hooks/skill-usage-log.ts:${applyFeedback}`,
			);
			expect(r.disposition.citation).toContain(
				`enforceQueueBounds (:${enforceBounds}`,
			);
			expect(r.disposition.citation).toContain(
				`evictionRank docblock :${evictionRankDocblockStart}`,
			);
			expect(r.disposition.citation).toContain(
				`savePendingDocument :${save} via savePendingDocumentAt :${saveAt}`,
			);

			expectLineNames(log, applyFeedback, 'applySkillUsageFeedback');
			expectLineNames(pending, enforceBounds, 'enforceQueueBounds');
			expectLineNames(pending, evictionRank, 'evictionRank');
		});
	});
});
