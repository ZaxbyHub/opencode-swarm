/**
 * #3844 final-critic R3-2 (kills mutant M10): the pr-feedback loop's
 * persisted terminal.reason carries the performer's error text — a
 * permanent-class failure interpolates it into the paused_for_human
 * reason. This tracked unit pin ports the frozen C11 F4 leg (pattern per
 * tests/unit/background/issue-2502-pr-feedback-loop-circuit.test.ts:95-133
 * and tests/helpers/issue-2502-pr-feedback-loop-fixtures.ts): a synthetic
 * token in the thrown error must be ABSENT from the durable loop-state
 * file while the benign text in the same message survives byte-identically.
 * Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	enqueuePrFeedbackMonitorEvent,
	_internals as queueInternals,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	claimAndProcessPrFeedbackEvent,
	_internals as loopInternals,
	PR_FEEDBACK_LOOP_STATE_REL,
} from '../../../src/background/pr-feedback-loop.js';
import {
	buildCorrelationId,
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TOKEN = `ghp_${'l'.repeat(24)}`;
const BENIGN = 'BENIGN-3844-TERMINAL-REASON-ROUNDTRIP-0123456789';

describe('#3844 pr-feedback loop terminal reason (final-critic R3-2 / M10)', () => {
	test('performer-failure terminal.reason redacts the token, keeps benign text', async () => {
		const SESSION = 'sess-3844-r3';
		const REPO = 'example/repo';
		const PR = 42;
		const PR_URL = 'https://github.com/example/repo/pull/42';
		const HEAD = 'h1';
		const T0 = 1_757_000_000_000;
		const savedXdg = process.env.XDG_CONFIG_HOME;
		const xdg = canonicalMkdtemp('r3-3844-xdg-');
		const dir = canonicalMkdtemp('r3-3844-loop-');
		const originals = { ...loopInternals };
		const correlation = buildCorrelationId(SESSION, REPO, PR);
		try {
			process.env.XDG_CONFIG_HOME = xdg;
			mkdirSync(path.join(dir, '.opencode'), { recursive: true });
			writeFileSync(
				path.join(dir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify(
					{
						pr_monitor: { enabled: true, auto_pr_feedback: true },
						pr_feedback_loop: { enabled: true },
					},
					null,
					2,
				),
				'utf-8',
			);
			await subscribe(dir, {
				sessionID: SESSION,
				prNumber: PR,
				repoFullName: REPO,
				prUrl: PR_URL,
			});
			await updateSnapshot(dir, correlation, { headRefOid: HEAD });
			loopInternals.now = () => T0;
			loopInternals.evaluateCurrentHead = (async () =>
				HEAD) as typeof loopInternals.evaluateCurrentHead;
			loopInternals.dispatchOversight = (async () => ({
				dispatched: true,
				decision: 'allow',
			})) as typeof loopInternals.dispatchOversight;
			loopInternals.performAuthorizedAction = (async () => {
				// Permanent-class message (no transient marker) → single
				// attempt → paused_for_human with the error text in the
				// persisted terminal.reason.
				throw new Error(`ReferenceError: ${TOKEN} is not defined at ${BENIGN}`);
			}) as typeof loopInternals.performAuthorizedAction;
			await enqueuePrFeedbackMonitorEvent(dir, SESSION, {
				type: 'pr.ci.failed',
				repoFullName: REPO,
				prNumber: PR,
				prUrl: PR_URL,
				headRefOid: HEAD,
				message: 'ci check failed',
				dedupToken: 'tok-3844-r3',
				authorized: true,
				queuedAt: '2026-11-21T00:00:00.000Z',
			} as never);
			await claimAndProcessPrFeedbackEvent(dir, SESSION);
			const stateText = readFileSync(
				path.join(dir, PR_FEEDBACK_LOOP_STATE_REL),
				'utf8',
			);
			// Token absent from the WHOLE durable file; benign text kept in
			// the terminal reason.
			expect(stateText.includes(TOKEN)).toBe(false);
			const state = JSON.parse(stateText) as {
				correlations?: Record<
					string,
					{ terminal?: { state?: string; reason?: string } | null }
				>;
			};
			const terminal = state.correlations?.[correlation]?.terminal;
			expect(terminal?.state).toBe('paused_for_human');
			expect(terminal?.reason ?? '').toContain(BENIGN);
		} finally {
			Object.assign(loopInternals, originals);
			if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = savedXdg;
			try {
				queueInternals.resetQueueCache();
			} catch {
				/* ignore */
			}
			try {
				closeAllProjectDbs();
			} catch {
				/* ignore */
			}
			for (const target of [xdg, dir]) {
				try {
					rmSync(target, { recursive: true, force: true });
				} catch {
					/* best-effort */
				}
			}
		}
	}, 120_000);
});
