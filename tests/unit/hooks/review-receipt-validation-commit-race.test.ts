import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { setStoredInputArgs } from '../../../src/hooks/guardrails/stored-input-args';
import {
	collectReviewerReceiptAfter,
	_internals as receiptCollectorInternals,
} from '../../../src/hooks/review-receipt-collector';
import { _internals as receiptScopeInternals } from '../../../src/hooks/review-receipt-scope';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import {
	getReviewerScopeGenerationForCoderCall,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';

const STRUCTURED_OUTPUT = [
	'VERDICT: REJECTED',
	'RISK: HIGH',
	'ISSUES: none',
	'FIXES: fix it',
	'```json',
	JSON.stringify({
		findings: [
			{
				title: 'Incorrect value',
				body: 'The exported value is incorrect.',
				severity: 'high',
				confidence: 0.95,
				file: 'src/a.ts',
				line_start: 1,
				line_end: 1,
			},
		],
		verdict: 'REJECTED',
		overall_confidence: 0.95,
	}),
	'```',
].join('\n');

let directory = '';
const realUpdateReviewReceiptValidations =
	receiptCollectorInternals.updateReviewReceiptValidations;
const realScopeSpawn = receiptScopeInternals.spawn;

function git(...args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		stdio: 'ignore',
		timeout: 5_000,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

function guardrailsConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		block_destructive_commands: true,
	};
}

function reviewerInput(callID: string) {
	return {
		tool: 'Task',
		sessionID: 'parent',
		callID,
		args: {
			subagent_type: 'reviewer',
			prompt: 'TASK: 1.1\nReview the coder output.',
		},
	};
}

async function prepareGeneration(
	options: { beforeReviewer?: () => void } = {},
): Promise<void> {
	const coderCallID = 'coder-validation-race';
	const reviewerCallID = 'reviewer-validation-race';
	const childSessionID = `child-${coderCallID}`;
	startAgentSession(childSessionID, 'coder', directory);
	swarmState.activeAgent.set(childSessionID, 'coder');
	const child = swarmState.agentSessions.get(childSessionID)!;
	child.delegationActive = true;
	installActiveScopeBinding({
		directory,
		childSessionId: childSessionID,
		parentSessionId: 'parent',
		dispatchCallId: coderCallID,
		taskId: '1.1',
		files: ['src/a.ts'],
	});
	const coderArgs = {
		subagent_type: 'coder',
		prompt: 'TASK: 1.1\nImplement the task.',
	};
	expect(
		await beginApprovedReviewerScopeLifecycle({
			directory,
			tool: 'Task',
			args: coderArgs,
			parentSessionID: 'parent',
			callID: coderCallID,
		}),
	).toBe('coder_started');
	const hooks = createGuardrailsHooks(directory, undefined, guardrailsConfig());
	await hooks.toolBefore(
		{ tool: 'apply_patch', sessionID: childSessionID, callID: 'write-call' },
		{
			args: {
				input:
					'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch',
			},
		},
	);
	fs.writeFileSync(
		path.join(directory, 'src/a.ts'),
		'export const value = 2;\n',
	);
	await hooks.toolAfter(
		{
			tool: 'apply_patch',
			sessionID: childSessionID,
			callID: 'write-call',
		},
		{ title: '', output: 'write completed', metadata: { status: 'completed' } },
	);
	expect(
		await completeReviewerScopeLifecycle({
			directory,
			tool: 'Task',
			args: coderArgs,
			output: { output: 'coder completed' },
			parentSessionID: 'parent',
			callID: coderCallID,
		}),
	).toBe('coder_ready');
	setStoredInputArgs(coderCallID, coderArgs);
	await hooks.toolAfter(
		{ tool: 'Task', sessionID: 'parent', callID: coderCallID },
		{ output: 'coder completed' },
	);
	options.beforeReviewer?.();
	const reviewer = reviewerInput(reviewerCallID);
	expect(
		await beginApprovedReviewerScopeLifecycle({
			directory,
			tool: reviewer.tool,
			args: reviewer.args,
			parentSessionID: reviewer.sessionID,
			callID: reviewer.callID,
		}),
	).toBe('reviewer_claimed');
}

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'review-validation-race-')),
	);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'src/a.ts'),
		'export const value = 1;\n',
	);
	git('init');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	git('add', 'src/a.ts');
	git('commit', '-m', 'fixture');
	startAgentSession('parent', 'architect', directory);
});

