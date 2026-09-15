import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { enqueuePrFeedbackMonitorEvent } from '../../src/background/pr-feedback-event-queue.js';
import {
	_internals as loopInternals,
	PR_FEEDBACK_LOOP_STATE_REL,
} from '../../src/background/pr-feedback-loop.js';
import {
	buildCorrelationId,
	subscribe,
	updateSnapshot,
} from '../../src/background/pr-subscriptions.js';
import { canonicalMkdtemp } from './tmpdir';

export const SESSION = 'sess-loop';
export const REPO = 'example/repo';
export const PR = 42;
export const PR_URL = 'https://github.com/example/repo/pull/42';
export const HEAD = 'h1';
export const CORRELATION = buildCorrelationId(SESSION, REPO, PR);
/** Fixed clock base for circuit tests (static — no Date.now arithmetic). */
export const T0 = 1_757_000_000_000;

export const ENABLED_CONFIG = {
	pr_monitor: { enabled: true, auto_pr_feedback: true },
	pr_feedback_loop: { enabled: true },
};

export interface LoopStateFile {
	correlations?: Record<
		string,
		{
			prActionsUsed?: number;
			circuit?: { failures?: number; openUntil?: number };
			terminal?: { state?: string; reason?: string } | null;
		}
	>;
}

export interface EventOverrides {
	type?: string;
	repoFullName?: string;
	prNumber?: number;
	prUrl?: string;
	message?: string;
	dedupToken?: string;
}

export function makeProject(
	createdDirs: string[],
	config: Record<string, unknown> | null = ENABLED_CONFIG,
): string {
	const dir = canonicalMkdtemp('issue-2502-loop-');
	createdDirs.push(dir);
	if (config) {
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, 2),
			'utf-8',
		);
	}
	return dir;
}

export async function primeSubscription(dir: string): Promise<void> {
	await subscribe(dir, {
		sessionID: SESSION,
		prNumber: PR,
		repoFullName: REPO,
		prUrl: PR_URL,
	});
	await updateSnapshot(dir, CORRELATION, { headRefOid: HEAD });
}

export async function enqueueEvent(
	dir: string,
	overrides: EventOverrides = {},
): Promise<void> {
	await enqueuePrFeedbackMonitorEvent(dir, SESSION, {
		type: 'pr.ci.failed',
		repoFullName: REPO,
		prNumber: PR,
		prUrl: PR_URL,
		headRefOid: HEAD,
		message: 'ci check failed',
		dedupToken: 'tok-1',
		authorized: true,
		queuedAt: '2026-09-01T00:00:00.000Z',
		...overrides,
	});
}

/** Install the happy-path seams; returns the performer mock for call counts. */
export function installLoopSeams(
	opts: { head?: string | null; performer?: () => Promise<unknown> } = {},
): ReturnType<typeof mock> {
	loopInternals.evaluateCurrentHead = mock(async () =>
		opts.head === undefined ? HEAD : opts.head,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	})) as unknown as typeof loopInternals.dispatchOversight;
	const performer = mock(opts.performer ?? (async () => ({ performed: true })));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	return performer;
}

export function readLoopStateFile(dir: string): LoopStateFile {
	return JSON.parse(
		fs.readFileSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL), 'utf-8'),
	) as LoopStateFile;
}

export { loopInternals, PR_FEEDBACK_LOOP_STATE_REL };
