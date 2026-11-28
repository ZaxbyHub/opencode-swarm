/**
 * Shared fixtures for the Layer 23 `ingestion_commit` closeout suites
 * (tests/unit/background/background-delegation-ingestion-commit-*.test.ts).
 *
 * Real store APIs against a `createSafeTestDir` repository — no
 * `mock.module`, no real clock reads (the terminal timestamp is a fixed
 * literal, so these fixtures never touch `Date.now`).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	initializeTerminalCloseout,
	markTerminalCloseoutStepCompleted,
	recordDelegationIngestionResult,
	recordPendingDelegation,
	updateCoderSettlement,
} from '../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../src/background/workspace-snapshot';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { createSafeTestDir } from './safe-test-dir';

/** Fixed terminal timestamp: fixtures must not read the real clock. */
export const FIXED_TERMINAL_RECORDED_AT = 1_700_000_000_000;

export type JournalStep =
	| 'delegation_end'
	| 'parent_advisory'
	| 'ingestion_commit';

export const FULL_JOURNAL: readonly JournalStep[] = [
	'delegation_end',
	'parent_advisory',
	'ingestion_commit',
];

export function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 20_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git exited ${result.status}`,
		);
	}
}

/** Fresh git-backed test repository; returns the directory and cleanup. */
export function setupIngestionRepo(prefix: string): {
	directory: string;
	cleanup: () => void;
} {
	resetSwarmState();
	const safe = createSafeTestDir(prefix);
	const directory = safe.dir;
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	git(directory, ['init']);
	git(directory, ['config', 'user.email', 'tests@example.com']);
	git(directory, ['config', 'user.name', 'Tests']);
	fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
	git(directory, ['add', 'base.txt']);
	git(directory, ['commit', '-m', 'test: seed repository']);
	fs.appendFileSync(
		path.join(directory, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
	);
	return {
		directory,
		cleanup: () => {
			resetSwarmState();
			safe.cleanup();
		},
	};
}

export function completedEvent(
	correlationId: string,
	parentSessionId = 'parent',
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text:
						`<task id="${correlationId}" state="completed">\n` +
						'<task_result>coder finished</task_result>\n</task>',
				},
			},
		},
	};
}

/** Byte-identical to the terminal the observer claims from completedEvent. */
export function completedTerminal(correlationId: string) {
	const text = 'coder finished';
	const digest = createHash('sha256').update(text).digest('hex');
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId,
			jobId: null,
			status: 'completed',
			resultDigest: digest,
		}),
		status: 'completed' as const,
		recordedAt: FIXED_TERMINAL_RECORDED_AT,
		result: { text, chars: text.length, truncated: false, digest },
	};
}

export async function seedCoderRecord(
	directory: string,
	correlationId: string,
	taskId: string,
	normalizedAgent: 'coder' | 'general' = 'coder',
): Promise<{ directory: string; correlationId: string; taskId: string }> {
	const session = ensureAgentSession('parent', 'architect');
	session.currentTaskId = taskId;
	session.lastCoderDelegationTaskId = taskId;
	const baseline = captureWorkspaceSnapshot(directory);
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'parent',
		callID: `call-${correlationId}`,
		normalizedAgent,
		swarmPrefixedAgent: normalizedAgent,
		planTaskId: taskId,
		evidenceTaskId: taskId,
		workspace: baseline,
		taskChangeContext: {
			declaredFiles: ['src/feature.ts'],
			baseline,
		},
	});
	if (!fs.existsSync(path.join(directory, 'src'))) {
		fs.mkdirSync(path.join(directory, 'src'));
	}
	fs.writeFileSync(
		path.join(directory, 'src', 'feature.ts'),
		'export const feature = true;\n',
	);
	return { directory, correlationId, taskId };
}

/** Claim the trusted terminal and durably settle the coder, like the observer. */
export async function claimAndSettleCoder(
	directory: string,
	correlationId: string,
): Promise<ReturnType<typeof completedTerminal>> {
	const terminal = completedTerminal(correlationId);
	const claim = await claimTerminalResult(directory, correlationId, terminal);
	if (claim?.disposition !== 'claimed') {
		throw new Error(`terminal claim failed: ${String(claim?.disposition)}`);
	}
	// claimDelegationIngestion refuses a coder record whose settlement is not
	// settled ('not_ready') — the live observer settles through settleCoder
	// before the ingestion claim, so seed the same durable settlement.
	await claimCoderSettlement(directory, correlationId, terminal.eventId);
	await updateCoderSettlement(directory, correlationId, {
		operationId: terminal.eventId,
		state: 'settled',
		observedFiles: ['src/feature.ts'],
		outcome: { kind: 'shared-root', result: 'ready' },
	});
	return terminal;
}

/** One failed ingestion claim/commit cycle (ok:false, consumed:false). */
export async function failIngestionOnce(
	directory: string,
	correlationId: string,
	claimantId: string,
): Promise<void> {
	const ingestion = await claimDelegationIngestion(directory, correlationId, {
		claimantId,
	});
	if (
		ingestion?.disposition !== 'claimed' &&
		ingestion?.disposition !== 'retry'
	) {
		throw new Error(
			`ingestion claim failed: ${String(ingestion?.disposition)}`,
		);
	}
	const claimToken = ingestion.record.ingestion?.claimToken;
	if (!claimToken) throw new Error('missing claim token');
	await recordDelegationIngestionResult(
		directory,
		correlationId,
		claimToken,
		false,
	);
}

/**
 * The exact 3.8 evening intermediate state: trusted terminal claimed,
 * settlement settled, closeout journal present, the ingestion claimed and
 * FAILED `failures` times (retryable). `journalSteps` models pre- or
 * post-Layer-23 journals. `leavePending` keeps the named journaled steps
 * pending (the failed-apply arm closes parent_advisory itself, other arms
 * return before it).
 */
export async function seedFailedIngestionState(
	directory: string,
	correlationId: string,
	journalSteps: readonly JournalStep[],
	failures = 1,
	leavePending: readonly JournalStep[] = [],
): Promise<void> {
	const terminal = await claimAndSettleCoder(directory, correlationId);
	await initializeTerminalCloseout(
		directory,
		correlationId,
		terminal.eventId,
		journalSteps,
	);
	for (const step of journalSteps) {
		if (step === 'ingestion_commit' || leavePending.includes(step)) continue;
		await markTerminalCloseoutStepCompleted(
			directory,
			correlationId,
			terminal.eventId,
			step,
		);
	}
	for (let i = 0; i < failures; i++) {
		await failIngestionOnce(directory, correlationId, terminal.eventId);
	}
}
