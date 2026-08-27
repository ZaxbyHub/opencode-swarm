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

const approvalRequestFixture = {
	targetSessionId: 'session-1',
	action: 'skill_improve' as const,
	candidateId: 'skill_improve_request',
	candidateContentHash: 'a'.repeat(64),
	allowedPathDigest: 'b'.repeat(64),
	generation: 0,
};

const mockRunSkillImprover = mock(async () => ({
	ran: true,
	proposals: [{ path: '.swarm/skill-improver/proposals/test.md' }],
}));
const mockPrepareApprovedSkillImproverCandidateWrite = mock(async () => ({
	kind: 'prepared' as const,
	prepared: {
		directory: 'ignored',
		now: new Date('2026-08-26T12:00:00.000Z'),
		source: 'deterministic_fallback' as const,
		model: 'opencode/big-pickle',
		proposalPath: '.swarm/skill-improver/proposals/test.md',
		allowedPaths: ['.swarm/skill-improver/proposals/test.md'],
		candidateContent: '# Skill Improvement Proposal',
		request: approvalRequestFixture,
		quota: {
			date: '2026-08-26',
			calls_used: 1,
			max_calls: 3,
		},
		quotaWindow: 'utc' as const,
		maxCalls: 1,
		maxCallsPerDay: 3,
		released: false,
	},
}));
const mockReleasePreparedSkillImproverApprovalCandidate = mock(async () => ({
	date: '2026-08-26',
	calls_used: 0,
	max_calls: 3,
}));
const mockWriteApprovedSkillImproverCandidate = mock(async () => ({
	ran: true,
	proposalPath: '.swarm/skill-improver/proposals/test.md',
	source: 'deterministic_fallback',
	quota: { date: '2026-08-26', calls_used: 1, max_calls: 3 },
}));
const mockFindWriteApprovalFact = mock(async () => null);

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
	GATE_CONFIG_KNOWN_SECTION_KEYS: {},
}));

mock.module('../../../src/services/skill-improver.js', () => ({
	runSkillImprover: mockRunSkillImprover,
	prepareApprovedSkillImproverCandidateWrite:
		mockPrepareApprovedSkillImproverCandidateWrite,
	writeApprovedSkillImproverCandidate: mockWriteApprovedSkillImproverCandidate,
}));

// Import AFTER mock.module so the tool resolves mocked deps
import { _internals } from '../../../src/tools/skill-improve';

const { skill_improve } = _internals;
const originalWriteAuthorityDependencies = {
	..._internals.writeAuthorityDependencies,
};

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	mockLoadPluginConfigWithMeta.mockClear();
	mockRunSkillImprover.mockClear();
	mockPrepareApprovedSkillImproverCandidateWrite.mockClear();
	mockReleasePreparedSkillImproverApprovalCandidate.mockClear();
	mockWriteApprovedSkillImproverCandidate.mockClear();
	mockFindWriteApprovalFact.mockClear();
	Object.assign(_internals.writeAuthorityDependencies, {
		findWriteApprovalFact: mockFindWriteApprovalFact,
		formatApproveWriteCommand: (request: {
			targetSessionId: string;
			action: string;
			candidateId: string;
			candidateContentHash: string;
		}) =>
			`/swarm approve-write ${request.targetSessionId} ${request.action} ${request.candidateId} ${request.candidateContentHash}`,
	});

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'skill-improve-test-')),
	);
	originalCwd = process.cwd();
	process.chdir(tmp);
});

afterEach(async () => {
	Object.assign(
		_internals.writeAuthorityDependencies,
		originalWriteAuthorityDependencies,
	);
	process.chdir(originalCwd);
	try {
		await fs.rm(tmp, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
	mock.restore();
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

		it('returns an approval challenge when require_user_approval is enabled and no fact is available', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: {
					skill_improver: { enabled: true, require_user_approval: true },
				},
				meta: { source: 'test' },
			});
			mockRunSkillImprover.mockResolvedValueOnce({
				ran: false,
				reason: 'skill_improver requires an exact human write approval',
				quota: { date: '2026-08-26', calls_used: 1, max_calls: 3 },
				approvalRequired: {
					request: approvalRequestFixture,
					candidateContent: '# Skill Improvement Proposal',
					candidateContentChars: 28,
					candidateContentTokenEstimate: 7,
					allowedPaths: ['.swarm/skill-improver/proposals/test.md'],
				},
				source: 'deterministic_fallback',
				model: 'opencode/big-pickle',
			});
			const result = JSON.parse(
				await skill_improve.execute({}, {
					directory: tmp,
					sessionID: 'session-1',
				} as any),
			);
			expect(result.ran).toBe(false);
			expect(result.approvalRequired.command).toContain('/swarm approve-write');
			expect(result.approvalRequired.allowedPaths).toEqual([
				'.swarm/skill-improver/proposals/test.md',
			]);
			expect(mockRunSkillImprover).toHaveBeenCalledTimes(1);
			expect(
				mockPrepareApprovedSkillImproverCandidateWrite,
			).not.toHaveBeenCalled();
		});

		it('checks for a matching write approval fact and writes the prepared candidate', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: {
					skill_improver: { enabled: true, require_user_approval: true },
				},
				meta: { source: 'test' },
			});
			mockFindWriteApprovalFact.mockResolvedValueOnce({
				v: 1,
				id: 'waf_1',
				issuingSessionId: 'human-session',
				issuedByCommand: 'approve-write',
				issuedAt: '2026-08-26T12:00:00.000Z',
				expiresAt: '2026-08-26T12:30:00.000Z',
				...approvalRequestFixture,
			});
			const result = JSON.parse(
				await skill_improve.execute(
					{ approved_candidate_content: '# Skill Improvement Proposal' },
					{
						directory: tmp,
						sessionID: 'session-1',
					} as any,
				),
			);
			expect(result.ran).toBe(true);
			expect(mockFindWriteApprovalFact).toHaveBeenCalledTimes(1);
			expect(mockWriteApprovedSkillImproverCandidate).toHaveBeenCalledTimes(1);
			expect(mockRunSkillImprover).not.toHaveBeenCalled();
			expect(
				mockPrepareApprovedSkillImproverCandidateWrite,
			).toHaveBeenCalledTimes(1);
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

		it('passes evaluate as evaluateDrafts to runSkillImprover', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: { skill_improver: { enabled: true } },
				meta: { source: 'test' },
			});
			await skill_improve.execute({ evaluate: true }, tmp);
			const callArgs = mockRunSkillImprover.mock.calls[0][0];
			expect(callArgs.evaluateDrafts).toBe(true);
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

		it('passes knowledge enrichment quota to runSkillImprover', async () => {
			mockLoadPluginConfigWithMeta.mockReturnValueOnce({
				config: {
					skill_improver: { enabled: true },
					knowledge: {
						enrichment: { max_calls_per_day: 7, quota_window: 'local' },
					},
				},
				meta: { source: 'test' },
			});
			await skill_improve.execute({}, tmp);
			const callArgs = mockRunSkillImprover.mock.calls[0][0];
			expect(callArgs.enrichmentQuota).toEqual({
				maxCalls: 7,
				window: 'local',
			});
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
});
