/**
 * r13 audit repair (P1-3): the async sounding-board completion must apply the
 * SAME caller-owned category metadata as the synchronous Task transport. The
 * validated category is persisted on the dispatch record (bound to the exact
 * call/child identity) and fed to the shared policy parser; model free text
 * can never override architect metadata, and legacy records without a
 * persisted category fall back conservatively.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { applySoundingBoardResponsePolicy } from '../../../src/agents/sounding-board-policy';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function completionEvent(
	childSessionId: string,
	body: string,
	parentSessionId = 'ses_sb_parent',
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text: `<task id="${childSessionId}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}

async function recordSoundingBoard(
	directory: string,
	options: {
		child: string;
		callId: string;
		category?: string;
		parent?: string;
	},
): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: options.child,
		jobId: `job-${options.child}`,
		subagentSessionId: options.child,
		parentSessionId: options.parent ?? 'ses_sb_parent',
		callID: options.callId,
		normalizedAgent: 'critic_sounding_board',
		swarmPrefixedAgent: 'critic_sounding_board',
		planTaskId: null,
		evidenceTaskId: null,
		...(options.category ? { soundingBoardCategory: options.category } : {}),
		workspace: captureWorkspaceSnapshot(directory),
	});
}

function soundingAdvisory(child: string, directory: string): string | undefined {
	const record = findByCorrelationId(directory, child);
	return (record?.closeoutAdvisories ?? []).find((entry) =>
		entry.message.includes('[SOUNDING_BOARD]'),
	)?.message;
}

describe('sounding-board caller-category parity (r13 P1-3)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('sb-category-'));
		mkdirSync(join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('async completion applies the persisted caller category — same verdict as the sync transport', async () => {
		const response =
			'Verdict: APPROVED\nCategory: routine_feedback\nReasoning: ordinary approach question';
		await recordSoundingBoard(directory, {
			child: 'ses_sb_a',
			callId: 'c-a',
			category: 'scope',
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent('ses_sb_a', `<task_result>${response}</task_result>`),
		);

		const message = soundingAdvisory('ses_sb_a', directory);
		expect(message).toBeDefined();
		// The CALLER category wins over the model's routine_feedback.
		expect(message).toContain('Category: scope');
		// Parity: the shared parser, fed the same caller metadata, agrees.
		const syncParsed = applySoundingBoardResponsePolicy(response, {
			category: 'scope',
		});
		expect(syncParsed?.category).toBe('scope');
		expect(message).toContain(`Verdict: ${syncParsed?.verdict}`);
	});

	test('UNNECESSARY handling follows the always-surface rules with the caller category', async () => {
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		// (a) An ALWAYS-SURFACE caller category ('scope'): the model's
		// UNNECESSARY may not silently drop a scope decision — surfaced as
		// APPROVED (the always-surface rewrite), category preserved.
		await recordSoundingBoard(directory, {
			child: 'ses_sb_b1',
			callId: 'c-b1',
			category: 'scope',
		});
		await observer.event(
			completionEvent(
				'ses_sb_b1',
				'<task_result>Verdict: UNNECESSARY\nReasoning: already covered</task_result>',
			),
		);
		const surfaced = soundingAdvisory('ses_sb_b1', directory);
		expect(surfaced).toBeDefined();
		expect(surfaced).toContain('Verdict: APPROVED');
		expect(surfaced).toContain('Category: scope');

		// (b) An ORDINARY caller category ('routine_feedback'): UNNECESSARY is
		// a legitimate sticky decision and stays UNNECESSARY.
		await recordSoundingBoard(directory, {
			child: 'ses_sb_b2',
			callId: 'c-b2',
			category: 'routine_feedback',
		});
		await observer.event(
			completionEvent(
				'ses_sb_b2',
				'<task_result>Verdict: UNNECESSARY\nReasoning: already covered</task_result>',
			),
		);
		const sticky = soundingAdvisory('ses_sb_b2', directory);
		expect(sticky).toBeDefined();
		expect(sticky).toContain('Verdict: UNNECESSARY');
		expect(sticky).toContain('Category: routine_feedback');
	});

	test('missing persisted category falls back conservatively (UNNECESSARY cannot survive without valid metadata)', async () => {
		// Legacy record: no soundingBoardCategory. A model UNNECESSARY without
		// a valid category may not stay sticky — surfaced as APPROVED with the
		// observable warning (same as the sync transport without a category).
		const response = 'Verdict: UNNECESSARY\nReasoning: drop it';
		await recordSoundingBoard(directory, {
			child: 'ses_sb_c',
			callId: 'c-c',
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent('ses_sb_c', `<task_result>${response}</task_result>`),
		);
		const message = soundingAdvisory('ses_sb_c', directory);
		expect(message).toBeDefined();
		expect(message).toContain('Verdict: APPROVED');
		expect(message).toContain('WARNING');
	});

	test('replay and restart produce the identical policy decision', async () => {
		const response =
			'Verdict: APPROVED\nCategory: routine_feedback\nReasoning: fine';
		await recordSoundingBoard(directory, {
			child: 'ses_sb_d',
			callId: 'c-d',
			category: 'security_privacy',
		});
		const first = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		const event = completionEvent(
			'ses_sb_d',
			`<task_result>${response}</task_result>`,
		);
		await first.event(event);
		const messageAfterFirst = soundingAdvisory('ses_sb_d', directory);

		// "Restart": a fresh observer replays the same completion.
		const second = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await second.event(event);
		const messageAfterReplay = soundingAdvisory('ses_sb_d', directory);
		expect(messageAfterReplay).toBe(messageAfterFirst);
		expect(messageAfterReplay).toContain('Category: security_privacy');
	});

	test('two parallel sounding-board children keep their own categories (no swap)', async () => {
		const responseA =
			'Verdict: APPROVED\nReasoning: a';
		const responseB =
			'Verdict: REPHRASE\nReasoning: b';
		await recordSoundingBoard(directory, {
			child: 'ses_sb_e1',
			callId: 'c-e1',
			category: 'scope',
			parent: 'ses_sb_parent',
		});
		await recordSoundingBoard(directory, {
			child: 'ses_sb_e2',
			callId: 'c-e2',
			category: 'routine_feedback',
			parent: 'ses_sb_parent',
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent('ses_sb_e1', `<task_result>${responseA}</task_result>`),
		);
		await observer.event(
			completionEvent('ses_sb_e2', `<task_result>${responseB}</task_result>`),
		);
		expect(soundingAdvisory('ses_sb_e1', directory)).toContain(
			'Category: scope',
		);
		expect(soundingAdvisory('ses_sb_e2', directory)).toContain(
			'Category: routine_feedback',
		);
	});
});
