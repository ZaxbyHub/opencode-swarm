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
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import { createFindingValidationScheduler } from '../../../src/review/finding-validator';
import {
	getReviewerScopeGenerationForCoderCall,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';

const APPROVED_OUTPUT =
	'VERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none';
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
const realBuildReviewerTaskScope =
	receiptCollectorInternals.buildReviewerTaskScope;
const validationScheduler = createFindingValidationScheduler();

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

async function prepareGeneration(input: {
	coderCallID: string;
	reviewerCallID: string;
	content: string;
}): Promise<void> {
	const childSessionID = `child-${input.coderCallID}`;
	startAgentSession(childSessionID, 'coder', directory);
	swarmState.activeAgent.set(childSessionID, 'coder');
	const child = swarmState.agentSessions.get(childSessionID)!;
	child.delegationActive = true;
	installActiveScopeBinding({
		directory,
		childSessionId: childSessionID,
		parentSessionId: 'parent',
		dispatchCallId: input.coderCallID,
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
			callID: input.coderCallID,
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
	fs.writeFileSync(path.join(directory, 'src/a.ts'), input.content);
	await hooks.toolAfter(
		{
			tool: 'apply_patch',
			sessionID: childSessionID,
			callID: 'write-call',
		},
		{ title: '', output: 'write completed', metadata: { status: 'completed' } },
	);
	expect(
		getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			coderCallID: input.coderCallID,
		})?.modifiedFiles,
	).toEqual(['src/a.ts']);
	expect(
		await completeReviewerScopeLifecycle({
			directory,
			tool: 'Task',
			args: coderArgs,
			output: { output: 'coder completed' },
			parentSessionID: 'parent',
			callID: input.coderCallID,
		}),
	).toBe('coder_ready');
	setStoredInputArgs(input.coderCallID, coderArgs);
	await hooks.toolAfter(
		{
			tool: 'Task',
			sessionID: 'parent',
			callID: input.coderCallID,
		},
		{ output: 'coder completed' },
	);
	expect(
		getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			coderCallID: input.coderCallID,
		})?.modifiedFiles,
	).toEqual(['src/a.ts']);
	const reviewer = reviewerInput(input.reviewerCallID);
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

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'review-scope-lifecycle-')),
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
	receiptCollectorInternals.buildReviewerTaskScope = realBuildReviewerTaskScope;
	validationScheduler.reset();
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('Stage-B exact reviewer scope lifecycle', () => {
	test('routes child writes into the exact coder generation and consumes once', async () => {
		await prepareGeneration({
			coderCallID: 'coder-1',
			reviewerCallID: 'reviewer-1',
			content: 'export const value = 2;\n',
		});
		const config = resolveAutoReviewConfig({ enabled: true });
		const receiptPath = await collectReviewerReceiptAfter(
			directory,
			reviewerInput('reviewer-1'),
			{ output: APPROVED_OUTPUT },
			{ config },
		);
		expect(receiptPath).not.toBeNull();
		expect(
			await collectReviewerReceiptAfter(
				directory,
				reviewerInput('reviewer-1'),
				{ output: APPROVED_OUTPUT },
				{ config },
			),
		).toBeNull();
	});

	test('does not consume a claimed generation for a background running placeholder', async () => {
		await prepareGeneration({
			coderCallID: 'coder-running',
			reviewerCallID: 'reviewer-running',
			content: 'export const value = 2;\n',
		});
		const config = resolveAutoReviewConfig({ enabled: true });
		expect(
			await collectReviewerReceiptAfter(
				directory,
				reviewerInput('reviewer-running'),
				{ state: 'running', output: 'Task is running in the background.' },
				{ config },
			),
		).toBeNull();
		expect(
			await collectReviewerReceiptAfter(
				directory,
				reviewerInput('reviewer-running'),
				{ output: APPROVED_OUTPUT },
				{ config },
			),
		).not.toBeNull();
	});

	test('discards synchronous coder generations for every terminal non-success result', async () => {
		const args = {
			subagent_type: 'coder',
			prompt: 'TASK: 1.1\nImplement the task.',
		};
		for (const [index, output] of [
			{ status: 'failed', output: 'failure' },
			{ state: 'cancelled', output: '' },
			{ state: 'completed', metadata: { status: 'stale' }, output: 'done' },
		].entries()) {
			const coderCallID = `coder-terminal-${index}`;
			startAgentSession(`child-${coderCallID}`, 'coder', directory);
			installActiveScopeBinding({
				directory,
				childSessionId: `child-${coderCallID}`,
				parentSessionId: 'parent',
				dispatchCallId: coderCallID,
				taskId: '1.1',
				files: ['src/a.ts'],
			});
			expect(
				await beginApprovedReviewerScopeLifecycle({
					directory,
					tool: 'Task',
					args,
					parentSessionID: 'parent',
					callID: coderCallID,
				}),
			).toBe('coder_started');
			expect(
				await completeReviewerScopeLifecycle({
					directory,
					tool: 'Task',
					args,
					output,
					parentSessionID: 'parent',
					callID: coderCallID,
				}),
			).toBeNull();
			expect(
				getReviewerScopeGenerationForCoderCall({
					parentSessionID: 'parent',
					coderCallID,
				}),
			).toBeNull();
		}
	});

	test('consumes reviewer claims on terminal failure and successful empty output', async () => {
		const config = resolveAutoReviewConfig({ enabled: true });
		for (const [suffix, output] of [
			['failure', { status: 'failed', output: '' }],
			['empty', { status: 'completed', output: '' }],
		] as const) {
			const coderCallID = `coder-reviewer-${suffix}`;
			const reviewerCallID = `reviewer-${suffix}`;
			await prepareGeneration({
				coderCallID,
				reviewerCallID,
				content: `export const value = '${suffix}';\n`,
			});
			expect(
				await collectReviewerReceiptAfter(
					directory,
					reviewerInput(reviewerCallID),
					output,
					{ config },
				),
			).toBeNull();
			expect(
				getReviewerScopeGenerationForCoderCall({
					parentSessionID: 'parent',
					coderCallID,
				}),
			).toBeNull();
		}
	});

	test('discards an approved late reviewer without consuming the newer same-task generation', async () => {
		await prepareGeneration({
			coderCallID: 'coder-old',
			reviewerCallID: 'reviewer-old',
			content: 'export const value = 2;\n',
		});
		const replacement = startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId: '1.1',
			coderCallID: 'coder-new',
			declaredFiles: ['src/a.ts'],
		});
		expect(replacement).not.toBeNull();
		expect(
			await collectReviewerReceiptAfter(
				directory,
				reviewerInput('reviewer-old'),
				{ status: 'completed', output: APPROVED_OUTPUT },
				{
					config: resolveAutoReviewConfig({
						enabled: true,
						validate_findings: false,
					}),
				},
			),
		).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-old',
			}),
		).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-new',
			})?.status,
		).toBe('collecting');
	});

	test('rechecks session incarnation immediately before receipt commit', async () => {
		await prepareGeneration({
			coderCallID: 'coder-incarnation-old',
			reviewerCallID: 'reviewer-incarnation-old',
			content: 'export const value = 2;\n',
		});
		let currentnessChecks = 0;
		receiptCollectorInternals.buildReviewerTaskScope = async (...args) => {
			currentnessChecks += 1;
			if (currentnessChecks === 2) {
				resetSwarmState();
				startAgentSession('parent', 'architect', directory);
				startReviewerScopeGeneration({
					parentSessionID: 'parent',
					taskId: '1.1',
					coderCallID: 'coder-incarnation-new',
					declaredFiles: ['src/a.ts'],
				});
			}
			return realBuildReviewerTaskScope(...args);
		};
		expect(
			await collectReviewerReceiptAfter(
				directory,
				reviewerInput('reviewer-incarnation-old'),
				{ status: 'completed', output: APPROVED_OUTPUT },
				{ config: resolveAutoReviewConfig({ enabled: true }) },
			),
		).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-incarnation-new',
			})?.status,
		).toBe('collecting');
		const receiptsDir = path.join(directory, '.swarm', 'review-receipts');
		expect(
			fs.existsSync(receiptsDir)
				? fs.readdirSync(receiptsDir).filter((file) => file.endsWith('.json'))
				: [],
		).toEqual([]);
	});

	test('discards validator output when files mutate before async completion', async () => {
		await prepareGeneration({
			coderCallID: 'coder-stale',
			reviewerCallID: 'reviewer-stale',
			content: 'export const value = 2;\n',
		});
		let finishDispatch!: (value: {
			status: 'completed';
			text: string;
			agentName: string;
			durationMs: number;
			promptBytes: number;
			responseBytes: number;
		}) => void;
		const advisories: string[] = [];
		const receiptPath = await collectReviewerReceiptAfter(
			directory,
			reviewerInput('reviewer-stale'),
			{ output: STRUCTURED_OUTPUT },
			{
				config: resolveAutoReviewConfig({
					enabled: true,
					validate_findings: true,
				}),
				validationScheduler,
				dispatcher: {
					async dispatch(request) {
						return await new Promise((resolve) => {
							finishDispatch = resolve;
						});
					},
				},
				injectAdvisory: (_sessionID, message) => advisories.push(message),
			},
		);
		expect(receiptPath).not.toBeNull();
		fs.writeFileSync(
			path.join(directory, 'src/a.ts'),
			'export const value = 3;\n',
		);
		const receipt = JSON.parse(fs.readFileSync(receiptPath!, 'utf8')) as {
			blocking_findings: Array<{ finding_id?: string }>;
		};
		const findingID = receipt.blocking_findings[0].finding_id!;
		const text = `\`\`\`json\n${JSON.stringify({
			validations: [
				{
					finding_id: findingID,
					disposition: 'CONFIRMED',
					confidence: 0.99,
					evidence: 'confirmed',
				},
			],
		})}\n\`\`\``;
		finishDispatch({
			status: 'completed',
			text,
			agentName: 'critic_finding_validator',
			durationMs: 1,
			promptBytes: 1,
			responseBytes: text.length,
		});
		for (let index = 0; index < 50 && advisories.length === 0; index += 1) {
			await Bun.sleep(10);
		}
		const updated = JSON.parse(fs.readFileSync(receiptPath!, 'utf8')) as {
			finding_validations?: unknown[];
		};
		expect(updated.finding_validations).toBeUndefined();
		expect(advisories.join('\n')).toContain('discarded as stale');
	});
});
