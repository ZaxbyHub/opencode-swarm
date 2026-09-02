import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	DISPOSITION_FORBIDDEN_STRINGS,
	EXEMPT_WRITER_MODULES,
	RETENTION_ISSUE_SEQUENCE,
	RETENTION_REGISTRY,
	RETENTION_REGISTRY_SCHEMA_VERSION,
	RETENTION_REGISTRY_SUMMARY,
	type RetentionRow,
} from '../../../scripts/retention-registry.data';

/**
 * Row-data validation for the #2036 retention registry: completeness,
 * disposition legality, sequence-window bounds, and the no-waiver rule.
 * The doc-coherence contract is covered by retention-registry-doc.test.ts;
 * the fixture-tree enumerator behavior by check-retention-registry.test.ts.
 */

const REQUIRED_STRING_FIELDS = [
	'schemaVersion',
	'lockModel',
	'crashBehavior',
	'closePolicy',
	'resetPolicy',
	'legacyCompatibility',
	'healthSignal',
	'owner',
] as const;

function rows(): RetentionRow[] {
	return RETENTION_REGISTRY as RetentionRow[];
}

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

function sourceLines(relativePath: string): string[] {
	return readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8').split(
		/\r?\n/,
	);
}

function lineOf(lines: string[], pattern: RegExp): number {
	const index = lines.findIndex((line) => pattern.test(line));
	if (index < 0) throw new Error(`missing source anchor ${pattern}`);
	return index + 1;
}

function lineOfAfter(
	lines: string[],
	startLine: number,
	pattern: RegExp,
): number {
	const index = lines
		.slice(startLine - 1)
		.findIndex((line) => pattern.test(line));
	if (index < 0)
		throw new Error(`missing source anchor ${pattern} after ${startLine}`);
	return startLine + index;
}

describe('retention registry rows — shape completeness', () => {
	test('registry data schema version is pinned', () => {
		expect(RETENTION_REGISTRY_SCHEMA_VERSION).toBe(1);
	});

	test('registry is non-empty and summary matches the data', () => {
		expect(RETENTION_REGISTRY.length).toBeGreaterThan(50);
		expect(RETENTION_REGISTRY_SUMMARY.rowCount).toBe(RETENTION_REGISTRY.length);
		const byKind = (kind: string) =>
			RETENTION_REGISTRY.filter((r) => r.disposition.kind === kind).length;
		expect(RETENTION_REGISTRY_SUMMARY.fixInIssue).toBe(byKind('fix-in-issue'));
		expect(RETENTION_REGISTRY_SUMMARY.retainByDesign).toBe(
			byKind('retain-by-design'),
		);
		expect(RETENTION_REGISTRY_SUMMARY.notADefect).toBe(byKind('not-a-defect'));
	});

	test('row ids are unique non-empty slugs', () => {
		const ids = new Set<string>();
		for (const row of rows()) {
			expect(row.id).toBeTruthy();
			expect(ids.has(row.id)).toBe(false);
			ids.add(row.id);
		}
	});

	test('every row carries all required string fields and citation arrays', () => {
		const violations: string[] = [];
		for (const row of rows()) {
			for (const field of REQUIRED_STRING_FIELDS) {
				if (String(row[field]).trim().length === 0) {
					violations.push(`${row.id}: field "${field}" is empty`);
				}
			}
			if (row.pathGrammar.trim().length === 0)
				violations.push(`${row.id}: pathGrammar empty`);
			if (row.category < 1 || row.category > 9)
				violations.push(`${row.id}: category out of range`);
			if (row.canonicalRoot !== 'planned') {
				if (row.writerModules.length === 0)
					violations.push(`${row.id}: no writerModules`);
				if (row.writerCitations.length === 0)
					violations.push(`${row.id}: no writerCitations`);
			}
			if (row.writeLimits.bound.trim().length === 0)
				violations.push(`${row.id}: writeLimits.bound empty`);
			if (row.writeLimits.citation.trim().length === 0)
				violations.push(`${row.id}: writeLimits.citation empty`);
			if (row.readBound.pattern.trim().length === 0)
				violations.push(`${row.id}: readBound.pattern empty`);
			if (row.readBound.bound.trim().length === 0)
				violations.push(`${row.id}: readBound.bound empty`);
			if (row.readBound.citation.trim().length === 0)
				violations.push(`${row.id}: readBound.citation empty`);
		}
		expect(violations).toEqual([]);
	});

	test('planned rows (category 9) declare no writer modules', () => {
		for (const row of rows()) {
			if (row.category === 9) {
				expect(row.canonicalRoot).toBe('planned');
				expect(row.writerModules).toHaveLength(0);
			}
		}
	});
});

