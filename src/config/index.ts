export type {
	AgentName,
	PipelineAgentName,
	QAAgentName,
} from './constants';
export {
	ALL_AGENT_NAMES,
	ALL_SUBAGENT_NAMES,
	DEFAULT_MODELS,
	isQAAgent,
	isSubagent,
	ORCHESTRATOR_NAME,
	PIPELINE_AGENTS,
	QA_AGENTS,
} from './constants';
export type {
	ApprovalEvidence,
	BaseEvidence,
	DiffEvidence,
	Evidence,
	EvidenceBundle,
	EvidenceType,
	EvidenceVerdict,
	NoteEvidence,
	ReviewEvidence,
	TestEvidence,
} from './evidence-schema';
export {
	ApprovalEvidenceSchema,
	BaseEvidenceSchema,
	DiffEvidenceSchema,
	EVIDENCE_MAX_JSON_BYTES,
	EVIDENCE_MAX_PATCH_BYTES,
	EVIDENCE_MAX_TASK_BYTES,
	EvidenceBundleSchema,
	EvidenceSchema,
	EvidenceTypeSchema,
	EvidenceVerdictSchema,
	NoteEvidenceSchema,
	ReviewEvidenceSchema,
	TestEvidenceSchema,
} from './evidence-schema';

// Re-export loaders for DI seam
export {
	loadAgentPrompt,
	loadPluginConfig,
	loadPluginConfigWithMeta,
	loadPluginConfigWithMetaAsync,
} from './loader';

// Import for local use (required for _internals)
import { loadPluginConfigWithMeta } from './loader';

/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`
 * for the rationale (`mock.module` from `bun:test` leaks across files in
 * Bun's shared test-runner process). Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 *
 * Note: functions are re-exported from ./loader so tests mocking index.js
 * can substitute at this level without touching the loader module directly.
 */
export const _internals: {
	loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
} = { loadPluginConfigWithMeta };
export type {
	MigrationStatus,
	Phase,
	PhaseStatus,
	Plan,
	Task,
	TaskSize,
	TaskStatus,
} from './plan-schema';
export {
	MigrationStatusSchema,
	PhaseSchema,
	PhaseStatusSchema,
	PlanSchema,
	TaskSchema,
	TaskSizeSchema,
	TaskStatusSchema,
} from './plan-schema';
export type {
	AgentOverrideConfig,
	AutomationCapabilities,
	AutomationConfig,
	AutomationMode,
	PhaseCompleteConfig,
	PipelineConfig,
	PluginConfig,
	SwarmConfig,
} from './schema';
export {
	AgentOverrideConfigSchema,
	AutomationCapabilitiesSchema,
	AutomationConfigSchema,
	AutomationModeSchema,
	PhaseCompleteConfigSchema,
	PipelineConfigSchema,
	PluginConfigSchema,
	SwarmConfigSchema,
} from './schema';
export type {
	DeltaSpec,
	Obligation,
	SpecDelta,
	SpecRequirement,
	SpecScenario,
	SpecSection,
	SwarmSpec,
} from './spec-schema';
export {
	DeltaSpecSchema,
	ObligationSchema,
	SpecDeltaSchema,
	SpecRequirementSchema,
	SpecScenarioSchema,
	SpecSectionSchema,
	SwarmSpecSchema,
	validateSpecContent,
} from './spec-schema';
