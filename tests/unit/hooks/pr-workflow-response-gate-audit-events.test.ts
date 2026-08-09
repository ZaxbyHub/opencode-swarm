import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import { _test_exports as workflowInternals } from '../../../src/hooks/pr-workflow-gate.js';
import { createPrWorkflowResponseGate } from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	idleEventFor,
	makeTempDir,
	writeStateWithRevision,
} from './pr-workflow-response-gate-test-helpers.js';

let directory = '';

beforeEach(() => {
	directory = makeTempDir('pr-response-gate-audit-events-');
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

async function readEventLines(): Promise<Array<Record<string, unknown>>> {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	const contents = await fs.readFile(eventsPath, 'utf-8');
	return contents
		.trim()
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Regression: F-006. Auto-resume suspension used to be observable only as
 * prose inside a chat banner, which no operator tooling can aggregate. The
 * fix appends a `pr_workflow_wake_suspended` record to `.swarm/events.jsonl`
 * exactly once per suspension TRANSITION, from a single append site placed
 * after BOTH the consecutive- and total-wake suspension checks — so a single
 * wake that trips both budgets simultaneously (reachable whenever
 * `maxConsecutiveUnproductiveWakes === totalWakeCeiling`) still produces one
 * line, not two contradicting ones.
 */
describe('pr_workflow_wake_suspended audit event — regression: exactly one event per suspension transition (F-006)', () => {
	test('the consecutive-unproductive suspension path appends exactly one event with suspendedReason "consecutive"', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 3,
			wakeCooldownMs: 0,
			totalWakeCeiling: { L: 999_999 },
		});

		// Revision never advances — every wake after the first (probe) wake is
		// unproductive.
		await writeStateWithRevision(directory, 'consecutive-session', 0, 'L');
		const idle = idleEventFor('consecutive-session');
		// Wake 1 is always treated as a probe (madeProgress=true), resetting the
		// counter to 0. Wakes 2-4 are unproductive: counter reaches 3 (the
		// configured max) on wake 4.
		for (let i = 0; i < 4; i++) {
			await gate.event(idle);
		}
		const budget = gate._inspectWakeBudget('consecutive-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.suspendedReason).toBe('consecutive');

		const events = await readEventLines();
		const suspendEvents = events.filter(
			(e) => e.type === 'pr_workflow_wake_suspended',
		);
		expect(suspendEvents.length).toBe(1);
		expect(suspendEvents[0]).toMatchObject({
			sessionID: 'consecutive-session',
			suspendedReason: 'consecutive',
		});
	});

	test('the total-wake suspension path appends exactly one event with suspendedReason "total"', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999_999,
			wakeCooldownMs: 0,
			totalWakeCeiling: { S: 4 },
		});

		const idle = idleEventFor('total-session');
		for (let i = 0; i < 4; i++) {
			await writeStateWithRevision(directory, 'total-session', i + 1, 'S');
			await gate.event(idle);
		}
		const budget = gate._inspectWakeBudget('total-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.suspendedReason).toBe('total');

		const events = await readEventLines();
		const suspendEvents = events.filter(
			(e) => e.type === 'pr_workflow_wake_suspended',
		);
		expect(suspendEvents.length).toBe(1);
		expect(suspendEvents[0]).toMatchObject({
			sessionID: 'total-session',
			suspendedReason: 'total',
		});
	});

	test('a single wake that trips BOTH the consecutive and total budgets writes exactly one event, matching the final suspendedReason the banner renders', async () => {
		// maxConsecutiveUnproductiveWakes === totalWakeCeiling reproduces the
		// double-trip window: with no revision progress, wake 3 both crosses
		// consecutiveUnproductive >= 2 AND totalWakes >= 3 in the same call.
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 2,
			wakeCooldownMs: 0,
			totalWakeCeiling: { L: 3 },
		});

		// Revision held constant across all wakes — no progress.
		await writeStateWithRevision(directory, 'double-trip-session', 0, 'L');
		const idle = idleEventFor('double-trip-session');
		for (let i = 0; i < 3; i++) {
			await gate.event(idle);
		}

		const budget = gate._inspectWakeBudget('double-trip-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.totalWakes).toBe(3);
		expect(budget?.consecutiveUnproductive).toBe(2);

		const events = await readEventLines();
		const suspendEvents = events.filter(
			(e) => e.type === 'pr_workflow_wake_suspended',
		);
		// Exactly one line, even though this wake tripped both budgets.
		expect(suspendEvents.length).toBe(1);
		// The recorded reason must match the FINAL budget state — the same
		// value textComplete's banner will render for this session.
		expect(suspendEvents[0]?.suspendedReason).toBe(budget?.suspendedReason);

		// Confirm the banner the user actually sees names the same reason.
		const output = { text: 'still stuck' };
		await gate.textComplete({ sessionID: 'double-trip-session' }, output);
		if (budget?.suspendedReason === 'total') {
			expect(output.text).toContain('total wake budget for this workflow');
		} else {
			expect(output.text).toContain('consecutive unproductive retries');
		}
	});

	test('a failing events.jsonl write is non-fatal — the gate still suspends and textComplete still renders the suspension banner', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999_999,
			wakeCooldownMs: 0,
			totalWakeCeiling: { S: 2 },
		});

		// Force the events.jsonl append to fail by creating a directory at that
		// exact path (fs.appendFile rejects with EISDIR). Mirrors
		// tests/unit/hooks/pr-workflow-gate-abort.test.ts's
		// "clears the gate even if the audit write would fail" case.
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		await fs.mkdir(eventsPath, { recursive: true });

		const idle = idleEventFor('write-fail-session');
		for (let i = 0; i < 2; i++) {
			await writeStateWithRevision(directory, 'write-fail-session', i + 1, 'S');
			// The idle event handler must not throw even though the audit
			// append underneath it fails.
			await gate.event(idle);
		}

		const budget = gate._inspectWakeBudget('write-fail-session');
		// The gate must still suspend despite the audit-write failure — an
		// audit-trail problem must never disable the brake it is reporting on.
		expect(budget?.suspended).toBe(true);
		expect(budget?.suspendedReason).toBe('total');

		// The suspension banner must still render normally.
		const output = { text: 'stuck after write failure' };
		await gate.textComplete({ sessionID: 'write-fail-session' }, output);
		expect(output.text).toContain('total wake budget for this workflow');
	});
});
