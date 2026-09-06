import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { redactDecisionLineForArchive } from '../../hooks/guardrails/audit-log.js';
import { finalizeShellAuditForClose } from '../../hooks/guardrails/shell-audit-store.js';
import {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	CLOSE_REFLECTION_TIMEOUT_MS,
	CLOSE_SKILL_REVIEW_TIMEOUT_MS,
} from './constants.js';

/** Narrow seam for receipt/plan ordering tests. Wired by the close facade. */
export const closeReceiptLifecycleInternals = {
	recordPhaseCloseIntent:
		undefined as unknown as typeof import('../../hooks/knowledge-receipt-ledger.js').recordPhaseCloseIntent,
	reconcilePhaseClose:
		undefined as unknown as typeof import('../../hooks/knowledge-receipt-ledger.js').reconcilePhaseClose,
};

/**
 * Canonical mutable close-command dependency seam.
 *
 * This module intentionally has no imports from the command, agent, state, or
 * hook graphs. The facade wires concrete implementations after all stage
 * modules have initialized, so a direct stage import cannot re-enter close.ts
 * through the command registry (FB-005/FB-006).
 */
export const _internals = {
	closeSnapshotCoordinationInitialization:
		undefined as unknown as typeof import('../../session/snapshot-coordination-init.js').closeSnapshotCoordinationInitialization,
	closeRepoMemory:
		undefined as unknown as typeof import('../../tools/repo-graph/indexed-storage.js').closeRepoMemory,
	unlinkActiveStateFileWithRetry:
		undefined as unknown as typeof import('./fs-helpers.js').unlinkActiveStateFileWithRetry,
	unlink: fs.unlink,
	unlinkSidecarSync: fsSync.unlinkSync,
	sleep:
		undefined as unknown as typeof import('../../utils/bun-compat.js').sleep,
	collectGarbageBestEffort:
		undefined as unknown as typeof import('../../utils/bun-compat.js').collectGarbageBestEffort,
	ACTIVE_STATE_DIRS_TO_CLEAN,
	countSessionKnowledgeEntries:
		undefined as unknown as typeof import('./finalize-stage.js').countSessionKnowledgeEntries,
	CLOSE_SKILL_REVIEW_TIMEOUT_MS,
	CLOSE_REFLECTION_TIMEOUT_MS,
	detectFullAuto:
		undefined as unknown as typeof import('./orchestrator.js').detectFullAuto,
	guaranteeAllPlansComplete:
		undefined as unknown as typeof import('./finalize-stage.js').guaranteeAllPlansComplete,
	getGitRepositoryStatus:
		undefined as unknown as typeof import('../../git/branch.js').getGitRepositoryStatus,
	resetToMainAfterMerge:
		undefined as unknown as typeof import('../../git/branch.js').resetToMainAfterMerge,
	resetToRemoteBranch:
		undefined as unknown as typeof import('../../git/branch.js').resetToRemoteBranch,
	copyDirRecursive:
		undefined as unknown as typeof import('./fs-helpers.js').copyDirRecursive,
	loadPluginConfigWithMeta:
		undefined as unknown as typeof import('../../config/index.js').loadPluginConfigWithMeta,
	curateAndStoreSwarm:
		undefined as unknown as typeof import('../../hooks/knowledge-curator.js').curateAndStoreSwarm,
	checkHivePromotions:
		undefined as unknown as typeof import('../../hooks/hive-promoter.js').checkHivePromotions,
	runCuratorPostMortem:
		undefined as unknown as typeof import('../../hooks/curator-postmortem.js').runCuratorPostMortem,
	createCuratorLLMDelegate:
		undefined as unknown as typeof import('../../hooks/curator-llm-factory.js').createCuratorLLMDelegate,
	resetSwarmStatePreservingSingletons:
		undefined as unknown as typeof import('../../state.js').resetSwarmStatePreservingSingletons,
	runFinalizeStage:
		undefined as unknown as typeof import('./finalize-stage.js').runFinalizeStage,
	runFinalizeRewardSweep:
		undefined as unknown as typeof import('../../memory/finalize-reward-sweep.js').runFinalizeRewardSweep,
	acquireFinalizeLock:
		undefined as unknown as typeof import('./orchestrator.js').acquireFinalizeLock,
	runArchiveStage:
		undefined as unknown as typeof import('./archive-stage.js').runArchiveStage,
	archiveCloseSummary:
		undefined as unknown as typeof import('./orchestrator.js').archiveCloseSummary,
	runArchiveEvidenceRetention:
		undefined as unknown as typeof import('./archive-stage.js').runArchiveEvidenceRetention,
	runCleanStage:
		undefined as unknown as typeof import('./clean-stage.js').runCleanStage,
	runAlignStage:
		undefined as unknown as typeof import('./align-stage.js').runAlignStage,
	runFinalizeDryRun:
		undefined as unknown as typeof import('./dry-run.js').runFinalizeDryRun,
	archiveEvidence:
		undefined as unknown as typeof import('../../evidence/manager.js').archiveEvidence,
	closePlanTerminalState:
		undefined as unknown as typeof import('./finalize-stage.js').reconcileCloseTerminalStateForPlan,
	endAgentSession:
		undefined as unknown as typeof import('../../state.js').endAgentSession,
	flushAndDrainTelemetry: undefined as unknown as () => Promise<void>,
	finalizeContextTelemetry:
		undefined as unknown as typeof import('../../context-map/telemetry.js').finalizeContextTelemetry,
	finalizeCoreEvents:
		undefined as unknown as typeof import('../../events/core-events.js').finalizeCoreEventsForClose,
	finalizeShellAudit: (directory: string): void => {
		finalizeShellAuditForClose(directory, {
			lineTransform: redactDecisionLineForArchive,
		});
	},
};
