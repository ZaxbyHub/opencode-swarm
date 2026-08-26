/**
 * Issue #2039 — integration tests for the migrated production READERS of
 * `.swarm/events.jsonl` against the bounded core event store
 * (`src/events/core-events.ts`).
 *
 * Every reader below is imported REAL (no mock.module, no _internals fs
 * overrides): fixtures are real `.swarm/events.jsonl` stores created with
 * `appendCoreEventSync` (the canonical seam) or — for the legacy path — raw
 * JSONL written directly with node:fs.
 *
 * Covered readers:
 *  - src/services/context-budget-service.ts (estimatedTurnCount via the
 *    manifest lifetime counter; legacy header-less bounded count)
 *  - src/hooks/curator.ts filterPhaseEvents over readCoreEvents text
 *  - src/services/diagnose-service.ts Check D (event stream integrity) +
 *    Check E (steering staleness) through getDiagnoseData
 *  - src/hooks/steering-consumed.ts createSteeringConsumedHook reconciliation
 *  - src/services/session-reflection.ts gatherLedgerRejections (via the
 *    module's exported _internals seam — read-only use, no overrides)
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { withFrozenClock } from '../../helpers/test-clock.js';

/** Deterministic fixture timestamp (test-clock lint, issue #1782). */
const FIXED_TS = withFrozenClock(() => new Date().toISOString());

import * as fs from 'node:fs';
import * as path from 'node:path';
import { join } from 'node:path';
import {
	_resetMaintenanceCounters,
	appendCoreEventSync,
	getCoreEventLifetimeCount,
	readCoreEvents,
} from '../../../src/events/core-events.js';
import { filterPhaseEvents } from '../../../src/hooks/curator.js';
import {
	createSteeringConsumedHook,
	recordSteeringConsumed,
} from '../../../src/hooks/steering-consumed.js';
import {
	DEFAULT_CONTEXT_BUDGET_CONFIG,
	getContextBudgetReport,
} from '../../../src/services/context-budget-service.js';
import { getDiagnoseData } from '../../../src/services/diagnose-service.js';
import { _internals as reflectionInternals } from '../../../src/services/session-reflection.js';
import { canonicalMkdtemp, canonicalTmpDir } from '../../helpers/tmpdir.js';

// ---------------------------------------------------------------------------
// Bounded temp-dir lifecycle (FR-011 canonical helper + contained cleanup)
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function makeProjectDir(): string {
	const dir = canonicalMkdtemp('ce-readers-');
	createdDirs.push(dir);
	return dir;
}

