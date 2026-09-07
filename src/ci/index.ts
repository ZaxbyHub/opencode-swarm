/**
 * Public surface of the host-decoupled advisory CI runtime (issue #2497).
 *
 * Single import point for downstream consumers — the composite GitHub
 * Action (#2498) and the read-only MCP verification surface (#2499) — and
 * for the `swarm ci` command handler (src/commands/ci.ts). Everything the
 * runtime exposes is re-exported here; nothing under src/ci/ is meant to be
 * imported by path from outside this directory.
 */

export {
	type AdvisoryCiGateRow,
	type AdvisoryCiGateStatus,
	type AdvisoryCiReport,
	type AdvisoryCiTaskEntry,
	type EvaluateAdvisoryCiOptions,
	evaluateAdvisoryCi,
	MAX_SHADOW_COPY_BYTES,
	TERMINAL_SUCCESS_STATES,
} from './evaluate.js';
export {
	CI_QUALITY_THRESHOLDS,
	computeEvidenceQualitySummary,
	type EvidenceQualitySummary,
} from './quality-checks.js';
export {
	renderFullReport,
	renderJsonBlock,
	renderMarkdownReport,
	SWARM_CI_JSON_CLOSE,
	SWARM_CI_JSON_OPEN,
} from './report.js';
export {
	type CiEvaluateContext,
	type CiRunEvent,
	type CiRunOutcome,
	type CiRunResult,
	type CiRuntimeOptions,
	MAX_CI_JOURNAL_EVENTS,
	runAdvisoryCiRuntime,
} from './runtime.js';
