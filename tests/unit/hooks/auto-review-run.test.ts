import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import { _internals, runAutoReview } from '../../../src/hooks/auto-review';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import { captureReviewAgentModelRegistry } from '../../../src/review/runtime';
import { eventLinesOf } from '../../helpers/event-lines.js';

let tmpDir: string;
const originalRunReviewEngine = _internals.runReviewEngine;
const dispatcher = {
	dispatch: async () => {
		throw new Error('not called directly');
	},
} as ReviewModelDispatcher;

function makeConfig(overrides: Record<string, unknown> = {}) {
	return AutoReviewConfigSchema.parse({ enabled: true, ...overrides });
}

function readEvents(): Array<Record<string, unknown>> {
	const target = path.join(tmpDir, '.swarm', 'events.jsonl');
	if (!fs.existsSync(target)) return [];
	return eventLinesOf(fs.readFileSync(target, 'utf8')).map((l) =>
		JSON.parse(l),
	);
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'auto-review-run-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	_internals.runReviewEngine = originalRunReviewEngine;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runAutoReview', () => {
	test('delegates task review to the shared engine and records one event', async () => {
		let captured: Record<string, unknown> | undefined;
		_internals.runReviewEngine = async (input) => {
			captured = input as unknown as Record<string, unknown>;
			return {
				status: 'completed',
				blocked: false,
				message: 'review completed',
				findings: [],
				blockingFindings: [],
				validationComplete: true,
				receiptPath: 'receipt.json',
				evidencePath: 'evidence.json',
				scopeHash: 'a'.repeat(64),
				modelCalls: 1,
			};
		};
		const result = await runAutoReview({
			directory: tmpDir,
			sessionID: 's1',
			trigger: 'task_completion',
			taskId: '1.1',
			config: makeConfig({ trigger: 'task_completion' }),
			dispatcher,
			injectAdvisory: () => {},
		});
		expect(result?.status).toBe('completed');
		expect(captured?.selector).toEqual({ kind: 'working-tree' });
		expect(captured?.dispatcher).toBe(dispatcher);
		expect(readEvents()).toHaveLength(1);
		expect(readEvents()[0]).toMatchObject({
			type: 'auto_review',
			verdict: 'completed',
			task_id: '1.1',
			model_calls: 1,
		});
	});

	test('[review finding F3] task review skips malformed fallback entries', async () => {
		let captured: Record<string, unknown> | undefined;
		const generatedAgentNames = ['reviewer', 'critic_finding_validator'];
		_internals.runReviewEngine = async (input) => {
			captured = input as unknown as Record<string, unknown>;
			return {
				status: 'completed',
				blocked: false,
				message: 'review completed',
				findings: [],
				blockingFindings: [],
				validationComplete: true,
				modelCalls: 1,
			};
		};
		await runAutoReview({
			directory: tmpDir,
			sessionID: 's1',
			trigger: 'task_completion',
			config: makeConfig({
				trigger: 'task_completion',
				validation_model: 'openai/test-validator',
			}),
			dispatcher,
			generatedAgentNames,
			agentModelRegistry: captureReviewAgentModelRegistry(
				{
					agents: {
						reviewer: {
							fallback_models: ['malformed', 'openai/task-fallback'],
						},
						critic_finding_validator: {
							fallback_models: ['invalid', 'opencode/gpt-5-nano'],
						},
					},
				},
				generatedAgentNames,
			),
			injectAdvisory: () => {},
		});
		expect(captured?.validatorModel).toEqual({
			providerID: 'openai',
			modelID: 'test-validator',
		});
		expect(captured?.reviewerFallbackModels).toEqual([
			{ providerID: 'openai', modelID: 'task-fallback' },
		]);
		expect(captured?.validatorFallbackModels).toEqual([
			{ providerID: 'opencode', modelID: 'gpt-5-nano' },
		]);
	});

	test('missing instance runtime fails open and records an honest error', async () => {
		let called = false;
		_internals.runReviewEngine = async () => {
			called = true;
			throw new Error('unexpected');
		};
		await expect(
			runAutoReview({
				directory: tmpDir,
				sessionID: 's1',
				trigger: 'task_completion',
				config: makeConfig({ trigger: 'task_completion' }),
				injectAdvisory: () => {},
			}),
		).resolves.toBeUndefined();
		expect(called).toBe(false);
		expect(readEvents()[0]).toMatchObject({
			verdict: 'error',
			detail: 'review runtime unavailable',
		});
	});
});