afterEach(() => {
	// Reset the store's module-scoped append counter so throttled maintenance
	// timing cannot leak between tests in this file.
	_resetMaintenanceCounters();
	for (const dir of createdDirs.splice(0)) {
		const resolved = fs.realpathSync(dir);
		const root = fs.realpathSync(canonicalTmpDir());
		if (resolved === root || !resolved.startsWith(root + path.sep)) {
			continue;
		}
		try {
			fs.rmSync(resolved, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; OS temp reaper handles the rest
		}
	}
});

function eventsFile(dir: string): string {
	return join(dir, '.swarm', 'events.jsonl');
}

/** Parse every non-empty line of a readCoreEvents window text. */
function parseWindowLines(dir: string): Record<string, unknown>[] {
	const window = readCoreEvents(dir);
	return window.text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Write a LEGACY (header-less) events.jsonl directly via node:fs. */
function writeLegacyEventsFile(
	dir: string,
	events: Record<string, unknown>[],
): void {
	fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		eventsFile(dir),
		events.map((event) => JSON.stringify(event)).join('\n') + '\n',
		'utf-8',
	);
}

function findCheck(
	diagnose: { checks: { name: string; status: string; detail: string }[] },
	name: string,
) {
	const check = diagnose.checks.find((entry) => entry.name === name);
	expect(check).toBeDefined();
	return check!;
}

// ---------------------------------------------------------------------------
// context-budget-service — the manifest counter replaces line counting
// ---------------------------------------------------------------------------

describe('context-budget-service estimatedTurnCount via the core event store', () => {
	test('report turn count equals N appends through the seam (manifest excluded)', async () => {
		const dir = makeProjectDir();
		const N = 7;
		for (let i = 0; i < N; i += 1) {
			appendCoreEventSync(dir, {
				type: 'task_update',
				timestamp: FIXED_TS,
				index: i,
			});
		}
		// Raw file = manifest line + N event lines. The old reader would have
		// counted N + 1 (line counting); the manifest counter must report N.
		const rawLines = fs
			.readFileSync(eventsFile(dir), 'utf-8')
			.split('\n')
			.filter((line) => line.trim() !== '');
		expect(rawLines.length).toBe(N + 1);

		const report = await getContextBudgetReport(
			dir,
			'system prompt',
			DEFAULT_CONTEXT_BUDGET_CONFIG,
		);
		expect(report.estimatedTurnCount).toBe(N);
		expect(getCoreEventLifetimeCount(dir)).toBe(N);
	});

	test('legacy header-less file falls back to the bounded window count', async () => {
		const dir = makeProjectDir();
		writeLegacyEventsFile(dir, [
			{ type: 'task_update', timestamp: '2026-08-25T10:00:00.000Z' },
			{ type: 'task_update', timestamp: '2026-08-25T10:01:00.000Z' },
			{ type: 'task_update', timestamp: '2026-08-25T10:02:00.000Z' },
			{ type: 'task_update', timestamp: '2026-08-25T10:03:00.000Z' },
		]);
		expect(getCoreEventLifetimeCount(dir)).toBe(4);
		const report = await getContextBudgetReport(
			dir,
			'system prompt',
			DEFAULT_CONTEXT_BUDGET_CONFIG,
		);
		expect(report.estimatedTurnCount).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// curator filterPhaseEvents over readCoreEvents text
// ---------------------------------------------------------------------------

describe('curator filterPhaseEvents over the bounded core event window', () => {
	test('phase events written through the seam are found; the manifest line is never an event', () => {
		const dir = makeProjectDir();
		appendCoreEventSync(dir, {
			type: 'phase_started',
			phase: 1,
			timestamp: '2026-08-25T10:00:00.000Z',
		});
		appendCoreEventSync(dir, {
			type: 'agent.delegation',
			phase: 2,
			agent: 'coder',
			timestamp: '2026-08-25T11:00:00.000Z',
		});
		appendCoreEventSync(dir, {
			type: 'agent.delegation',
			phase: 2,
			agent: 'reviewer',
			timestamp: '2026-08-25T11:30:00.000Z',
		});
		appendCoreEventSync(dir, {
			type: 'phase_completed',
			phase: 3,
			timestamp: '2026-08-25T12:00:00.000Z',
		});

		const window = readCoreEvents(dir);
		// The manifest header must be stripped from the reader-facing text.
		expect(window.text).not.toContain('swarm-events-manifest');
		expect(window.coverage).toBe('complete');

		const phase2 = filterPhaseEvents(window.text, 2);
		expect(phase2.length).toBe(2);
		for (const event of phase2) {
			expect((event as Record<string, unknown>).phase).toBe(2);
		}

		// Defensive half of the contract: even when filtering is bypassed
		// (timestamp mode returns every event), the manifest is never among
		// the returned events.
		const all = filterPhaseEvents(window.text, 0, '1970-01-01T00:00:00.000Z');
		expect(all.length).toBe(4);
		for (const event of all) {
			expect((event as Record<string, unknown>).type).not.toBe(
				'swarm-events-manifest',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// diagnose-service — Check D (event stream integrity) + Check E (steering)
// ---------------------------------------------------------------------------

describe('diagnose-service Check D + Check E through getDiagnoseData', () => {
	test('empty store reports ✅ for both checks', async () => {
		const dir = makeProjectDir();
		const diagnose = await getDiagnoseData(dir);
		const stream = findCheck(diagnose, 'Event Stream');
		expect(stream.status).toBe('✅');
		expect(stream.detail).toBe('No events.jsonl present');
		const steering = findCheck(diagnose, 'Steering Directives');
		expect(steering.status).toBe('✅');
		expect(steering.detail).toBe(
			'No events.jsonl — no steering directives to check',
		);
	});

	test('healthy store: 0 malformed, manifest line excluded from the event count', async () => {
		const dir = makeProjectDir();
		for (let i = 0; i < 3; i += 1) {
			appendCoreEventSync(dir, {
				type: 'task_update',
				timestamp: FIXED_TS,
				index: i,
			});
		}
		const diagnose = await getDiagnoseData(dir);
		const stream = findCheck(diagnose, 'Event Stream');
		expect(stream.status).toBe('✅');
		// 3 event lines — NOT 4 (the manifest header is not an event).
		expect(stream.detail).toBe('events.jsonl is valid — 3 event(s)');
	});

	test('corrupt window line is counted as malformed', async () => {
		const dir = makeProjectDir();
		appendCoreEventSync(dir, {
			type: 'task_update',
			timestamp: FIXED_TS,
		});
		appendCoreEventSync(dir, {
			type: 'task_update',
			timestamp: FIXED_TS,
		});
		// Crash-torn JSON appended raw at the tail (manifest line 1 untouched).
		fs.appendFileSync(eventsFile(dir), '{"torn": "tru', 'utf-8');

		const diagnose = await getDiagnoseData(dir);
		const stream = findCheck(diagnose, 'Event Stream');
		expect(stream.status).toBe('❌');
		expect(stream.detail).toBe(
			'events.jsonl has 1 malformed line(s) — possible data corruption',
		);
	});

	test('unconsumed steering directive inside the window fails Check E; consumed passes', async () => {
		const dir = makeProjectDir();
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'sd-1',
			timestamp: '2026-08-25T10:00:00.000Z',
		});

		const before = await getDiagnoseData(dir);
		const failing = findCheck(before, 'Steering Directives');
		expect(failing.status).toBe('❌');
		expect(failing.detail).toBe('1 steering directive(s) not yet acknowledged');

		appendCoreEventSync(dir, {
			type: 'steering-consumed',
			directiveId: 'sd-1',
			timestamp: '2026-08-25T10:05:00.000Z',
		});
		const after = await getDiagnoseData(dir);
		const passing = findCheck(after, 'Steering Directives');
		expect(passing.status).toBe('✅');
		expect(passing.detail).toBe(
			'All steering directives acknowledged (or none issued)',
		);
	});
});

// ---------------------------------------------------------------------------
// steering-consumed hook — reconciliation over the bounded window
// ---------------------------------------------------------------------------

describe('createSteeringConsumedHook reconciliation', () => {
	test('adds consumed records only for unconsumed directive ids', async () => {
		const dir = makeProjectDir();
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'd-1',
			timestamp: '2026-08-25T10:00:00.000Z',
		});
		recordSteeringConsumed(dir, 'd-1');
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'd-2',
			timestamp: '2026-08-25T10:01:00.000Z',
		});

		const hook = createSteeringConsumedHook(dir);
		await hook(undefined, undefined);

		const consumed = parseWindowLines(dir).filter(
			(event) => event.type === 'steering-consumed',
		);
		const byId = new Map<string, number>();
		for (const event of consumed) {
			const id = event.directiveId as string;
			byId.set(id, (byId.get(id) ?? 0) + 1);
		}
		// d-2 got exactly one new consumed record...
		expect(byId.get('d-2')).toBe(1);
		// ...and the already-consumed d-1 was NOT duplicated.
		expect(byId.get('d-1')).toBe(1);
		expect(consumed.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// session-reflection gatherLedgerRejections (read via the _internals seam)
// ---------------------------------------------------------------------------

describe('session-reflection gatherLedgerRejections (via _internals)', () => {
	test('counts rejection-class events in the live bounded window, honoring session scoping', async () => {
		const dir = makeProjectDir();
		appendCoreEventSync(dir, {
			type: 'coder_retry_circuit_breaker',
			taskId: '1.1',
			retryEpoch: 1,
			action: 'simplification',
			timestamp: '2026-08-25T10:00:00.000Z',
		});
		// Sessionless rejection events stay counted (documented contract).
		appendCoreEventSync(dir, {
			type: 'architect_loop_detected',
			timestamp: '2026-08-25T10:01:00.000Z',
		});
		// Foreign-session rejection — excluded in scoped mode.
		appendCoreEventSync(dir, {
			type: 'coder_retry_circuit_breaker',
			taskId: '2.1',
			retryEpoch: 0,
			action: 'user_escalation',
			sessionId: 'sess-other',
			timestamp: '2026-08-25T10:02:00.000Z',
		});
		// Non-rejection class — never counted.
		appendCoreEventSync(dir, {
			type: 'task_update',
			sessionId: 'sess-A',
			timestamp: '2026-08-25T10:03:00.000Z',
		});

		const unscoped = await reflectionInternals.gatherLedgerRejections(dir);
		expect(unscoped['coder_retry_circuit_breaker']).toBe(2);
		expect(unscoped['architect_loop_detected']).toBe(1);

		const scoped = await reflectionInternals.gatherLedgerRejections(
			dir,
			'sess-A',
		);
		expect(scoped['coder_retry_circuit_breaker']).toBe(1);
		expect(scoped['architect_loop_detected']).toBe(1);
		expect(scoped['task_update']).toBeUndefined();
	});
});
