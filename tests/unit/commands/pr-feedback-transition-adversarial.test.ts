import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	readPrWorkflowGateState,
	transitionPrReviewToFeedback,
} from '../../../src/hooks/pr-workflow-gate.js';

const SESSION_ID = 'external-transition-session';
const PR_URL = 'https://github.com/owner/repo/pull/42';
const HEAD_SHA = 'a'.repeat(40);
let directory = '';

function relativePath(runId: string): string {
	return `.swarm/pr-review/${runId}/feedback-handoff.json`;
}

function payload(runId: string, overrides: Record<string, unknown> = {}) {
	return {
		schema_version: 1,
		run_id: runId,
		pr_head_sha: HEAD_SHA,
		created_at: '2026-08-01T00:00:00.000Z',
		pr_url: PR_URL,
		finding_ids: [`${runId}-finding`],
		summary: `handoff for ${runId}`,
		provenance: ['adversarial-test'],
		...overrides,
	};
}

async function writeHandoff(
	runId: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const relative = relativePath(runId);
	const absolute = path.join(directory, relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(
		absolute,
		JSON.stringify(payload(runId, overrides), null, 2),
		'utf8',
	);
	return relative;
}

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-feedback-transition-adversarial-')),
	);
	_test_exports.resetTrackedStateCache();
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('external PR feedback continuation hardening', () => {
	test('rejects duplicate IDs, invalid timestamps, and mismatched PR URLs', async () => {
		const duplicatePath = await writeHandoff('duplicate', {
			finding_ids: ['same', 'same'],
		});
		await expect(
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'duplicate',
				handoffPath: duplicatePath,
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/duplicate finding IDs/i);

		const invalidDatePath = await writeHandoff('bad-date', {
			created_at: 'not-a-date',
		});
		await expect(
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'bad-date',
				handoffPath: invalidDatePath,
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/artifact is invalid/i);

		const wrongPrPath = await writeHandoff('wrong-pr');
		await expect(
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'wrong-pr',
				handoffPath: wrongPrPath,
				prUrl: 'https://github.com/owner/repo/pull/99',
			}),
		).rejects.toThrow(/does not match the requested GitHub PR URL/i);
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
	});

	test('rejects lexical traversal and a junction or symlink escape', async () => {
		await expect(
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'escape',
				handoffPath: '.swarm/pr-review/escape/../escape/feedback-handoff.json',
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/must use \.swarm\/pr-review/i);

		const outside = path.join(directory, 'outside-run');
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(
			path.join(outside, 'feedback-handoff.json'),
			JSON.stringify(payload('linked-run')),
			'utf8',
		);
		const parent = path.join(directory, '.swarm', 'pr-review');
		await fs.mkdir(parent, { recursive: true });
		await fs.symlink(
			outside,
			path.join(parent, 'linked-run'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		await expect(
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'linked-run',
				handoffPath: relativePath('linked-run'),
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/escapes (?:the project )?\.swarm directory/i);
	});

	test('rejects a handoff directory swapped to a junction after validation', async () => {
		const handoffPath = await writeHandoff('swap-run');
		const runDirectory = path.join(
			directory,
			'.swarm',
			'pr-review',
			'swap-run',
		);
		const preserved = path.join(
			directory,
			'.swarm',
			'pr-review',
			'swap-run-preserved',
		);
		const outside = path.join(directory, 'outside-swap-run');
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(
			path.join(outside, 'feedback-handoff.json'),
			JSON.stringify(payload('swap-run', { summary: 'outside payload' })),
			'utf8',
		);
		_test_exports.beforeBoundedSwarmFileOpen = async () => {
			_test_exports.beforeBoundedSwarmFileOpen = undefined;
			await fs.rename(runDirectory, preserved);
			await fs.symlink(
				outside,
				runDirectory,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		};

		await expect(
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'swap-run',
				handoffPath,
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/changed|escaped/i);
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
	});

	test('same-artifact external transitions fail closed without a durable review consent offer', async () => {
		const handoffPath = await writeHandoff('same-run');
		const requests = await Promise.allSettled([
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'same-run',
				handoffPath,
				prUrl: PR_URL,
			}),
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'same-run',
				handoffPath,
				prUrl: PR_URL,
			}),
		]);
		expect(requests.every((request) => request.status === 'rejected')).toBe(
			true,
		);
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
	});

	test('different external handoffs cannot race around the durable consent requirement', async () => {
		const firstPath = await writeHandoff('first-run');
		const secondPath = await writeHandoff('second-run');
		const results = await Promise.allSettled([
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'first-run',
				handoffPath: firstPath,
				prUrl: PR_URL,
			}),
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'second-run',
				handoffPath: secondPath,
				prUrl: PR_URL,
			}),
		]);
		expect(
			results.filter((result) => result.status === 'rejected'),
		).toHaveLength(2);
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
	});

	test('artifact tampering never creates consent for a detached external handoff', async () => {
		const handoffPath = await writeHandoff('tamper-run');
		await expect(
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'tamper-run',
				handoffPath,
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/confirmation|consent|reservation/i);
		await writeHandoff('tamper-run', { summary: 'changed after transition' });

		await expect(
			transitionPrReviewToFeedback(directory, SESSION_ID, {
				runId: 'tamper-run',
				handoffPath,
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/confirmation|consent|reservation/i);
	});
});
