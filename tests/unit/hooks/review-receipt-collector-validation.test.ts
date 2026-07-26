import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import type { RejectedReviewReceipt } from '../../../src/hooks/review-receipt';
import {
	_internals,
	collectReviewerReceiptAfter,
} from '../../../src/hooks/review-receipt-collector';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import {
	createFindingValidationScheduler,
	type FindingValidationScheduler,
	MAX_TRACKED_VALIDATION_SESSIONS,
} from '../../../src/review/finding-validator';

const STRUCTURED_REJECTED_OUTPUT = [
	'VERDICT: REJECTED',
	'RISK: HIGH',
	'ISSUES: none (see structured findings)',
	'FIXES: correct the loop bound',
	'```json',
	'{"findings":[{"title":"Final record is dropped","body":"The loop exits before processing the final record.","severity":"high","confidence":0.93,"file":"src/utils/parse.ts","line_start":42,"line_end":43}],"verdict":"REJECTED","overall_confidence":0.91}',
	'```',
].join('\n');
let tmpDir: string;
const originalDelegationEnd = _internals.delegationEnd;
const originalResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;
type DelegationEndCall = {
	sessionID: string;
	agentName: string;
	taskID: string;
	result: string;
	costFields: Parameters<typeof _internals.delegationEnd>[4];
};
let delegationEndCalls: DelegationEndCall[];
let validationScheduler: FindingValidationScheduler;
beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-validation-')),
	);
	delegationEndCalls = [];
	validationScheduler = createFindingValidationScheduler();
	_internals.delegationEnd = (
		sessionID,
		agentName,
		taskID,
		result,
		costFields,
	) => {
		delegationEndCalls.push({
			sessionID,
			agentName,
			taskID,
			result,
			costFields,
		});
	};
	_internals.resolveReviewerTaskScope = async () => ({
		content: 'opencode-swarm-reviewer-task-scope-v1\nvalidation-fixture\n',
		description: 'reviewer-task-files-v1',
		files: ['src/fixture.ts'],
	});
});
afterEach(() => {
	validationScheduler.reset();
	_internals.delegationEnd = originalDelegationEnd;
	_internals.resolveReviewerTaskScope = originalResolveReviewerTaskScope;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {}
});
function validationConfig() {
	return resolveAutoReviewConfig({
		enabled: true,
		validate_findings: true,
	});
}
function occupyValidationSlot(sessionID: string): void {
	const scheduled = validationScheduler.schedule(
		sessionID,
		() => new Promise(() => {}),
		() => {},
	);
	expect(scheduled).toBe(true);
}
async function collectStructuredReceipt(input: {
	sessionID: string;
	dispatcher: ReviewModelDispatcher;
	injectAdvisory: (sessionID: string, message: string) => void;
	targetAgent?: string;
	generatedAgentNames?: Iterable<string>;
}): Promise<string> {
	const receiptPath = await collectReviewerReceiptAfter(
		tmpDir,
		{
			tool: 'Task',
			args: {
				subagent_type: input.targetAgent ?? 'reviewer',
				prompt: 'TASK: Review structured output',
			},
			sessionID: input.sessionID,
		},
		{ output: STRUCTURED_REJECTED_OUTPUT },
		{
			config: validationConfig(),
			dispatcher: input.dispatcher,
			generatedAgentNames: input.generatedAgentNames,
			injectAdvisory: input.injectAdvisory,
			validationScheduler,
		},
	);
	expect(receiptPath).not.toBeNull();
	return receiptPath as string;
}
function readRejectedReceipt(receiptPath: string): RejectedReviewReceipt {
	return JSON.parse(
		fs.readFileSync(receiptPath, 'utf-8'),
	) as RejectedReviewReceipt;
}
function expectIncompleteOutcome(
	receiptPath: string,
	advisories: string[],
): void {
	const receipt = readRejectedReceipt(receiptPath);
	expect(receipt.finding_validations).toHaveLength(1);
	expect(receipt.finding_validations?.[0]).toMatchObject({
		disposition: 'UNVERIFIED',
		confidence: 0,
	});
	expect(receipt.finding_validations?.[0].finding_id).toBe(
		receipt.blocking_findings[0].finding_id,
	);
	expect(receipt.finding_validations?.[0].evidence).toContain(
		'Validation incomplete:',
	);
	expect(receipt.blocking_findings[0].validator_disposition).toBe('UNVERIFIED');
	expect(advisories).toHaveLength(1);
	expect(advisories[0]).toContain('recorded as UNVERIFIED');
	expect(advisories[0]).toContain(receiptPath);
}
describe('review receipt validation scheduling — regression F-final-review', () => {
	test('validator resolution stays bound to the originating multi-swarm instance', async () => {
		let advisoryReady!: () => void;
		const advisory = new Promise<void>((resolve) => {
			advisoryReady = resolve;
		});
		let capturedAgentName: string | undefined;
		await collectStructuredReceipt({
			sessionID: 'alpha-session',
			targetAgent: 'alpha_reviewer',
			generatedAgentNames: ['alpha_reviewer', 'alpha_critic_finding_validator'],
			dispatcher: {
				async dispatch(request) {
					capturedAgentName = request.agentName;
					const findingID = request.prompt.match(
						/"finding_id": "([a-f0-9]{64})"/,
					)?.[1];
					if (!findingID) throw new Error('missing validation candidate ID');
					const text = JSON.stringify({
						validations: [
							{
								finding_id: findingID,
								disposition: 'DISPROVED',
								confidence: 0.98,
								evidence: 'independent check',
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
			injectAdvisory: () => advisoryReady(),
		});
		await advisory;
		expect(capturedAgentName).toBe('alpha_critic_finding_validator');
	});
	test('never borrows another swarm validator when the paired validator is absent', async () => {
		let advisoryReady!: () => void;
		const advisory = new Promise<void>((resolve) => {
			advisoryReady = resolve;
		});
		let capturedAgentName: string | undefined;
		await collectStructuredReceipt({
			sessionID: 'alpha-missing-validator',
			targetAgent: 'alpha_reviewer',
			generatedAgentNames: ['alpha_reviewer', 'beta_critic_finding_validator'],
			dispatcher: {
				async dispatch(request) {
					capturedAgentName = request.agentName;
					throw new Error('alpha validator is not registered');
				},
			},
			injectAdvisory: () => advisoryReady(),
		});
		await advisory;

		expect(capturedAgentName).toBe('alpha_critic_finding_validator');
		expect(capturedAgentName).not.toBe('beta_critic_finding_validator');
	});
	test('persists conflicting valid validator wrappers as incomplete', async () => {
		let advisoryReady!: () => void;
		const advisory = new Promise<void>((resolve) => {
			advisoryReady = resolve;
		});
		const advisories: string[] = [];
		const receiptPath = await collectStructuredReceipt({
			sessionID: 'conflicting-validator-wrappers',
			dispatcher: {
				async dispatch(request) {
					const findingID = request.prompt.match(
						/"finding_id": "([a-f0-9]{64})"/,
					)?.[1];
					if (!findingID) throw new Error('missing validation candidate ID');
					const wrapper = (disposition: 'CONFIRMED' | 'DISPROVED') =>
						JSON.stringify({
							validations: [
								{
									finding_id: findingID,
									disposition,
									confidence: 0.99,
									evidence: `${disposition} from direct repository evidence.`,
								},
							],
						});
					const text = [
						'```json',
						wrapper('CONFIRMED'),
						'```',
						'```json',
						wrapper('DISPROVED'),
						'```',
					].join('\n');
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
		});
		await advisory;

		expectIncompleteOutcome(receiptPath, advisories);
		expect(advisories[0]).toContain('found 2');
	});
	test('runs parallel receipt identities independently within one session', async () => {
		occupyValidationSlot('shared-session');
		const advisories: string[] = [];
		let advisoryReady!: () => void;
		const advisory = new Promise<void>((resolve) => {
			advisoryReady = resolve;
		});
		let dispatchCalls = 0;
		const receiptPath = await collectStructuredReceipt({
			sessionID: 'shared-session',
			dispatcher: {
				async dispatch(request) {
					dispatchCalls += 1;
					const findingID = request.prompt.match(
						/"finding_id"\s*:\s*"([^"]+)"/,
					)?.[1];
					const text = `\`\`\`json\n${JSON.stringify({
						validations: [
							{
								finding_id: findingID,
								disposition: 'CONFIRMED',
								confidence: 0.9,
								evidence: 'confirmed',
							},
						],
					})}\n\`\`\``;
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
		});
		await advisory;

		expect(dispatchCalls).toBe(1);
		expect(delegationEndCalls).toHaveLength(1);
		expect(
			readRejectedReceipt(receiptPath).finding_validations?.[0].disposition,
		).toBe('CONFIRMED');
		expect(advisories[0]).toContain('1 confirmed');
	});

	test('persists UNVERIFIED and advises when live capacity is full', async () => {
		for (let index = 0; index < MAX_TRACKED_VALIDATION_SESSIONS; index += 1) {
			occupyValidationSlot(`capacity-${index}`);
		}
		const advisories: string[] = [];
		let dispatchCalls = 0;
		const receiptPath = await collectStructuredReceipt({
			sessionID: 'capacity-overflow',
			dispatcher: {
				async dispatch() {
					dispatchCalls += 1;
					throw new Error('must not dispatch after scheduler refusal');
				},
			},
			injectAdvisory: (_sessionID, message) => advisories.push(message),
		});

		expect(dispatchCalls).toBe(0);
		expect(delegationEndCalls).toHaveLength(0);
		expectIncompleteOutcome(receiptPath, advisories);
		expect(advisories[0]).toContain('256-validation capacity');
	});

	test('persists UNVERIFIED and advises when validator execution rejects', async () => {
		let advisoryReady!: (message: string) => void;
		const advisory = new Promise<string>((resolve) => {
			advisoryReady = resolve;
		});
		const receiptPath = await collectStructuredReceipt({
			sessionID: 'rejected-validator',
			dispatcher: {
				async dispatch() {
					throw new Error('provider transport rejected');
				},
			},
			injectAdvisory: (_sessionID, message) => advisoryReady(message),
		});
		const advisories = [await advisory];

		expectIncompleteOutcome(receiptPath, advisories);
		expect(advisories[0]).toContain('validation was incomplete');
		expect(advisories[0]).toContain('provider transport rejected');
		expect(delegationEndCalls).toEqual([
			{
				sessionID: 'rejected-validator',
				agentName: 'critic_finding_validator',
				taskID: 'reviewer-task-validation',
				result: 'error',
				costFields: { gate: 'finding_validation' },
			},
		]);
	});
});

describe('review receipt validation telemetry — regression F-final-telemetry', () => {
	test('records one completed dispatch with authoritative cost fields', async () => {
		let advisoryReady!: () => void;
		const advisory = new Promise<void>((resolve) => {
			advisoryReady = resolve;
		});
		await collectStructuredReceipt({
			sessionID: 'telemetry-completed',
			dispatcher: {
				async dispatch(request) {
					const findingID = request.prompt.match(
						/"finding_id": "([a-f0-9]{64})"/,
					)?.[1];
					if (!findingID) throw new Error('missing validation candidate ID');
					const text = JSON.stringify({
						validations: [
							{
								finding_id: findingID,
								disposition: 'CONFIRMED',
								confidence: 0.97,
								evidence: 'src/utils/parse.ts:42 reproduces',
							},
						],
					});
					return {
						status: 'completed',
						text,
						agentName: request.agentName,
						durationMs: 12,
						promptBytes: request.prompt.length,
						responseBytes: text.length,
						costFields: {
							tokens_input: 111,
							tokens_output: 22,
							tokens_reasoning: 3,
							tokens_cache: 4,
							cost_usd: 0.0123,
							cost_source: 'reported',
							model: 'provider/validator',
						},
					};
				},
			},
			injectAdvisory: () => advisoryReady(),
		});
		await advisory;

		expect(delegationEndCalls).toEqual([
			{
				sessionID: 'telemetry-completed',
				agentName: 'critic_finding_validator',
				taskID: 'reviewer-task-validation',
				result: 'completed',
				costFields: {
					tokens_input: 111,
					tokens_output: 22,
					tokens_reasoning: 3,
					tokens_cache: 4,
					cost_usd: 0.0123,
					cost_source: 'reported',
					model: 'provider/validator',
					gate: 'finding_validation',
				},
			},
		]);
	});

	test('records one terminal error dispatch with its cost fields', async () => {
		let advisoryReady!: () => void;
		const advisory = new Promise<void>((resolve) => {
			advisoryReady = resolve;
		});
		await collectStructuredReceipt({
			sessionID: 'telemetry-error',
			dispatcher: {
				async dispatch(request) {
					return {
						status: 'error',
						text: '',
						error: 'provider returned an error envelope',
						agentName: request.agentName,
						durationMs: 7,
						promptBytes: request.prompt.length,
						responseBytes: 0,
						costFields: {
							tokens_input: 17,
							tokens_output: 0,
							tokens_reasoning: 0,
							tokens_cache: 2,
							cost_usd: null,
							cost_source: 'unavailable',
							model: 'provider/validator',
						},
					};
				},
			},
			injectAdvisory: () => advisoryReady(),
		});
		await advisory;

		expect(delegationEndCalls).toEqual([
			{
				sessionID: 'telemetry-error',
				agentName: 'critic_finding_validator',
				taskID: 'reviewer-task-validation',
				result: 'error',
				costFields: {
					tokens_input: 17,
					tokens_output: 0,
					tokens_reasoning: 0,
					tokens_cache: 2,
					cost_usd: null,
					cost_source: 'unavailable',
					model: 'provider/validator',
					gate: 'finding_validation',
				},
			},
		]);
	});
});
