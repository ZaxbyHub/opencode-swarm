import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	deliverPrActivity,
	_internals as deliveryInternals,
} from '../../src/background/pr-event-delivery.js';
import OpenCodeSwarm, { overrideIndexInternalsForTest } from '../../src/index';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { acquireLoopInternals } from '../helpers/loop-internals-lease';
import { acquirePrFeedbackBackgroundLease } from '../helpers/pr-feedback-background-lease';
import { acquireProcessEnvLease } from '../helpers/process-env-lease';
import { createSafeTestDir } from '../helpers/safe-test-dir.js';

function pluginContext(directory: string, client: unknown) {
	return {
		client,
		project: {} as never,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as never,
	};
}

async function boot(directory: string, client: unknown) {
	mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			version_check: false,
			quiet: true,
			pr_monitor: {
				enabled: true,
				auto_pr_feedback: true,
				event_delivery: 'prompt',
			},
			pr_feedback_loop: { enabled: false },
		}),
	);
	return (await OpenCodeSwarm.server(pluginContext(directory, client))) as {
		dispose?: () => Promise<void>;
		event?: (input: { event: unknown }) => Promise<void>;
	};
}

function wakeClient() {
	const messages: string[] = [];
	let resolveSecond!: () => void;
	const secondPrompt = new Promise<void>((resolve) => {
		resolveSecond = resolve;
	});
	const promptAsync = async (args: unknown) => {
		const text =
			(args as { body?: { parts?: Array<{ text?: string }> } }).body?.parts?.[0]
				?.text ?? '';
		messages.push(text);
		if (messages.length === 2) resolveSecond();
		return { data: {} };
	};
	return { client: { session: { promptAsync } }, messages, secondPrompt };
}

function prEvent(type: string) {
	return {
		type,
		repoFullName: 'fixture-owner/fixture-repo',
		prNumber: 2745,
		prUrl: 'https://github.com/fixture-owner/fixture-repo/pull/2745',
		message: `[pr-monitor:${type}:fixture-owner/fixture-repo#2745] ${type}`,
		dedupToken: `[pr-monitor:${type}:fixture-owner/fixture-repo#2745]`,
	};
}

describe('issue #2745 session.idle hook ownership', () => {
	let restoreIndexInternals: () => void = () => {};
	let cleanupEnvironment: () => void = () => {};
	let releaseLoopInternals: (() => void) | null = null;
	let releaseProcessEnv: (() => void) | null = null;
	let releaseBackground: (() => void) | null = null;
	const directories: Array<{ dir: string; cleanup: () => void }> = [];

	beforeEach(async () => {
		releaseProcessEnv = await acquireProcessEnvLease();
		releaseLoopInternals = await acquireLoopInternals();
		releaseBackground = await acquirePrFeedbackBackgroundLease();
		cleanupEnvironment = createIsolatedTestEnv().cleanup;
		restoreIndexInternals = overrideIndexInternalsForTest({
			schedulePostResolutionTasks: () => {},
		});
	});

	afterEach(async () => {
		try {
			restoreIndexInternals();
			restoreIndexInternals = () => {};
			cleanupEnvironment();
			cleanupEnvironment = () => {};
			for (const entry of directories.splice(0)) entry.cleanup();
		} finally {
			releaseBackground?.();
			releaseBackground = null;
			releaseLoopInternals?.();
			releaseLoopInternals = null;
			releaseProcessEnv?.();
			releaseProcessEnv = null;
		}
	});

	it('routes the literal session.idle hook to each owning root client', async () => {
		const first = createSafeTestDir('pr-idle-hook-a-');
		const second = createSafeTestDir('pr-idle-hook-b-');
		directories.push(first, second);
		const clientA = wakeClient();
		const clientB = wakeClient();
		let pluginA: Awaited<ReturnType<typeof boot>> | undefined;
		let pluginB: Awaited<ReturnType<typeof boot>> | undefined;
		const sessionID = 'pr-idle-hook-shared-session';

		try {
			pluginA = await boot(first.dir, clientA.client);
			pluginB = await boot(second.dir, clientB.client);

			// Each first event makes its session busy; its second event remains queued
			// until the corresponding plugin receives the literal idle event.
			expect(
				await deliverPrActivity(
					sessionID,
					[prEvent('pr.ci.failed')],
					first.dir,
				),
			).toBe(true);
			expect(
				await deliverPrActivity(
					sessionID,
					[prEvent('pr.new.comment')],
					second.dir,
				),
			).toBe(true);
			expect(
				await deliverPrActivity(
					sessionID,
					[prEvent('pr.merge.conflict')],
					first.dir,
				),
			).toBe(true);
			expect(
				await deliverPrActivity(
					sessionID,
					[prEvent('pr.new.review')],
					second.dir,
				),
			).toBe(true);

			await pluginA.event?.({
				event: { type: 'session.idle', properties: { sessionID } },
			});
			await pluginB.event?.({
				event: { type: 'session.idle', properties: { sessionID } },
			});
			await Promise.all([clientA.secondPrompt, clientB.secondPrompt]);

			expect(clientA.messages[0]).toContain('pr.ci.failed');
			expect(clientA.messages[1]).toContain('pr.merge.conflict');
			expect(clientB.messages[0]).toContain('pr.new.comment');
			expect(clientB.messages[1]).toContain('pr.new.review');
		} finally {
			await pluginA?.dispose?.();
			await pluginB?.dispose?.();
		}
	});
});
