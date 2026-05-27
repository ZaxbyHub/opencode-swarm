/**
 * Tests for skill_improve tool.
 *
 * Covers:
 * - Disabled config: returns ran=false with reason
 * - Happy path: delegates to runSkillImprover when enabled
 * - Args passthrough: targets, mode, max_calls
 * - Error handling: when runSkillImprover throws
 * - _internals seam verification
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const zodStub = {
	parse: (v: unknown) => v,
	safeParse: (v: unknown) => ({ success: true as const, data: v }),
	parseAsync: async (v: unknown) => v,
};

const mockLoadPluginConfigWithMeta = mock(() => ({
	config: { skill_improver: { enabled: true } },
	meta: { source: 'test' },
}));

const mockRunSkillImprover = mock(async () => ({
	ran: true,
	proposals: [{ path: '.swarm/skill-improver/proposals/test.md' }],
}));

// Module-level mocks — must be before the tool import
mock.module('../../../src/config/index.ts', () => ({
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
	loadPluginConfig: mock(() => ({})),
	loadPluginConfigWithMetaAsync: mock(async () => ({
		config: {},
		meta: {},
	})),
	loadAgentPrompt: mock(() => ''),
	_internals: { loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta },
}));

mock.module('../../../src/config/schema.ts', () => ({
	SkillImproverConfigSchema: zodStub,
	PluginConfigSchema: zodStub,
	SwarmConfigSchema: zodStub,
	PipelineConfigSchema: zodStub,
	PhaseCompleteConfigSchema: zodStub,
	TurboConfigSchema: zodStub,
	LeanTurboConfigSchema: zodStub,
	StandardTurboConfigSchema: zodStub,
	LeanTurboStrategyConfigSchema: zodStub,
	MemoryConfigSchema: zodStub,
	AutomationConfigSchema: zodStub,
	AutomationCapabilitiesSchema: zodStub,
	AutomationModeSchema: zodStub,
	AgentOverrideConfigSchema: zodStub,
	GateConfigSchema: zodStub,
	GateFeatureSchema: zodStub,
	PlaceholderScanConfigSchema: zodStub,
	QualityBudgetConfigSchema: zodStub,
	SelfReviewConfigSchema: zodStub,
	KnowledgeConfigSchema: zodStub,
	KnowledgeApplicationConfigSchema: zodStub,
	CuratorConfigSchema: zodStub,
	SpecWriterConfigSchema: zodStub,
	SlopDetectorConfigSchema: zodStub,
	IncrementalVerifyConfigSchema: zodStub,
	CompactionConfigSchema: zodStub,
	PrmConfigSchema: zodStub,
	AuthorityConfigSchema: zodStub,
	AgentAuthorityRuleSchema: zodStub,
	CouncilConfigSchema: zodStub,
	GeneralCouncilConfigSchema: zodStub,
	ParallelizationConfigSchema: zodStub,
	isKnownCanonicalRole: () => false,
	getCanonicalAgentRole: (r: string) => r,
	resolveGeneratedAgentRole: (r: string) => r,
	stripKnownSwarmPrefix: (r: string) => r,
	resolveGuardrailsConfig: (c: any) => c,
	ToolFilterConfigSchema: zodStub,
	PlanCursorConfigSchema: zodStub,
	CheckpointConfigSchema: zodStub,
	WatchdogConfigSchema: zodStub,
	AdversarialDetectionConfigSchema: zodStub,
	AdversarialTestingConfigSchema: zodStub,
	IntegrationAnalysisConfigSchema: zodStub,
	DocsConfigSchema: zodStub,
	UIReviewConfigSchema: zodStub,
	CompactionAdvisoryConfigSchema: zodStub,
	LintConfigSchema: zodStub,
	SecretscanConfigSchema: zodStub,
	GuardrailsProfileSchema: zodStub,
	GuardrailsConfigSchema: zodStub,
	DEFAULT_AGENT_PROFILES: {},
	DEFAULT_ARCHITECT_PROFILE: {},
	HooksConfigSchema: zodStub,
	ScoringWeightsSchema: zodStub,
	DecisionDecaySchema: zodStub,
	TokenRatiosSchema: zodStub,
	ScoringConfigSchema: zodStub,
	ContextBudgetConfigSchema: zodStub,
	EvidenceConfigSchema: zodStub,
	SummaryConfigSchema: zodStub,
	ReviewPassesConfigSchema: zodStub,
	MigrationStatusSchema: zodStub,
	PhaseSchema: zodStub,
	PhaseStatusSchema: zodStub,
	PlanSchema: zodStub,
	TaskSchema: zodStub,
	TaskSizeSchema: zodStub,
	TaskStatusSchema: zodStub,
}));

mock.module('../../../src/services/skill-improver.js', () => ({
	runSkillImprover: mockRunSkillImprover,
}));

// Import AFTER mock.module so the tool resolves mocked deps
import { _internals } from '../../../src/tools/skill-improve';

const { skill_improve } = _internals;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mockLoadPluginConfigWithMeta.mockClear();
	mockRunSkillImprover.mockClear();

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'skill-improve-test-')),
	);
	originalCwd = process.cwd();
	process.chdir(tmp);
});

afterEach(async () => {
	process.chdir(originalCwd);
	try {
		await fs.rm(tmp, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

describe('skill_improve tool', () => {
	describe('disabled config', () => {
		it('returns ran=false when skill_improver is disabled', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: false } },
				meta: { source: 'test' },
			});
			const result = JSON.parse(await skill_improve.execute({}, tmp));
			expect(result.ran).toBe(false);
			expect(result.reason).toContain('disabled');
		});

		it('returns ran=false when skill_improver config is missing', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: {},
				meta: { source: 'test' },
			});
			const result = JSON.parse(await skill_improve.execute({}, tmp));
			expect(result.ran).toBe(false);
		});
	});

	describe('happy path', () => {
		it('delegates to runSkillImprover when enabled', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			const result = JSON.parse(
				await skill_improve.execute({}, {
					directory: tmp,
					sessionID: 'session-1',
				} as any),
			);
			expect(result.ran).toBe(true);
			expect(mockRunSkillImprover).toHaveBeenCalled();
		});

		it('passes targets to runSkillImprover', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			const targets = ['skills', 'knowledge'];
			await skill_improve.execute({ targets }, tmp);
			const callArgs = mockRunSkillImprover.mock.calls[0][0];
			expect(callArgs.targets).toEqual(targets);
		});

		it('passes mode to runSkillImprover', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			await skill_improve.execute({ mode: 'draft_skills' }, tmp);
			const callArgs = mockRunSkillImprover.mock.calls[0][0];
			expect(callArgs.mode).toBe('draft_skills');
		});

		it('passes max_calls to runSkillImprover', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			await skill_improve.execute({ max_calls: 5 }, tmp);
			const callArgs = mockRunSkillImprover.mock.calls[0][0];
			expect(callArgs.maxCalls).toBe(5);
		});

		it('passes config from loadPluginConfigWithMeta', async () => {
			const config = { enabled: true, max_calls_per_day: 20 };
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: config },
				meta: { source: 'test' },
			});
			await skill_improve.execute({}, tmp);
			const callArgs = mockRunSkillImprover.mock.calls[0][0];
			expect(callArgs.config).toBe(config);
		});

		it('handles null args gracefully', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			const result = JSON.parse(await skill_improve.execute(null as any, tmp));
			expect(result.ran).toBe(true);
		});
	});

	describe('error handling', () => {
		it('returns error JSON when runSkillImprover throws', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('quota exceeded'));
			const result = JSON.parse(await skill_improve.execute({}, tmp));
			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('execution_error');
		});

		it('returns error JSON when loadPluginConfigWithMeta throws', async () => {
			mockLoadPluginConfigWithMeta.mockImplementationOnce(() => {
				throw new Error('config load failed');
			});
			const result = JSON.parse(await skill_improve.execute({}, tmp));
			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('execution_error');
		});
	});

	describe('_internals seam', () => {
		it('exposes skill_improve via _internals', () => {
			expect(_internals.skill_improve).toBeDefined();
			expect(typeof _internals.skill_improve.execute).toBe('function');
		});
	});

	describe('ADVERSARIAL: malformed inputs and boundary violations', () => {
		it('rejects max_calls below 1', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_improve.execute({ max_calls: 0 }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects max_calls above 100', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_improve.execute({ max_calls: 101 }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects negative max_calls', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_improve.execute({ max_calls: -5 }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects max_calls as non-integer', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_improve.execute({ max_calls: 3.14 }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects invalid target value in array', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('invalid target'));
			const result = JSON.parse(
				await skill_improve.execute(
					{ targets: ['skills', 'invalid'] as any },
					tmp,
				),
			);
			expect(result.success).toBe(false);
		});

		it('rejects targets as non-array', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_improve.execute({ targets: 'skills' as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects invalid mode value', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('invalid mode'));
			const result = JSON.parse(
				await skill_improve.execute({ mode: 'delete' as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects mode as number', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_improve.execute({ mode: 1 as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects args with __proto__ pollution', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const pollutedArgs = { __proto__: { admin: true }, max_calls: 5 };
			const result = JSON.parse(
				await skill_improve.execute(pollutedArgs as any, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects args with constructor.prototype pollution', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const pollutedArgs = {
				constructor: { prototype: { admin: true } },
				max_calls: 5,
			};
			const result = JSON.parse(
				await skill_improve.execute(pollutedArgs as any, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects targets array with non-string elements', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_improve.execute(
					{ targets: ['skills', 123, null] as any },
					tmp,
				),
			);
			expect(result.success).toBe(false);
		});

		it('rejects very large targets array (>= 100 items)', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('too many targets'));
			const manyTargets = Array(101).fill('skills');
			const result = JSON.parse(
				await skill_improve.execute({ targets: manyTargets as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects max_calls as Infinity', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_improve.execute({ max_calls: Infinity }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects max_calls as NaN', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_improve.execute({ max_calls: NaN }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects max_calls as string', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('type error'));
			const result = JSON.parse(
				await skill_improve.execute({ max_calls: '5' as any }, tmp),
			);
			expect(result.success).toBe(false);
		});

		it('rejects empty targets array', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(
				await skill_improve.execute({ targets: [] }, tmp),
			);
			expect(result.success).toBe(false);
		});
	});
});
