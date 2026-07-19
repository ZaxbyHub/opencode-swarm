import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	clearPrWorkflowGateState,
	_test_exports as gateInternals,
	type PrWorkflowGateState,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-abort-')),
	);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(directory, { recursive: true, force: true });
});

/** Write a raw gate-state record straight to disk for shapes the public
 * mutators cannot reach (e.g. an armed prFeedbackReadyToPublish record).
 * The runtime's validateSwarmPath prepends `.swarm/`, so the absolute path
 * is `<directory>/.swarm/<relative>`. */
async function writeRawState(
	sessionID: string,
	partial: Partial<PrWorkflowGateState>,
): Promise<void> {
	const relative = gateInternals.workflowGateStateRelativePath(sessionID);
	const absolute = path.join(directory, '.swarm', relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const base: PrWorkflowGateState = {
		schemaVersion: 1,
		revision: 0,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
	};
	await fs.writeFile(
		absolute,
		JSON.stringify({ ...base, ...partial }, null, 2),
		'utf-8',
	);
}

describe('abortPrWorkflow', () => {
	test('clears an unbound active PR_REVIEW gate (the deadlock case)', async () => {
		// Mirrors /swarm pr-review: activate without binding a PR head. Before
		// the fix, no tool could clear this state because clearPrWorkflowGateState
		// was only reachable via completePrWorkflow's terminal-success path.
		await activatePrWorkflow(directory, 'deadlocked-session', 'PR_REVIEW');
		expect(
			await readPrWorkflowGateState(directory, 'deadlocked-session'),
		).not.toBeNull();

		const summary = await abortPrWorkflow(directory, 'deadlocked-session', {
			reason: 'compound git checkout rejected; could not bind PR head',
		});

		expect(summary.mode).toBe('PR_REVIEW');
		expect(summary.openLanes).toBe(0);
		expect(summary.prHeadSha).toBeUndefined();
		expect(
			await readPrWorkflowGateState(directory, 'deadlocked-session'),
		).toBeNull();
	});

	test('clears a bound active PR_REVIEW gate and returns the bound head', async () => {
		await writeRawState('bound-session', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 3,
		});
		const summary = await abortPrWorkflow(directory, 'bound-session');
		expect(summary).toEqual({
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			openLanes: 0,
		});
		expect(
			await readPrWorkflowGateState(directory, 'bound-session'),
		).toBeNull();
	});

	test('throws when no active gate exists for the session', async () => {
		await expect(abortPrWorkflow(directory, 'no-gate-session')).rejects.toThrow(
			/no active PR workflow gate/i,
		);
	});

	test('throws on mode mismatch when expectedMode is supplied', async () => {
		await activatePrWorkflow(directory, 'review-only', 'PR_REVIEW');
		await expect(
			abortPrWorkflow(directory, 'review-only', {
				expectedMode: 'PR_FEEDBACK',
			}),
		).rejects.toThrow(/active in PR_REVIEW, not PR_FEEDBACK/i);
		// The gate must still be intact after a failed abort.
		expect(
			await readPrWorkflowGateState(directory, 'review-only'),
		).not.toBeNull();
	});

	test('refuses to abort while PR_FEEDBACK is armed for publication', async () => {
		await writeRawState('armed-session', {
			mode: 'PR_FEEDBACK',
			prHeadSha: 'abc123',
			prFeedbackReadyToPublish: {
				revisionDigest: 'rev-1',
				localHead: 'def456',
				remoteName: 'origin',
				remoteBranchRef: 'refs/heads/fix/x',
				remoteRef: 'refs/remotes/origin/fix/x',
				validatedAt: '2026-07-19T00:00:00.000Z',
			} as PrWorkflowGateState['prFeedbackReadyToPublish'],
		});
		await expect(
			abortPrWorkflow(directory, 'armed-session', {
				expectedMode: 'PR_FEEDBACK',
			}),
		).rejects.toThrow(/armed for publication; abort is blocked/i);
		// Defense in depth: the armed gate survives the refusal.
		const state = await readPrWorkflowGateState(directory, 'armed-session');
		expect(state?.prFeedbackReadyToPublish).toBeDefined();
	});

	test('refuses to abort while PR workflow lanes are in flight', async () => {
		await activatePrWorkflow(directory, 'lanes-session', 'PR_REVIEW');
		await recordPendingDelegation(directory, {
			correlationId: 'c1',
			jobId: null,
			subagentSessionId: 'sub-1',
			parentSessionId: 'lanes-session',
			callID: 'call-1',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'b1',
			laneId: 'intent-architecture',
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: null,
				prHeadSha: 'abc123',
				scope: null,
			},
		});
		await expect(abortPrWorkflow(directory, 'lanes-session')).rejects.toThrow(
			/in flight.*intent-architecture/i,
		);
		// Gate survives.
		expect(
			await readPrWorkflowGateState(directory, 'lanes-session'),
		).not.toBeNull();
	});

	test('appends a non-fatal audit event to .swarm/events.jsonl', async () => {
		await activatePrWorkflow(directory, 'audited-session', 'PR_REVIEW');
		await abortPrWorkflow(directory, 'audited-session', {
			reason: 'audit-trail check',
		});
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		const contents = await fs.readFile(eventsPath, 'utf-8');
		const lines = contents.trim().split('\n');
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const event = JSON.parse(lines[lines.length - 1] as string);
		expect(event).toMatchObject({
			type: 'pr_workflow_aborted',
			sessionID: 'audited-session',
			mode: 'PR_REVIEW',
			openLanes: 0,
			reason: 'audit-trail check',
		});
	});

	test('clears the gate even if the audit write would fail', async () => {
		// Block ONLY the events.jsonl append by creating a directory at that
		// path (appendFile rejects with EISDIR). The gate state file lives at
		// a different path and stays readable, so this isolates audit-write
		// failure from gate-read/clear paths.
		await activatePrWorkflow(directory, 'resilient-session', 'PR_REVIEW');
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		await fs.mkdir(eventsPath, { recursive: true });

		const summary = await abortPrWorkflow(directory, 'resilient-session');
		expect(summary.mode).toBe('PR_REVIEW');
		// The gate MUST clear regardless of the audit write failure — otherwise
		// the deadlock persists because of an unrelated write error.
		expect(
			await readPrWorkflowGateState(directory, 'resilient-session'),
		).toBeNull();
	});

	test('sanitizes a long reason down to 500 characters', async () => {
		await activatePrWorkflow(directory, 'long-reason', 'PR_REVIEW');
		const longReason = 'x'.repeat(2000);
		await abortPrWorkflow(directory, 'long-reason', { reason: longReason });
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		const contents = await fs.readFile(eventsPath, 'utf-8');
		const event = JSON.parse(contents.trim().split('\n').pop() as string);
		expect(event.reason.length).toBe(500);
	});
});
