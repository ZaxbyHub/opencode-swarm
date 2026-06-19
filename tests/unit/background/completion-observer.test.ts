/**
 * Background completion observer tests.
 *
 * Advisory completion ingestion mutates only the durable background ledger. It never
 * advances workflow gates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bgobs-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function syntheticPartEvent(opts: {
	text: string;
	synthetic?: boolean;
	sessionID?: string;
}) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					text: opts.text,
					synthetic: opts.synthetic,
					sessionID: opts.sessionID ?? 'parent_session',
				},
			},
		},
	};
}

const completedEnvelope = (id: string) =>
	`<task id="${id}" state="completed">\n<task_result>done</task_result>\n</task>`;

describe('background completion observer', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('is a no-op when disabled', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: false },
			directory: dir,
		});
		await expect(
			obs.event(
				syntheticPartEvent({
					text: completedEnvelope('ses_1'),
					synthetic: true,
				}),
			),
		).resolves.toBeUndefined();
	});

	it('records a trusted correlated completion in the durable ledger', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'ses_obs',
			jobId: 'job_obs',
			subagentSessionId: 'ses_obs',
			parentSessionId: 'parent_session',
			callID: 'c1',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_obs'),
				synthetic: true,
			}),
		);

		const record = findByCorrelationId(dir, 'ses_obs');
		expect(record?.status).toBe('completed');
		expect(record?.result?.text).toBe('done');
	});

	it('ignores a correlated completion with the wrong parent session', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'ses_parent_mismatch',
			jobId: 'job_obs',
			subagentSessionId: 'ses_parent_mismatch',
			parentSessionId: 'parent_session',
			callID: 'c1',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_parent_mismatch'),
				synthetic: true,
				sessionID: 'other_parent',
			}),
		);

		expect(findByCorrelationId(dir, 'ses_parent_mismatch')?.status).toBe(
			'pending',
		);
	});

	it('ignores non-synthetic envelope-shaped text (trust gate)', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await expect(
			obs.event(
				syntheticPartEvent({
					text: completedEnvelope('ses_spoof'),
					synthetic: false,
				}),
			),
		).resolves.toBeUndefined();
	});

	it('ignores non-text / non-part / unrelated events without throwing', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await expect(
			obs.event({ event: { type: 'session.idle', properties: {} } }),
		).resolves.toBeUndefined();
		await expect(obs.event({ event: undefined })).resolves.toBeUndefined();
		await expect(
			obs.event({
				event: {
					type: 'message.part.updated',
					properties: { part: { type: 'file' } },
				},
			}),
		).resolves.toBeUndefined();
	});

	it('handles a synthetic completion with no matching pending record (no throw)', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await expect(
			obs.event(
				syntheticPartEvent({
					text: completedEnvelope('ses_unknown'),
					synthetic: true,
				}),
			),
		).resolves.toBeUndefined();
	});

	it('ignores a running (non-terminal) synthetic envelope', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await expect(
			obs.event(
				syntheticPartEvent({
					text: '<task id="ses_run" state="running"></task>',
					synthetic: true,
				}),
			),
		).resolves.toBeUndefined();
	});
});
