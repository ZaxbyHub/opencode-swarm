import { afterEach, describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '../../../src/agents/index.js';
import {
	executeSwarmCommand,
	SWARM_COMMAND_TOOL_ALLOWLIST,
} from '../../../src/commands/index.js';
import {
	_internals,
	_test_exports,
	handleReviewCommand,
} from '../../../src/commands/review.js';
import { resolveAutoReviewConfig } from '../../../src/config/schema.js';
import type {
	ReviewEngineResult,
	RunReviewEngineInput,
} from '../../../src/review/engine.js';
import type { AutoReviewEvidence } from '../../../src/review/evidence.js';
import { captureReviewAgentModelRegistry } from '../../../src/review/runtime.js';

const originalRunReviewEngine = _internals.runReviewEngine;
const originalReadEvidence = _internals.readEvidence;

function agents(): Record<string, AgentDefinition> {
	return {
		mega_reviewer: {
			name: 'mega_reviewer',
			config: { model: 'openai/reviewer-model' },
		},
		mega_critic_finding_validator: {
			name: 'mega_critic_finding_validator',
			config: { model: 'anthropic/validator-model' },
		},
	};
}

function completedResult(
	overrides: Partial<ReviewEngineResult> = {},
): ReviewEngineResult {
	return {
		status: 'completed',
		blocked: false,
		message: 'Review completed with 2 finding(s).',
		findings: [
			{
				finding_id: 'medium-finding',
				duplicate_count: 1,
				title: 'Medium issue',
				body: 'A medium-impact defect.',
				severity: 'medium',
				effective_severity: 'medium',
				confidence: 0.8,
				file: 'src/medium.ts',
				line_start: 9,
				line_end: 10,
				anchored: false,
				anchor_rejection: 'line is outside the changed hunk',
			},
			{
				finding_id: 'critical-finding',
				duplicate_count: 1,
				title: 'Critical issue',
				body: 'A concrete critical defect.',
				severity: 'critical',
				effective_severity: 'critical',
				confidence: 0.98,
				file: 'src/critical.ts',
				line_start: 3,
				line_end: 3,
				anchored: true,
				validation: {
					finding_id: 'critical-finding',
					disposition: 'CONFIRMED',
					confidence: 0.97,
					evidence: 'src/critical.ts:3 reproduces the failure',
				},
			},
		],
		blockingFindings: [],
		validationComplete: true,
		receiptPath: '/repo/.swarm/review-receipts/receipt.json',
		evidencePath: '/repo/.swarm/evidence/auto-review/manual.json',
		scopeHash: 'a'.repeat(64),
		reviewModel: 'openai/reviewer-model',
		modelCalls: 2,
		...overrides,
	};
}

function evidence(): AutoReviewEvidence {
	return {
		schema_version: 1,
		timestamp: '2026-07-25T00:00:00.000Z',
		trigger: 'manual',
		session_id: 'session-review',
		scope: {
			hash: 'a'.repeat(64),
			selector: { kind: 'base', ref: 'origin/main' },
			head_sha: 'b'.repeat(40),
			base_ref: 'origin/main',
			base_sha: 'c'.repeat(40),
			merge_base: 'c'.repeat(40),
			review_text_bytes: 512,
			completeness: {
				complete: true,
				truncated: false,
				skipReasons: [],
			},
		},
		policy: {
			mode: 'advisory',
			min_confidence: 0.7,
			structured_findings: true,
			validate_findings: true,
		},
		review: {
			status: 'completed',
			output_mode: 'structured',
			overall_confidence: 0.94,
			model: 'openai/reviewer-model',
			duration_ms: 41,
		},
		findings: completedResult().findings,
		validation_complete: true,
		blocking_finding_ids: [],
		receipt_path: '/repo/.swarm/review-receipts/receipt.json',
		cost: {
			model_calls: 2,
			diff_bytes: 512,
			prompt_bytes: 1024,
			tokens_input: 120,
			tokens_output: 40,
			tokens_reasoning: 10,
			tokens_cache: 5,
			cost_usd: 0.0123,
			cost_source: 'reported',
		},
	};
}

afterEach(() => {
	_internals.runReviewEngine = originalRunReviewEngine;
	_internals.readEvidence = originalReadEvidence;
});

describe('/swarm review', () => {
	test.each([
		[[], { kind: 'default' }],
		[['--base', 'origin/main'], { kind: 'base', ref: 'origin/main' }],
		[
			['--range', 'main..feature'],
			{ kind: 'range', from: 'main', to: 'feature', operator: '..' },
		],
		[
			['--range', 'main...feature'],
			{ kind: 'range', from: 'main', to: 'feature', operator: '...' },
		],
		[['--working-tree'], { kind: 'working-tree' }],
	])('dispatches selector %j through the shared engine', async (args, selector) => {
		let captured: RunReviewEngineInput | undefined;
		_internals.runReviewEngine = async (input) => {
			captured = input;
			return completedResult({ findings: [], modelCalls: 1 });
		};
		_internals.readEvidence = () => null;
		const dispatcher = { dispatch: async () => Promise.reject('not called') };
		const config = resolveAutoReviewConfig({
			enabled: false,
			validate_findings: true,
		});

		await handleReviewCommand({
			directory: '/repo',
			args,
			sessionID: 'session-review',
			agents: agents(),
			reviewModelDispatcher: dispatcher,
			autoReviewConfig: config,
		});

		expect(captured?.selector).toEqual(selector);
		expect(captured?.trigger).toBe('manual');
		expect(captured?.directory).toBe('/repo');
		expect(captured?.sessionID).toBe('session-review');
		expect(captured?.dispatcher).toBe(dispatcher);
		expect(captured?.config).toBe(config);
		expect(captured?.reviewerAgent).toBe('mega_reviewer');
		expect(captured?.validatorAgent).toBe('mega_critic_finding_validator');
	});

	test('regression F3: manual review skips malformed fallback entries', async () => {
		let captured: RunReviewEngineInput | undefined;
		_internals.runReviewEngine = async (input) => {
			captured = input;
			return completedResult({ findings: [], modelCalls: 1 });
		};
		_internals.readEvidence = () => null;
		const multiAgents: Record<string, AgentDefinition> = {
			alpha_architect: {
				name: 'alpha_architect',
				config: { model: 'openai/alpha-architect' },
			},
			alpha_reviewer: {
				name: 'alpha_reviewer',
				config: { model: 'openai/alpha-reviewer' },
			},
			alpha_critic_finding_validator: {
				name: 'alpha_critic_finding_validator',
				config: { model: 'openai/alpha-validator' },
			},
			beta_architect: {
				name: 'beta_architect',
				config: { model: 'openai/beta-architect' },
			},
			beta_reviewer: {
				name: 'beta_reviewer',
				config: { model: 'openai/beta-reviewer' },
			},
			beta_critic_finding_validator: {
				name: 'beta_critic_finding_validator',
				config: { model: 'openai/beta-validator' },
			},
		};
		const pluginConfig = {
			swarms: {
				alpha: {
					agents: {
						reviewer: {
							fallback_models: ['openai/alpha-fallback'],
						},
					},
				},
				beta: {
					agents: {
						reviewer: {
							fallback_models: [
								'malformed',
								'anthropic/beta-fallback-1',
								'openai/beta-fallback-2',
							],
						},
						critic_finding_validator: {
							fallback_models: ['invalid', 'opencode/beta-validator-fallback'],
						},
					},
				},
			},
		};
		const reviewAgentModelRegistry = captureReviewAgentModelRegistry(
			pluginConfig,
			Object.keys(multiAgents),
		);

		await handleReviewCommand({
			directory: '/repo',
			args: ['--working-tree'],
			sessionID: 'session-beta',
			activeAgentName: 'beta_architect',
			agents: multiAgents,
			reviewModelDispatcher: {
				dispatch: async () => Promise.reject('not called'),
			},
			autoReviewConfig: resolveAutoReviewConfig({
				enabled: false,
				validate_findings: true,
			}),
			reviewAgentModelRegistry,
		});

		expect(captured?.reviewerAgent).toBe('beta_reviewer');
		expect(captured?.validatorAgent).toBe('beta_critic_finding_validator');
		// Previous resolution returned a configuration error before manual
		// review reached the shared engine.
		expect(captured?.reviewerFallbackModels).toEqual([
			{ providerID: 'anthropic', modelID: 'beta-fallback-1' },
			{ providerID: 'openai', modelID: 'beta-fallback-2' },
		]);
		expect(captured?.validatorFallbackModels).toEqual([
			{ providerID: 'opencode', modelID: 'beta-validator-fallback' },
		]);
	});

	test('rejects ambiguous, unsafe, and unknown arguments before dispatch', async () => {
		let calls = 0;
		_internals.runReviewEngine = async () => {
			calls++;
			return completedResult();
		};
		const base = {
			directory: '/repo',
			sessionID: 'session-review',
			agents: agents(),
			reviewModelDispatcher: {
				dispatch: async () => Promise.reject('not called'),
			},
		};

		for (const args of [
			['--base', '-unsafe'],
			['--base', 'main', '--working-tree'],
			['--range', 'main....feature'],
			['--unknown'],
		]) {
			const text = await handleReviewCommand({ ...base, args });
			expect(text).toContain('Review argument error');
			expect(text).toContain('Usage: /swarm review');
		}
		expect(calls).toBe(0);
	});

	test('reports a clear missing-runtime response', async () => {
		const text = await handleReviewCommand({
			directory: '/repo',
			args: [],
			sessionID: 'session-review',
			agents: agents(),
		});

		expect(text).toContain('Review runtime unavailable');
		expect(text).toContain('ReviewModelDispatcher');
		expect(text).toContain('active plugin session');
	});

	test('ranks findings and reports validation, anchor, scope, artifacts, cost, and calls', async () => {
		_internals.runReviewEngine = async () =>
			completedResult({
				scopeWarnings: [
					'Canonical diff was truncated; reviewing bounded file-list fallback.',
				],
				scopeFileList: ['src/critical.ts', 'src/medium.ts'],
				scopeFileListComplete: false,
			});
		_internals.readEvidence = () => evidence();

		const text = await handleReviewCommand({
			directory: '/repo',
			args: ['--base', 'origin/main'],
			sessionID: 'session-review',
			agents: agents(),
			reviewModelDispatcher: {
				dispatch: async () => Promise.reject('not called'),
			},
		});

		expect(text).toContain('## Swarm Review');
		expect(text).toContain('Scope: base origin/main');
		expect(text).toContain('complete');
		expect(text).toContain(
			'Receipt: /repo/.swarm/review-receipts/receipt.json',
		);
		expect(text).toContain(
			'Evidence: /repo/.swarm/evidence/auto-review/manual.json',
		);
		expect(text).toContain('Model calls: 2');
		expect(text).toContain('$0.012300');
		expect(text).toContain('120 input');
		expect(text.indexOf('Critical issue')).toBeLessThan(
			text.indexOf('Medium issue'),
		);
		expect(text).toContain('CONFIRMED');
		expect(text).toContain('anchored');
		expect(text).toContain('line is outside the changed hunk');
		expect(text).toContain('### Scope warnings (1)');
		expect(text).toContain('Canonical diff was truncated');
		expect(text).toContain(
			'### Scope files (2, fallback list may be incomplete)',
		);
		expect(text).toContain('src/critical.ts');
	});

	test('returns a bounded, tagged, parseable JSON wrapper', async () => {
		_internals.runReviewEngine = async () =>
			completedResult({
				scopeWarnings: Array.from(
					{ length: 24 },
					(_, index) => `scope-warning-${index}`,
				),
				scopeFileList: Array.from(
					{ length: 40 },
					(_, index) => `src/scope-file-${index}.ts`,
				),
				scopeFileListComplete: false,
				findings: Array.from({ length: 50 }, (_, index) => ({
					...completedResult().findings[0],
					finding_id: `finding-${index}`,
					title: `Finding ${index} ${'x'.repeat(10_000)}`,
					body: 'y'.repeat(10_000),
				})),
			});
		_internals.readEvidence = () => evidence();

		const text = await handleReviewCommand({
			directory: '/repo',
			args: ['--json', '--working-tree'],
			sessionID: 'session-review',
			agents: agents(),
			reviewModelDispatcher: {
				dispatch: async () => Promise.reject('not called'),
			},
		});

		expect(text.startsWith('[SWARM_REVIEW_JSON]\n')).toBe(true);
		expect(text.endsWith('\n[/SWARM_REVIEW_JSON]')).toBe(true);
		expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(
			_test_exports.MAX_JSON_WRAPPER_BYTES,
		);
		const payload = JSON.parse(text.split('\n').slice(1, -1).join('\n'));
		expect(payload.command).toBe('review');
		expect(payload.scope.selector).toEqual({
			kind: 'base',
			ref: 'origin/main',
		});
		expect(payload.scope.warnings).toHaveLength(20);
		expect(payload.scope.warnings_omitted).toBe(4);
		expect(payload.scope.file_list).toHaveLength(25);
		expect(payload.scope.file_list_complete).toBe(false);
		expect(payload.scope.files_omitted).toBe(15);
		expect(payload.findings[0].title.length).toBeLessThan(600);
	});

	test('is registered, discoverable, human-only, and receives DI through canonical dispatch', async () => {
		let captured: RunReviewEngineInput | undefined;
		_internals.runReviewEngine = async (input) => {
			captured = input;
			return completedResult({ findings: [] });
		};
		_internals.readEvidence = () => null;
		const dispatcher = { dispatch: async () => Promise.reject('not called') };
		const result = await executeSwarmCommand({
			directory: '/repo',
			agents: agents(),
			sessionID: 'session-review',
			tokens: ['review', '--working-tree'],
			reviewModelDispatcher: dispatcher,
			autoReviewConfig: resolveAutoReviewConfig({ enabled: false }),
		});

		// Review remains reachable from the human command surface, but the
		// swarm_command tool allowlist must not expose it to agents.
		expect(SWARM_COMMAND_TOOL_ALLOWLIST.has('review')).toBe(false);
		expect(result.canonicalKey).toBe('review');
		expect(result.text).toContain('Swarm Review');
		expect(captured?.dispatcher).toBe(dispatcher);
		expect(captured?.selector).toEqual({ kind: 'working-tree' });
	});
});