describe('retention registry rows — disposition rules (issue #2036)', () => {
	test('every disposition is one of the three allowed kinds', () => {
		const allowed = new Set([
			'fix-in-issue',
			'retain-by-design',
			'not-a-defect',
		]);
		for (const row of rows()) {
			expect(allowed.has(row.disposition.kind)).toBe(true);
		}
	});

	test('fix-in-issue dispositions reference the sequence window or an amendment issue', () => {
		const { first, last, amendments } = RETENTION_ISSUE_SEQUENCE;
		for (const row of rows()) {
			const d = row.disposition;
			if (d.kind !== 'fix-in-issue') continue;
			expect(d.issue).toBeGreaterThanOrEqual(first);
			expect(d.issue <= last || amendments.includes(d.issue)).toBe(true);
			expect(d.note.trim().length).toBeGreaterThan(0);
		}
	});

	test('retain-by-design and not-a-defect dispositions carry citations/proofs', () => {
		for (const row of rows()) {
			const d = row.disposition;
			if (d.kind === 'retain-by-design') {
				expect(d.citation.trim().length).toBeGreaterThan(20);
			}
			if (d.kind === 'not-a-defect') {
				expect(d.proof.trim().length).toBeGreaterThan(20);
			}
		}
	});

	test('no row carries forbidden placeholder dispositions (no owner waiver)', () => {
		for (const row of rows()) {
			const texts: string[] = [];
			const d = row.disposition as unknown as Record<string, unknown>;
			for (const value of Object.values(d)) {
				if (typeof value === 'string') texts.push(value);
			}
			texts.push(row.writeLimits.bound);
			for (const forbidden of DISPOSITION_FORBIDDEN_STRINGS) {
				for (const text of texts) {
					expect(text.toLowerCase().includes(forbidden.toLowerCase())).toBe(
						false,
					);
				}
			}
		}
	});

	test('every verified-unbounded stream (scope none) is a fix-in-issue row', () => {
		for (const row of rows()) {
			if (row.writeLimits.scope === 'none') {
				expect(row.disposition.kind).toBe('fix-in-issue');
			}
		}
	});

	/**
	 * Issue #2038 recurrence guardrail, pinned at the DATA level: a per-key cap
	 * bounds one key's history, never the store, so a per-key row that still
	 * claims to be fine must say what makes its keyspace finite.
	 *
	 * NOTE ON WHAT THIS TEST DOES AND DOES NOT PROVE: this asserts against the
	 * registry data, so it does NOT fail if the rule is deleted from
	 * check-retention-registry.ts. The fail-on-removal property lives in
	 * tests/unit/scripts/check-retention-registry.test.ts
	 * ("per-key keyspace declaration"). This test's job is to keep the populated
	 * rows populated.
	 */
	test('every per-key row that is not fix-in-issue declares its keyspace bound', () => {
		const violations: string[] = [];
		for (const row of rows()) {
			if (row.writeLimits.scope !== 'per-key') continue;
			if (row.disposition.kind === 'fix-in-issue') continue;
			const declared = (row.writeLimits.keyspaceBound ?? '').trim();
			if (declared.length === 0) {
				violations.push(`${row.id}: writeLimits.keyspaceBound missing`);
				continue;
			}
			// A per-key cap is not an answer to "what bounds the keyspace" — it is
			// the thing the field exists to qualify.
			if (!/src\/[A-Za-z0-9._/-]+\.ts/.test(declared)) {
				violations.push(`${row.id}: keyspaceBound cites no source path`);
			}
		}
		expect(violations).toEqual([]);
	});

	test('the per-key rows the guardrail reclassified are owned by an issue', () => {
		// Both were `not-a-defect` proved only by a per-key cap; the #2038 rule
		// found them. If either is ever restored to a non-fix disposition, it must
		// come with a keyspaceBound that survives the gate.
		for (const id of ['test-history', 'pr-feedback-event-queues']) {
			const row = rows().find((candidate) => candidate.id === id);
			if (!row) throw new Error(`missing ${id} row`);
			expect(row.writeLimits.scope).toBe('per-key');
			expect(row.disposition.kind).toBe('fix-in-issue');
			// The evidence must survive the reclassification, not be replaced by it.
			expect(row.writeLimits.keyspaceBound ?? '').toContain('#2038');
		}
	});
});

