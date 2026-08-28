/**
 * Adversarial validation for the skill_improve tool argument boundary.
 *
 * Kept separate from the core behavior suite so each test file remains below
 * the FR-006 500-line cap.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const zodStub = {
	parse: (value: unknown) => value,
	safeParse: (value: unknown) => ({ success: true as const, data: value }),
	parseAsync: async (value: unknown) => value,
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
	loadPluginConfigWithMetaAsync: mock(async () => ({ config: {}, meta: {} })),
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
	getCanonicalAgentRole: (role: string) => role,
	resolveGeneratedAgentRole: (role: string) => role,
	stripKnownSwarmPrefix: (role: string) => role,
	resolveGuardrailsConfig: (config: any) => config,
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
}));

import { _internals } from '../../../src/tools/skill-improve';

const { skill_improve } = _internals;
let tmp: string;

beforeEach(() => {
	mockLoadPluginConfigWithMeta.mockClear();
	mockRunSkillImprover.mockClear();
	tmp = canonicalMkdtemp('skill-improve-adversarial-');
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe('skill_improve adversarial argument boundaries', () => {
	const invalidCases: Array<[string, Record<string, unknown>]> = [
		['max_calls below 1', { max_calls: 0 }],
		['max_calls above 100', { max_calls: 101 }],
		['negative max_calls', { max_calls: -5 }],
		['non-integer max_calls', { max_calls: 3.14 }],
		['invalid target value', { targets: ['skills', 'invalid'] }],
		['targets as non-array', { targets: 'skills' }],
		['invalid mode value', { mode: 'delete' }],
		['mode as number', { mode: 1 }],
		['__proto__ pollution', { __proto__: { admin: true }, max_calls: 5 }],
		[
			'constructor.prototype pollution',
			{ constructor: { prototype: { admin: true } }, max_calls: 5 },
		],
		['targets with non-string elements', { targets: ['skills', 123, null] }],
		['too many targets', { targets: Array(101).fill('skills') }],
		['max_calls Infinity', { max_calls: Infinity }],
		['max_calls NaN', { max_calls: NaN }],
		['max_calls string', { max_calls: '5' }],
		['empty targets', { targets: [] }],
	];

	for (const [label, args] of invalidCases) {
		it('rejects ' + label, async () => {
			mockRunSkillImprover.mockRejectedValueOnce(new Error('validation error'));
			const result = JSON.parse(await skill_improve.execute(args as any, tmp));
			expect(result.success).toBe(false);
		});
	}
});
