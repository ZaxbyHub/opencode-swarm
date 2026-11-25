/**
 * 2026-11-25 swarm_communication_debug (restart-era agent-gate wedge, layer A):
 * the observer's ingestion input preferred the STORE's persisted result over
 * THIS event's result (`ingestion.record.result ?? result`). The store's
 * result projection can be BODY-LESS (the checkpoint fold strips the
 * text/error bodies from closed summaries; a trustedTerminal replay or a
 * duplicate claim surfaces the body-less shape even for a live record —
 * observed live: SQLite row with result={chars,digest,truncated} and NO text
 * one second after a text-bearing terminal claim). That shadowing silenced
 * every Stage-B verdict: structuredStageBVerdict matched nothing on '' and
 * the ingestion rotated stage_b_failed + rejected. The event result — parsed
 * from the host-rendered subagent envelope on THIS invocation — is the
 * authority whenever the persisted result has no body at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import { readTaskEvidence } from '../../../src/gate-evidence';
import { _internals as receiptCollectorInternals } from '../../../src/hooks/review-receipt-collector';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const VERDICT_TEXT =
	'[REVIEWED] | 1.1 | APPROVED | body-less store result must not shadow the event text\n' +
	'VERDICT: APPROVED\n' +
	'RISK: LOW\n' +
	'ISSUES: none\n' +
	'FIXES: none';

function digest(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bgobs-bodyless-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function syntheticPartEvent(text: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					text,
					synthetic: true,
					sessionID: 'parent_session',
				},
			},
		},
	};
}

describe('background completion observer body-less store result fallback', () => {
	let dir: string;
	const realResolveReviewerTaskScope =
		receiptCollectorInternals.resolveReviewerTaskScope;

	beforeEach(() => {
		resetSwarmState();
		dir = makeTempProject();
		receiptCollectorInternals.resolveReviewerTaskScope = async () => ({
			content: 'opencode-swarm-reviewer-task-scope-v1\nbackground\n',
			description: 'reviewer-task-files-v1',
			files: ['src/background.ts'],
		});
	});

	afterEach(() => {
		receiptCollectorInternals.resolveReviewerTaskScope =
			realResolveReviewerTaskScope;
		resetSwarmState();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('a body-less persisted terminal result does not shadow the event text — the verdict parses and the gate receipt lands', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(dir, '1.1');

		const promptDigest = digest('TASK: 1.1\nReview the change.');
		await recordPendingDelegation(dir, {
			correlationId: 'ses_bodyless',
			jobId: 'job_bodyless',
			subagentSessionId: 'ses_bodyless',
			parentSessionId: 'parent_session',
			callID: 'call-bodyless',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: generation,
			prompt: {
				text: 'TASK: 1.1\nReview the change.',
				chars: 26,
				truncated: false,
				digest: promptDigest,
			},
		});

		// The wedge shape: the store already holds a terminal whose result
		// carries ONLY the scalars (chars/digest/truncated) — the fold's
		// closed-summary shape. Its digest matches the event text's digest, so
		// the observer's own terminal claim arrives as `duplicate` and the
		// text-less record is what the ingestion would see.
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'ses_bodyless',
			jobId: 'job_bodyless',
			status: 'completed',
			resultDigest: digest(VERDICT_TEXT),
		});
		const bodyLessClaim = await claimTerminalResult(dir, 'ses_bodyless', {
			eventId,
			status: 'completed',
			recordedAt: 1,
			result: {
				chars: VERDICT_TEXT.length,
				truncated: false,
				digest: digest(VERDICT_TEXT),
			},
		});
		expect(bodyLessClaim?.disposition).toBe('claimed');
		expect(bodyLessClaim?.record.result?.text).toBeUndefined();

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
			reviewerReceiptOptions: {
				config: resolveAutoReviewConfig({ enabled: true }),
			},
		});
		const event = syntheticPartEvent(
			'<task id="ses_bodyless" state="completed">\n' +
				`<task_result>${VERDICT_TEXT}</task_result>\n` +
				'</task>',
		);

		await observer.event(event);

		const record = findByCorrelationId(dir, 'ses_bodyless');
		expect(record?.status).toBe('consumed');
		// THE delta: without the fallback the verdict arm rejects on the
		// body-less record result; with it the event text parses and the gate
		// receipt lands.
		expect((await readTaskEvidence(dir, '1.1'))?.gates.reviewer?.agent).toBe(
			'reviewer',
		);
	});

	it('a body-ful persisted terminal result keeps the flow accepted (duplicate-claim shape)', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(dir, '1.1');

		const persistedText =
			'[REVIEWED] | 1.1 | APPROVED | persisted body is the replay authority';
		await recordPendingDelegation(dir, {
			correlationId: 'ses_bodyful',
			jobId: 'job_bodyful',
			subagentSessionId: 'ses_bodyful',
			parentSessionId: 'parent_session',
			callID: 'call-bodyful',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: generation,
			prompt: {
				text: 'TASK: 1.1\nReview the change.',
				chars: 26,
				truncated: false,
				digest: digest('TASK: 1.1\nReview the change.'),
			},
		});
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'ses_bodyful',
			jobId: 'job_bodyful',
			status: 'completed',
			resultDigest: digest(persistedText),
		});
		// Body-ful terminal already claimed: a re-delivery of the SAME event
		// (same digest → same eventId) arrives as `duplicate` and the record's
		// own body-ful result stays the ingestion input — no shadowing, no
		// regression of the pre-fix replay semantics.
		await claimTerminalResult(dir, 'ses_bodyful', {
			eventId,
			status: 'completed',
			recordedAt: 1,
			result: {
				text: persistedText,
				chars: persistedText.length,
				truncated: false,
				digest: digest(persistedText),
			},
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
			reviewerReceiptOptions: {
				config: resolveAutoReviewConfig({ enabled: true }),
			},
		});
		const event = syntheticPartEvent(
			'<task id="ses_bodyful" state="completed">\n' +
				`<task_result>${persistedText}</task_result>\n` +
				'</task>',
		);

		await observer.event(event);

		const record = findByCorrelationId(dir, 'ses_bodyful');
		expect(record?.status).toBe('consumed');
		expect((await readTaskEvidence(dir, '1.1'))?.gates.reviewer?.agent).toBe(
			'reviewer',
		);
	});
});
