/**
 * Issue #2108 — state-transition matrix + fail-closed state handling:
 * every reachable nonterminal state keeps a diagnostic and a safe
 * transition (or a no-publish terminal); corrupt/truncated publication
 * records stay non-publishable; and concurrent admission serializes on the
 * session state lock.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	abortPrWorkflow,
	enforcePrWorkflowToolBefore,
	invalidatePrFeedbackPublication,
	readPrWorkflowGateState,
	readPrWorkflowGateStateForRecovery,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	POST_COMMIT_SHA,
	type PublicationFixture,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'pub-transitions';
let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

async function readActive(sessionId = SESSION_ID) {
	return fixture.readActive(sessionId);
}

async function pushCommand(sessionId = SESSION_ID, callId?: string) {
	return enforcePrWorkflowToolBefore(
		fixture.directory,
		sessionId,
		'shell',
		{ command: `git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head` },
		[],
		callId,
	);
}

describe('state × operation matrix (every nonterminal state is safe)', () => {
	test('armed: mutation blocked with a diagnostic naming the two audited exits', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'write', {
				file_path: 'src/x.ts',
				content: 'x',
			}),
		).rejects.toThrow(
			/only read-only inspection, the exact approved push, and complete_pr_workflow are allowed/,
		);
	});

	test('armed: the invalidation controller tool is reachable', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await expect(
			enforcePrWorkflowToolBefore(
				fixture.directory,
				SESSION_ID,
				'invalidate_pr_feedback_publication',
				{ reason: 'approved fix must change' },
			),
		).resolves.toBeUndefined();
		const { active } = await readActive();
		// The gate admits the tool; the transition itself is the tool's
		// execute step (asserted in the invalidation suite). The window is
		// still armed here — admission alone must not mutate state.
		expect(active?.state).toBe('armed');
	});

	test('push_in_flight: a second admission reconciles the first before starting', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		_test_exports.resolveExactRemoteBranchHead = () => '0'.repeat(40);
		_test_exports.resolveExactRemoteBranchHeadAsync = async () =>
			'0'.repeat(40);
		await pushCommand(SESSION_ID, 'call-a');
		const first = await readActive();
		expect(first.active?.state).toBe('push_in_flight');
		// Second admission: the assert reaps the foreign in-flight attempt as
		// uncertain, then a new attempt starts for the same generation.
		await pushCommand(SESSION_ID, 'call-b');
		const second = await readActive();
		expect(second.active?.state).toBe('push_in_flight');
		const attempts = second.state?.prFeedbackPublication?.attempts ?? [];
		expect(attempts.length).toBe(2);
		expect(attempts[0]?.result?.outcome).toBe('uncertain');
		expect(attempts[1]?.result).toBeUndefined();
	});

	test('invalidated: exactly one push_in_flight attempt exists at a time', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		_test_exports.resolveExactRemoteBranchHead = () => '0'.repeat(40);
		_test_exports.resolveExactRemoteBranchHeadAsync = async () =>
			'0'.repeat(40);
		await pushCommand(SESSION_ID, 'call-c');
		await pushCommand(SESSION_ID, 'call-d');
		const { state } = await readActive();
		const attempts = state?.prFeedbackPublication?.attempts ?? [];
		// Both attempts belong to the same generation, but only the latest is
		// result-less (one in-flight).
		expect(attempts.filter((a) => !a.result).length).toBe(1);
	});
});

describe('shadow-projection corruption does not weaken publication authority', () => {
	test('a truncated publication shadow record does not bypass the authoritative armed generation', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		const absolute = fixture.fixtureStatePath(SESSION_ID);
		const raw = JSON.parse(await fs.readFile(absolute, 'utf-8')) as Record<
			string,
			unknown
		>;
		// Corrupt the publication record into an unreadable shape.
		raw.prFeedbackPublication = { schemaVersion: 1, active: null };
		await fs.writeFile(absolute, JSON.stringify(raw, null, 2), 'utf-8');
		_test_exports.resetTrackedStateCache();
		await expect(pushCommand()).resolves.toBeUndefined();
		const { active } = await readActive();
		expect(active?.state).toBe('armed');
	});

	test('publicationShapeUnreadable salvage treats a malformed record as armed', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		const absolute = fixture.fixtureStatePath(SESSION_ID);
		const raw = JSON.parse(await fs.readFile(absolute, 'utf-8')) as Record<
			string,
			unknown
		>;
		raw.prFeedbackPublication = 'not-an-object';
		await fs.writeFile(absolute, JSON.stringify(raw, null, 2), 'utf-8');
		_test_exports.resetTrackedStateCache();
		const recovery = await readPrWorkflowGateStateForRecovery(
			fixture.directory,
			SESSION_ID,
		);
		expect(recovery?.salvaged ?? recovery?.armedShapeUnreadable).toBeTruthy();
		expect(recovery?.armedShapeUnreadable).toBe(true);
	});
});

describe('concurrency: two admissions serialize on the session lock', () => {
	test('parallel admissions never produce two in-flight attempts', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		_test_exports.resolveExactRemoteBranchHead = () => '0'.repeat(40);
		_test_exports.resolveExactRemoteBranchHeadAsync = async () =>
			'0'.repeat(40);
		// Deterministic safe outcome under interleaving (review M5): the two
		// toolBefore calls interleave between assert and the locked admit, so
		// exactly ONE admission lands (in flight) and the other is refused by
		// admit's own armed-state guard with a retryable BLOCKED — never two
		// in-flight attempts, never a silent pass-through.
		const results = await Promise.all([
			pushCommand(SESSION_ID, 'race-1').then(
				() => 'admitted',
				(error) => `rejected: ${String(error.message)}`,
			),
			pushCommand(SESSION_ID, 'race-2').then(
				() => 'admitted',
				(error) => `rejected: ${String(error.message)}`,
			),
		]);
		const admitted = results.filter((r) => r === 'admitted');
		const rejected = results.filter((r) =>
			r.startsWith(
				'rejected: BLOCKED: PR_FEEDBACK push admission requires the armed state',
			),
		);
		expect(admitted.length).toBe(1);
		expect(rejected.length).toBe(1);
		const { state } = await readActive();
		const attempts = state?.prFeedbackPublication?.attempts ?? [];
		expect(attempts.length).toBe(1);
		expect(attempts[0]?.result).toBeUndefined();
		expect(['race-1', 'race-2']).toContain(attempts[0]?.callID);
	});
});

describe('audit trail', () => {
	test('every transition appends its bounded core event', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await invalidatePrFeedbackPublication(
			fixture.directory,
			SESSION_ID,
			'matrix',
		);
		const eventsPath = path.join(fixture.directory, '.swarm', 'events.jsonl');
		const events = await fs.readFile(eventsPath, 'utf-8');
		expect(events).toContain('pr_feedback_publication_armed');
		expect(events).toContain('pr_feedback_publication_invalidated');
	});
});

describe('deleted gate shadow cannot clear the authorization requirement (issue #2108 safety boundary)', () => {
	test('a hand-deleted gate shadow file leaves publication commands governed by the authoritative armed state', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		// Delete the shadow file by hand. SQLite remains authoritative, so this
		// must not clear the publication guard.
		await fs.rm(fixture.fixtureStatePath(SESSION_ID), { force: true });
		_test_exports.resetTrackedStateCache();
		await expect(pushCommand()).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: 'git push --force origin x:y',
			}),
		).rejects.toThrow(/only the exact approved push is allowed/);
		// Non-publication commands are NOT blocked (the guard never bricks
		// the session on absent evidence).
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'read', {}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: 'git status',
			}),
		).resolves.toBeUndefined();
		// The audited cancel remains reachable and records the terminal no-publish event.
		const summary = await abortPrWorkflow(fixture.directory, SESSION_ID, {
			kind: 'cancel-publication',
			reason: 'shadow file was deleted by hand',
			cancelPublication: true,
		});
		expect(summary.mode).toBe('PR_FEEDBACK');
		// After the terminal lands, publication commands are no longer held.
		await expect(pushCommand()).resolves.toBeUndefined();
	});

	test('the guard is silent when the trail shows a terminal or is empty', async () => {
		// No gate, no events -> no dangling generation, no block.
		await expect(pushCommand()).resolves.toBeUndefined();
		// A terminal-only trail (published) does not block either.
		const eventsPath = path.join(fixture.directory, '.swarm', 'events.jsonl');
		await fs.mkdir(path.join(fixture.directory, '.swarm'), {
			recursive: true,
		});
		await fs.writeFile(
			eventsPath,
			`${JSON.stringify({
				type: 'pr_feedback_publication_armed',
				sessionID: SESSION_ID,
				generation: 1,
			})}\n${JSON.stringify({
				type: 'pr_feedback_published',
				sessionID: SESSION_ID,
				generation: 1,
			})}\n`,
			'utf-8',
		);
		await expect(pushCommand()).resolves.toBeUndefined();
	});
});

describe('armed guard scope (re-review findings)', () => {
	test('flag-prefixed and env-prefixed push forms are still held after shadow deletion', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await fs.rm(fixture.fixtureStatePath(SESSION_ID), { force: true });
		_test_exports.resetTrackedStateCache();
		for (const command of [
			`git -c core.hooksPath=/tmp/evil push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`git -C . push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`GIT_SSH_COMMAND=evil git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`env GIT_SSH_COMMAND=evil git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`env -i git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`nohup git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`git send-pack origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`gh api -X PATCH repos/o/r/git/refs/heads/pr-head -f sha=${POST_COMMIT_SHA}`,
			`timeout 30 git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`git status && git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			'git push --force origin x:y',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
					command,
				}),
			).rejects.toThrow(
				/only the exact approved push is allowed|must be standalone shell commands/,
			);
		}
		// Non-push git commands still pass; and per the documented
		// conservative over-match, a command merely MENTIONING both git and
		// push (e.g. a commit message) is ALSO held during a dangling window —
		// the over-block is operator-resolvable via the audited cancel arm.
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: 'git status',
			}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: 'ls -la',
			}),
		).resolves.toBeUndefined();
		// gh api NOT touching refs/heads is not publication-shaped.
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: 'gh api repos/o/r --jq .full_name',
			}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: 'git commit -m "push the button"',
			}),
		).rejects.toThrow(
			/only the exact approved push is allowed|must be standalone shell commands|approved commit is immutable/,
		);
	});

	test('a successful legacy migration (migrated outcome=armed) also dangles after deletion', async () => {
		// Simulate the post-migration trail: migrated-as-armed with no
		// separate armed event, then the gate file deleted by hand.
		const eventsPath = path.join(fixture.directory, '.swarm', 'events.jsonl');
		await fs.mkdir(path.join(fixture.directory, '.swarm'), {
			recursive: true,
		});
		await fs.writeFile(
			eventsPath,
			`${JSON.stringify({
				type: 'pr_feedback_publication_migrated',
				sessionID: SESSION_ID,
				generation: 1,
				outcome: 'armed',
				reason: 'legacy-record-proven-equivalent',
			})}
`,
			'utf-8',
		);
		await expect(pushCommand()).rejects.toThrow(
			'live in the audit trail but its gate state is missing',
		);
		// A migrated-as-invalidated outcome is terminal for the window.
		await fs.writeFile(
			eventsPath,
			`${JSON.stringify({
				type: 'pr_feedback_publication_migrated',
				sessionID: SESSION_ID,
				generation: 1,
				outcome: 'invalidated',
				reason: 'legacy-migration-receipt-mismatch',
			})}
`,
			'utf-8',
		);
		await expect(pushCommand()).resolves.toBeUndefined();
	});
});
