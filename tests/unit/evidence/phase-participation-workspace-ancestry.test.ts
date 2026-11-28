/**
 * Docs phase-participation workspace freshness — closing-window ancestry
 * allowance (the 2026-11-23 swarm_communication_debug wedge).
 *
 * A docs receipt records the workspace at dispatch time. The strict
 * freshness check pinned the exact gitHead, so the delivery commits of the
 * receipt's OWN closing window (the docs agent's committed deliverable, or a
 * sibling task's landing between the docs dispatch and phase_complete) staled
 * the receipt and phase_complete lost the docs proof it had legitimately
 * earned. The allowance: a receipt stays fresh while its recorded head is an
 * ANCESTOR of the current head — the workspace only moved forward. Divergent
 * or rewound history and unverifiable cases stay stale (fail closed).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let directory: string;

function git(...args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		stdio: 'ignore',
		timeout: 5_000,
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed`);
	}
}

function gitHead(): string {
	const result = spawnSync('git', ['rev-parse', 'HEAD'], {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 5_000,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error('git rev-parse HEAD failed');
	return String(result.stdout).trim();
}

function commitFile(name: string, content: string, message: string): void {
	const target = path.join(directory, name);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	git('add', '--', name);
	git('commit', '--allow-empty', '-m', message);
}

function writePlan(): Plan {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Docs Ancestry Plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Docs',
				status: 'in_progress',
				required_agents: ['docs'],
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Update docs',
						depends: [],
						files_touched: ['docs/guide.md'],
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	return plan;
}

async function writeReceiptAtCurrentHead(): Promise<void> {
	await reserveApprovedPhaseParticipation({
		directory,
		tool: 'Task',
		parentSessionId: 'parent',
		callId: 'docs-call',
		args: { subagent_type: 'docs' },
		policy: { require_docs: true },
	});
	await observePhaseParticipationToolResult({
		directory,
		tool: 'Task',
		parentSessionId: 'parent',
		callId: 'docs-call',
		output: {
			output: 'Documentation was checked and updated.',
			metadata: { status: 'completed', sessionId: 'docs-child' },
		},
	});
}

let restoreClock: Restore;

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: Date.now() });
	directory = canonicalMkdtemp('docs-ancestry-');
	git('init', '-b', 'main');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	commitFile('README.md', 'base\n', 'base');
	resetPhaseParticipationForTests();
});

afterEach(() => {
	restoreClock();
	resetPhaseParticipationForTests();
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

describe('docs participation workspace ancestry freshness', () => {
	test('delivery commits of the closing window keep the receipt fresh (forward-only history)', async () => {
		const plan = writePlan();
		await writeReceiptAtCurrentHead();
		const receiptHead = gitHead();

		// The docs agent's own deliverable lands, then a sibling task's —
		// both advance HEAD monotonically past the receipt's recorded head.
		commitFile('docs/guide.md', 'delivered\n', 'docs(task 2.19): delivery');
		commitFile('AGENTS.md', 'rule\n', 'docs(task 2.21): sibling delivery');
		expect(gitHead()).not.toBe(receiptHead);

		expect(await readPhaseParticipation(directory, plan, 1, 'docs')).toEqual({
			status: 'valid',
			found: true,
		});
	});

	test('equal heads stay fresh without any subprocess call (strict path)', async () => {
		const plan = writePlan();
		await writeReceiptAtCurrentHead();

		expect(await readPhaseParticipation(directory, plan, 1, 'docs')).toEqual({
			status: 'valid',
			found: true,
		});
	});

	test('a divergent history (orphan head) stales the receipt', async () => {
		const plan = writePlan();
		await writeReceiptAtCurrentHead();
		const receiptHead = gitHead();

		// An orphan branch has no ancestry relation to the receipt head: the
		// workspace did not merely move forward.
		git('checkout', '--orphan', 'divergent');
		git('add', '-A');
		git('commit', '--allow-empty', '-m', 'orphan divergence');
		expect(gitHead()).not.toBe(receiptHead);

		expect(await readPhaseParticipation(directory, plan, 1, 'docs')).toEqual({
			status: 'valid',
			found: false,
		});
	});

	test('an unverifiable workspace (repository removed) fails closed', async () => {
		const plan = writePlan();
		await writeReceiptAtCurrentHead();
		const receiptHead = gitHead();
		expect(receiptHead).toBeTruthy();

		fs.rmSync(path.join(directory, '.git'), {
			recursive: true,
			force: true,
		});

		expect(await readPhaseParticipation(directory, plan, 1, 'docs')).toEqual({
			status: 'valid',
			found: false,
		});
	});

	test('the trusted background completion writes the receipt under the same allowance', async () => {
		const plan = writePlan();
		// Durable pending bound at dispatch time (workspace = receipt head).
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'docs-call',
			args: { subagent_type: 'docs', prompt: 'TASK: 1.1\nUpdate docs' },
			policy: { require_docs: true },
		});
		// Promote the reservation to a durable pending via the running envelope.
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'docs-call',
			output: {
				output:
					'<task id="docs-child" state="running"><summary>running</summary></task>',
				metadata: { background: true, status: 'running' },
			},
		});
		await recordPendingDelegation(directory, {
			correlationId: 'docs-child',
			jobId: null,
			subagentSessionId: 'docs-child',
			parentSessionId: 'parent',
			callID: 'docs-call',
			normalizedAgent: 'docs',
			swarmPrefixedAgent: 'docs',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: 0,
			status: 'pending',
			createdAt: Date.now() - 60_000,
			updatedAt: Date.now() - 60_000,
			workspace: captureWorkspaceSnapshot(directory),
		});
		const stored = findByCorrelationId(directory, 'docs-child');
		expect(stored).not.toBeNull();

		// The docs deliverable is committed after the dispatch — before the
		// trusted completion settles the receipt.
		commitFile('docs/guide.md', 'delivered\n', 'docs(task 2.19): delivery');

		// The exact record state the trusted observer hands to the
		// participation completion (ingestion already durably consumed).
		const { completeBackgroundPhaseParticipation } = await import(
			'../../../src/evidence/phase-participation'
		);
		const recorded = await completeBackgroundPhaseParticipation({
			directory,
			record: {
				...stored!,
				ingestion: {
					state: 'consumed',
					attempt: 1,
					claimToken: 'consumed-claim',
					claimedAt: Date.now(),
					updatedAt: Date.now(),
				},
			},
			resultText: 'Documentation updated.',
		});
		expect(recorded).toBe(true);

		expect(await readPhaseParticipation(directory, plan, 1, 'docs')).toEqual({
			status: 'valid',
			found: true,
		});
	});
});