describe('retention registry rows — coverage plumbing', () => {
	test('background delegation citations track their live source anchors', () => {
		const row = rows().find(
			(candidate) => candidate.id === 'background-delegations-ledger',
		);
		if (!row) throw new Error('missing background-delegations-ledger row');

		const pending = sourceLines('src/background/pending-delegations.ts');
		const health = sourceLines('src/background/delegation-health.ts');
		const close = sourceLines('src/commands/close.ts');
		const appendRecord = lineOf(pending, /^function appendRecord\(/);
		const appendFile = lineOf(pending, /^\s*fs\.appendFileSync\(/);
		const firstMutation = lineOf(
			pending,
			/^export async function recordPendingDelegationDetailed\(/,
		);
		const lastMutation = lineOf(
			pending,
			/^export async function promoteDelegationFallback\(/,
		);
		const mutationCount = pending
			.slice(firstMutation - 1, lastMutation)
			.filter((line) =>
				/^export async function (?!read|list|scan|find)/.test(line),
			).length;
		const durableWriter = lineOf(pending, /^function writeDurableFileSync\(/);
		const checkpointWrite = lineOf(
			pending,
			/^\s*writeDurableFileSync\(checkpointPath/,
		);
		const tailWrite = lineOf(pending, /^\s*writeDurableFileSync\(storePath/);

		expect(mutationCount).toBe(20);
		expect(row.writerCitations).toEqual([
			`src/background/pending-delegations.ts:${appendRecord} appendRecord — appendFileSync :${appendFile} (20 mutation entry points :${firstMutation}-${lastMutation})`,
			`src/background/pending-delegations.ts:${durableWriter} writeDurableFileSync — fsync+rename-with-retry for checkpoint/manifest/rolled-tail (:${checkpointWrite}-${tailWrite})`,
		]);

		const readDelegations = lineOf(
			pending,
			/^export function readDelegations\(/,
		);
		const recoveryScan = lineOf(
			pending,
			/^export function scanDelegationsForRecovery\(/,
		);
		expect(row.readerCitations.slice(0, 2)).toEqual([
			`src/background/pending-delegations.ts:${readDelegations} readDelegations — checkpoint+tail fold (lenient), sync`,
			`src/background/pending-delegations.ts:${recoveryScan} scanDelegationsForRecovery — strict, fails closed`,
		]);

		const checkpointInterface = lineOf(
			pending,
			/^export interface BackgroundDelegationCheckpoint/,
		);
		const manifestInterface = lineOf(
			pending,
			/^export interface BackgroundDelegationManifest/,
		);
		const checkpointSchema = lineOf(pending, /^const CheckpointSchema/);
		const checkpointVersion = lineOfAfter(
			pending,
			checkpointInterface,
			/^\s*schemaVersion: 1;/,
		);
		const manifestVersion = lineOfAfter(
			pending,
			manifestInterface,
			/^\s*schemaVersion: 1;/,
		);
		expect(row.schemaVersion).toBe(
			`RecordSchema schemaVersion 1|2|3|4; checkpoint/manifest literal 1 (:${checkpointVersion},:${manifestVersion},:${checkpointSchema})`,
		);

		const lowWater = lineOf(
			pending,
			/^export const DELEGATION_COMPACTION_LOW_WATER_BYTES/,
		);
		const highWater = lineOf(
			pending,
			/^export const DELEGATION_COMPACTION_HIGH_WATER_BYTES/,
		);
		const checkpointBytes = lineOf(
			pending,
			/^export const MAX_CHECKPOINT_BYTES/,
		);
		const checkpointRecords = lineOf(
			pending,
			/^export const MAX_CHECKPOINT_RECORDS/,
		);
		const tombstoneAge = lineOf(pending, /^export const TOMBSTONE_MIN_AGE_MS/);
		const recoveryBytes = lineOf(
			health,
			/^export const MAX_RECOVERY_LEDGER_BYTES/,
		);
		expect(row.writeLimits.bound).toBe(
			`compaction high-water 1 MiB / low 256 KiB (:${lowWater}-${highWater}); MAX_RECOVERY_LEDGER_BYTES 4 MiB (delegation-health.ts:${recoveryBytes}); MAX_CHECKPOINT_BYTES 2 MiB / 2048 records (:${checkpointBytes},:${checkpointRecords}); TOMBSTONE_MIN_AGE 72 h (:${tombstoneAge})`,
		);
		expect(row.writeLimits.citation).toBe(
			`src/background/pending-delegations.ts:${lowWater}-${tombstoneAge}; src/background/delegation-health.ts:${recoveryBytes} (#2034)`,
		);

		const recoveryBoundComment = lineOf(
			pending,
			/Strict recovery bound for the ledger/,
		);
		const recoveryFallback = lineOf(
			pending,
			/^const MAX_RECOVERY_FALLBACK_BYTES/,
		);
		const legacyLoader = lineOf(pending, /^function loadLegacyLedger\(/);
		expect(row.readBound.citation).toBe(
			`src/background/pending-delegations.ts:${recoveryBoundComment}-${recoveryFallback},${legacyLoader}`,
		);

		const lockComment = lineOf(pending, /Lock \+ diagnostics identity/);
		const fallbackLock = lineOf(pending, /^const FALLBACK_LOCK_TASK/);
		expect(row.lockModel).toContain(`(:${lockComment}-${fallbackLock})`);
		const publicationStart = lineOf(
			pending,
			/Publication model \(issue #2034\)/,
		);
		const publicationEnd = lineOf(
			pending,
			/mismatch\), never on a legitimate crash window/,
		);
		expect(row.crashBehavior).toContain(
			`(:${publicationStart}-${publicationEnd})`,
		);
		expect(row.legacyCompatibility).toContain(`(:${legacyLoader})`);

		const closeStart = lineOf(close, /Background-delegation durable store/);
		const archiveStart = lineOf(close, /'background-delegations\.jsonl'/);
		const archiveEnd = lineOf(
			close,
			/'background-delegations\.manifest\.json'/,
		);
		const closeEnd = lineOf(close, /'background-delegations-health\.json'/);
		expect(row.closePolicy).toBe(
			`archived-only — ARCHIVE_ARTIFACTS (close.ts:${archiveStart}-${archiveEnd}); deliberately NOT cleaned (cross-session store; compaction is the bounded-retention mechanism, close.ts:${closeStart}-${closeEnd} docblock)`,
		);
		expect(row.disposition.kind).toBe('not-a-defect');
		if (row.disposition.kind === 'not-a-defect') {
			expect(row.disposition.proof).toContain(
				`src/background/pending-delegations.ts:${lowWater}-${tombstoneAge}; src/background/delegation-health.ts:${recoveryBytes}`,
			);
		}
	});

	test('exempt writer modules each state a reason', () => {
		for (const [modulePath, reason] of Object.entries(EXEMPT_WRITER_MODULES)) {
			expect(modulePath.startsWith('src/')).toBe(true);
			expect(reason.trim().length).toBeGreaterThan(10);
		}
	});

	test('no module is both exempt and a row writer', () => {
		const exempt = new Set(Object.keys(EXEMPT_WRITER_MODULES));
		for (const row of rows()) {
			for (const m of row.writerModules) {
				expect(exempt.has(m)).toBe(false);
			}
		}
	});

	test('exempt writer module keys use forward-slash src/ .ts paths', () => {
		for (const key of Object.keys(EXEMPT_WRITER_MODULES)) {
			expect(key.startsWith('src/')).toBe(true);
			expect(key.includes('\\')).toBe(false);
			expect(key.endsWith('.ts')).toBe(true);
		}
	});

	test('writer modules use forward-slash repo-relative paths under src/', () => {
		for (const row of rows()) {
			for (const m of row.writerModules) {
				expect(m.startsWith('src/')).toBe(true);
				expect(m.includes('\\')).toBe(false);
				expect(m.endsWith('.ts')).toBe(true);
			}
		}
	});
});
