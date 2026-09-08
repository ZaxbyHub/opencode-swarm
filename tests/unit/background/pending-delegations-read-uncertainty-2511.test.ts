/**
 * Issue #2511 — typed delegation-read uncertainty (advisory reader surface).
 *
 * `readDelegationsDetailed` and the *Detailed single-lookup variants preserve
 * epistemic state: `ok` (loaded or healthy-empty is a KNOWN answer) vs
 * `uncertain` (the authoritative store state could not be established — never
 * read as absence). This file pins:
 *
 * - the 3-way read matrix (healthy-empty / healthy-loaded / uncertain),
 * - the bounded retry budget (exactly two attempts on persistent
 *   uncertainty, one retry delay via the `_internals.readRetryDelayMs` seam),
 * - the bounded `delegation_read_uncertain` telemetry signal (fresh temp root
 *   per test so the per-root 60 s emit cooldown can never suppress it),
 * - the documented maintenance-wrapper contract (legacy wrappers collapse an
 *   uncertain store to [] / null — reserved for audited safe-skip callers).
 *
 * Fixture recipe (issue #2511): a raw `.swarm/background-delegations.jsonl`
 * line plus a torn `.swarm/background-delegations.manifest.json` — the
 * manifest is the compaction publication point, so an unparseable one makes
 * the fold reader uncertain without any coordination DB present. Records are
 * written raw on purpose: `recordPendingDelegation` creates the SQLite
 * coordination authority, which then masks a torn legacy manifest.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	DELEGATION_READ_RETRY_DELAY_MS,
	findByBatchId,
	findByBatchIdDetailed,
	findByCorrelationId,
	findByCorrelationIdDetailed,
	readDelegations,
	readDelegationsDetailed,
} from '../../../src/background/pending-delegations.js';
import { telemetry } from '../../../src/telemetry.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

interface FixtureRecord {
	correlationId?: string;
	parentSessionId?: string;
	status?: string;
	updatedAt?: number;
}

/** The verified open-lane record line (schema-valid under `RecordSchema`). */
function openLaneLine(overrides: FixtureRecord = {}): string {
	const correlationId = overrides.correlationId ?? 'ses_open_lane';
	return `${JSON.stringify({
		schemaVersion: 1,
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: overrides.parentSessionId ?? 'sess_controller',
		callID: `call_${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		status: overrides.status ?? 'pending',
		createdAt: 1,
		updatedAt: overrides.updatedAt ?? 2,
		promptHash: 'x'.repeat(24),
	})}\n`;
}

interface StoreFixture {
	dir: string;
	cleanup: () => void;
}

/**
 * Builds a store root with the requested ledger lines and an optional torn
 * manifest. `.git` marks the temp root as a project root for path policy.
 */
function createStore(records: string[], tornManifest: boolean): StoreFixture {
	const safe = createSafeTestDir('swarm-bg-read-uncertain-');
	fs.mkdirSync(path.join(safe.dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(safe.dir, '.swarm'), { recursive: true });
	if (records.length > 0) {
		fs.writeFileSync(
			path.join(safe.dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			records.join(''),
			'utf-8',
		);
	}
	if (tornManifest) {
		fs.writeFileSync(
			path.join(safe.dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
			'{"schemaVersion": 1, "sequence": ',
			'utf-8',
		);
	}
	return safe;
}

describe('readDelegationsDetailed — typed read uncertainty (issue #2511)', () => {
	beforeEach(() => {
		// Collapse the one bounded retry delay so tests never actually sleep.
		_internals.readRetryDelayMs = 0;
	});

	afterEach(() => {
		_internals.readRetryDelayMs = DELEGATION_READ_RETRY_DELAY_MS;
		mock.restore();
	});

	test('healthy-empty store is a KNOWN answer: ok with zero records', () => {
		const store = createStore([], false);
		try {
			const outcome = readDelegationsDetailed(store.dir);
			expect(outcome.status).toBe('ok');
			if (outcome.status !== 'ok') return;
			expect(outcome.records).toEqual([]);
			expect(outcome.source).toBe('legacy-ledger');
		} finally {
			store.cleanup();
		}
	});

	test('healthy-loaded store is ok and reports the ses_open_lane record', () => {
		const store = createStore([openLaneLine()], false);
		try {
			const outcome = readDelegationsDetailed(store.dir);
			expect(outcome.status).toBe('ok');
			if (outcome.status !== 'ok') return;
			expect(outcome.records.map((r) => r.correlationId)).toEqual([
				'ses_open_lane',
			]);
			// Legacy files only (no manifest, no checkpoint): the fold reader
			// reports the legacy-ledger source.
			expect(outcome.source).toBe('legacy-ledger');
		} finally {
			store.cleanup();
		}
	});

	test('torn manifest yields typed uncertainty: status, reason, source fold, attempts 2', () => {
		const store = createStore([openLaneLine()], true);
		try {
			const outcome = readDelegationsDetailed(store.dir);
			expect(outcome.status).toBe('uncertain');
			if (outcome.status !== 'uncertain') return;
			expect(outcome.attempts).toBe(2);
			expect(outcome.reason.length).toBeGreaterThan(0);
			expect(outcome.source).toBe('fold');
			expect(outcome.repairHint).toBeTruthy();
		} finally {
			store.cleanup();
		}
	});

	test('persistently-uncertain store never throws and reports exactly two attempts', () => {
		const store = createStore([openLaneLine()], true);
		try {
			for (let invocation = 0; invocation < 3; invocation += 1) {
				const outcome = readDelegationsDetailed(store.dir);
				expect(outcome.status).toBe('uncertain');
				if (outcome.status === 'uncertain') {
					expect(outcome.attempts).toBe(2);
				}
			}
		} finally {
			store.cleanup();
		}
	});

	test('uncertain read emits one bounded delegation_read_uncertain telemetry signal with attempt 2', () => {
		const store = createStore([openLaneLine()], true);
		const spy = spyOn(telemetry, 'delegationReadUncertain').mockImplementation(
			() => {},
		);
		try {
			const outcome = readDelegationsDetailed(store.dir);
			expect(outcome.status).toBe('uncertain');
			expect(spy).toHaveBeenCalledTimes(1);
			const event = spy.mock.calls[0]?.[0];
			expect(event?.attempt).toBe(2);
			// Bounded, content-free reason code (no raw paths or reason text).
			expect(typeof event?.reasonCode).toBe('string');
			expect(event!.reasonCode.length).toBeGreaterThan(0);
			expect(event!.reasonCode.length).toBeLessThanOrEqual(64);
			expect(event?.source).toBe('fold');
		} finally {
			store.cleanup();
		}
	});

	test('a healthy read emits no delegation_read_uncertain telemetry', () => {
		const store = createStore([openLaneLine()], false);
		const spy = spyOn(telemetry, 'delegationReadUncertain').mockImplementation(
			() => {},
		);
		try {
			expect(readDelegationsDetailed(store.dir).status).toBe('ok');
			expect(spy).not.toHaveBeenCalled();
		} finally {
			store.cleanup();
		}
	});

	test('maintenance wrappers collapse uncertainty to the documented empty/null shape while the Detailed variants type it', () => {
		const store = createStore([openLaneLine()], true);
		try {
			expect(readDelegations(store.dir)).toEqual([]);
			expect(findByCorrelationId(store.dir, 'ses_open_lane')).toBeNull();
			expect(findByBatchId(store.dir, 'batch-none')).toEqual([]);

			const detailedRecord = findByCorrelationIdDetailed(
				store.dir,
				'ses_open_lane',
			);
			expect(detailedRecord.status).toBe('uncertain');
			if (detailedRecord.status === 'uncertain') {
				expect(detailedRecord.attempts).toBe(2);
			}

			const detailedBatch = findByBatchIdDetailed(store.dir, 'batch-none');
			expect(detailedBatch.status).toBe('uncertain');
		} finally {
			store.cleanup();
		}
	});

	test('an ok lookup distinguishes a genuinely-absent correlation from a present one', () => {
		const store = createStore([openLaneLine()], false);
		try {
			expect(findByCorrelationIdDetailed(store.dir, 'ses_absent')).toEqual({
				status: 'ok',
				value: null,
			});
			const present = findByCorrelationIdDetailed(store.dir, 'ses_open_lane');
			expect(present.status).toBe('ok');
			if (present.status === 'ok') {
				expect(present.value?.correlationId).toBe('ses_open_lane');
			}
		} finally {
			store.cleanup();
		}
	});
});