afterEach(() => {
	receiptCollectorInternals.updateReviewReceiptValidations =
		realUpdateReviewReceiptValidations;
	receiptScopeInternals.spawn = realScopeSpawn;
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('review receipt validation commit boundary', () => {
	test('blocks reviewer dispatch when bytes change during awaited scope construction', async () => {
		let mutated = false;
		await expect(
			prepareGeneration({
				beforeReviewer: () => {
					receiptScopeInternals.spawn = ((command, args, options) => {
						const child = realScopeSpawn(command, args, options);
						if (!mutated) {
							mutated = true;
							child.once('close', () => {
								fs.writeFileSync(
									path.join(directory, 'src/a.ts'),
									'export const value = 3;\n',
								);
							});
						}
						return child;
					}) as typeof realScopeSpawn;
				},
			}),
		).rejects.toThrow(/scope changed during capture/);
		expect(mutated).toBe(true);
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-validation-race',
			}),
		).toBeNull();
	});

	test('blocks reviewer dispatch when bytes change after coder completion', async () => {
		await expect(
			prepareGeneration({
				beforeReviewer: () =>
					fs.writeFileSync(
						path.join(directory, 'src/a.ts'),
						'export const value = 3;\n',
					),
			}),
		).rejects.toThrow(/post-write fingerprints.*changed/);
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-validation-race',
			}),
		).toBeNull();
	});

	test('discards a reviewer result when bytes change while review is running', async () => {
		await prepareGeneration();
		fs.writeFileSync(
			path.join(directory, 'src/a.ts'),
			'export const value = 3;\n',
		);

		expect(
			await collectReviewerReceiptAfter(
				directory,
				reviewerInput('reviewer-validation-race'),
				{
					output: 'VERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none',
				},
				{ config: resolveAutoReviewConfig({ enabled: true }) },
			),
		).toBeNull();
		const receiptsDir = path.join(directory, '.swarm', 'review-receipts');
		expect(
			fs.existsSync(receiptsDir)
				? fs.readdirSync(receiptsDir).filter((file) => file.endsWith('.json'))
				: [],
		).toEqual([]);
	});

	test('discards validation when the exact generation changes immediately before rename', async () => {
		await prepareGeneration();
		let reachedCommitBoundary = false;
		receiptCollectorInternals.updateReviewReceiptValidations = async (
			receiptPath,
			validations,
			options,
		) =>
			realUpdateReviewReceiptValidations(receiptPath, validations, {
				...options,
				verifyCurrent: async () => {
					reachedCommitBoundary = true;
					startReviewerScopeGeneration({
						parentSessionID: 'parent',
						taskId: '1.1',
						coderCallID: 'coder-replacement',
						declaredFiles: ['src/a.ts'],
					});
					return (await options.verifyCurrent?.()) ?? true;
				},
			});
		const advisories: string[] = [];
		let advisoryReady!: () => void;
		const advisory = new Promise<void>((resolve) => {
			advisoryReady = resolve;
		});
		const receiptPath = await collectReviewerReceiptAfter(
			directory,
			reviewerInput('reviewer-validation-race'),
			{ output: STRUCTURED_OUTPUT },
			{
				config: resolveAutoReviewConfig({
					enabled: true,
					validate_findings: true,
				}),
				dispatcher: {
					async dispatch(request) {
						const findingID = request.prompt.match(
							/"finding_id"\s*:\s*"([^"]+)"/,
						)?.[1];
						const text = JSON.stringify({
							validations: [
								{
									finding_id: findingID,
									disposition: 'CONFIRMED',
									confidence: 0.99,
									evidence: 'confirmed',
								},
							],
						});
						return {
							status: 'completed',
							text,
							agentName: request.agentName,
							durationMs: 1,
							promptBytes: request.prompt.length,
							responseBytes: text.length,
						};
					},
				},
				injectAdvisory: (_sessionID, message) => {
					advisories.push(message);
					advisoryReady();
				},
			},
		);
		expect(receiptPath).not.toBeNull();
		await advisory;

		const receipt = JSON.parse(fs.readFileSync(receiptPath!, 'utf8')) as {
			finding_validations?: unknown[];
		};
		expect(reachedCommitBoundary).toBe(true);
		expect(receipt.finding_validations).toBeUndefined();
		expect(advisories.join('\n')).toContain('discarded as stale');
		expect(
			fs
				.readdirSync(path.dirname(receiptPath!))
				.filter((file) => file.includes('.tmp.')),
		).toEqual([]);
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-replacement',
			})?.status,
		).toBe('collecting');
	});
});
