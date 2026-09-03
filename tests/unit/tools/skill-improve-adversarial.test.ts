/**
 * Adversarial coverage for skill_improve tool.
 *
 * Split from skill-improve.test.ts to keep each test file under the FR-006
 * size cap while preserving the same mocked dependency seam.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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

mock.module('../../../src/config/index.ts', () => ({
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
	loadPluginConfig: mock(() => ({})),
	loadPluginConfigWithMetaAsync: mock(async () => ({
		config: {},
		meta: {},
	})),
	loadAgentPrompt: mock(() => ''),
	loadGateOverrides: mock(() => undefined),
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
	GATE_CONFIG_KNOWN_SECTION_KEYS: {},
}));

mock.module('../../../src/services/skill-improver.js', () => ({
	runSkillImprover: mockRunSkillImprover,
	prepareApprovedSkillImproverCandidateWrite: mock(async () => {
		throw new Error(
			'unexpected prepareApprovedSkillImproverCandidateWrite call',
		);
	}),
	writeApprovedSkillImproverCandidate: mock(async () => {
		throw new Error('unexpected writeApprovedSkillImproverCandidate call');
	}),
}));

import { _internals } from '../../../src/tools/skill-improve';

const { skill_improve } = _internals;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mockLoadPluginConfigWithMeta.mockClear();
	mockRunSkillImprover.mockClear();

	tmp = canonicalMkdtemp('skill-improve-adversarial-test-');
	originalCwd = process.cwd();
	process.chdir(tmp);
});

afterEach(async () => {
	process.chdir(originalCwd);
	try {
		await fs.rm(tmp, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors.
	}
	mock.restore();
});

describe('skill_improve tool adversarial validation', () => {
	const expectRejected = async (
		args: unknown,
		errorMessage: string,
		config: Record<string, unknown> = { enabled: true },
	) => {
		mockLoadPluginConfigWithMeta.mockReturnValueOnce({
			config: { skill_improver: config },
			meta: { source: 'test' },
		});
		mockRunSkillImprover.mockRejectedValueOnce(new Error(errorMessage));

		const result = JSON.parse(await skill_improve.execute(args, tmp));
		expect(result.success).toBe(false);
	};

	it('rejects max_calls below 1', async () => {
		await expectRejected({ max_calls: 0 }, 'validation error');
	});

	it('rejects max_calls above 100', async () => {
		await expectRejected({ max_calls: 101 }, 'validation error');
	});

	it('rejects negative max_calls', async () => {
		await expectRejected({ max_calls: -5 }, 'validation error');
	});

	it('rejects max_calls as non-integer', async () => {
		await expectRejected({ max_calls: 3.14 }, 'type error');
	});

	it('rejects invalid target value in array', async () => {
		await expectRejected(
			{ targets: ['skills', 'invalid'] as any },
			'invalid target',
		);
	});

	it('rejects targets as non-array', async () => {
		await expectRejected({ targets: 'skills' as any }, 'type error');
	});

	it('rejects invalid mode value', async () => {
		await expectRejected({ mode: 'delete' as any }, 'invalid mode');
	});

	it('rejects mode as number', async () => {
		await expectRejected({ mode: 1 as any }, 'type error');
	});

	it('rejects args with __proto__ pollution', async () => {
		const pollutedArgs = { __proto__: { admin: true }, max_calls: 5 };
		await expectRejected(pollutedArgs as any, 'validation error');
	});

	it('rejects args with constructor.prototype pollution', async () => {
		const pollutedArgs = {
			constructor: { prototype: { admin: true } },
			max_calls: 5,
		};
		await expectRejected(pollutedArgs as any, 'validation error');
	});

	it('rejects targets array with non-string elements', async () => {
		await expectRejected(
			{ targets: ['skills', 123, null] as any },
			'type error',
		);
	});

	it('rejects very large targets array (>= 100 items)', async () => {
		await expectRejected(
			{ targets: Array(101).fill('skills') as any },
			'too many targets',
		);
	});

	it('rejects max_calls as Infinity', async () => {
		await expectRejected({ max_calls: Infinity }, 'validation error');
	});

	it('rejects max_calls as NaN', async () => {
		await expectRejected({ max_calls: Number.NaN }, 'validation error');
	});

	it('rejects max_calls as string', async () => {
		await expectRejected({ max_calls: '5' as any }, 'type error');
	});

	it('rejects empty targets array', async () => {
		await expectRejected({ targets: [] }, 'validation error');
	});
});
