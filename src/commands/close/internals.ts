import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { loadPluginConfigWithMeta } from '../../config';
import { finalizeContextTelemetry as finalizeContextTelemetryImpl } from '../../context-map/telemetry.js';
import { finalizeCoreEventsForClose as finalizeCoreEventsForCloseImpl } from '../../events/core-events.js';
import { archiveEvidence } from '../../evidence/manager';
import {
	getGitRepositoryStatus,
	resetToMainAfterMerge,
	resetToRemoteBranch,
} from '../../git/branch';
import { createCuratorLLMDelegate } from '../../hooks/curator-llm-factory';
import { runCuratorPostMortem } from '../../hooks/curator-postmortem';
import { redactDecisionLineForArchive } from '../../hooks/guardrails/audit-log.js';
import { finalizeShellAuditForClose as finalizeShellAuditForCloseImpl } from '../../hooks/guardrails/shell-audit-store.js';
import { checkHivePromotions } from '../../hooks/hive-promoter';
import { curateAndStoreSwarm } from '../../hooks/knowledge-curator';
import {
	reconcilePhaseClose,
	recordPhaseCloseIntent,
} from '../../hooks/knowledge-receipt-ledger.js';
import { runFinalizeRewardSweep } from '../../memory/finalize-reward-sweep';
import { closeSnapshotCoordinationInitialization } from '../../session/snapshot-coordination-init.js';
import {
	endAgentSession,
	resetSwarmStatePreservingSingletons,
} from '../../state';
import { closeRepoMemory } from '../../tools/repo-graph/indexed-storage';
import { collectGarbageBestEffort, sleep } from '../../utils/bun-compat.js';
import {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	CLOSE_REFLECTION_TIMEOUT_MS,
	CLOSE_SKILL_REVIEW_TIMEOUT_MS,
} from './constants.js';

/** Narrow seam for receipt/plan ordering tests. */
export const closeReceiptLifecycleInternals = {
	recordPhaseCloseIntent,
	reconcilePhaseClose,
};

/**
 * Canonical mutable close-command dependency seam.
 *
 * Stage modules read this object at call sites. The facade fills the local
 * function references synchronously after module initialization, preserving
 * the historical object identity without introducing a stage-to-facade cycle.
 */
export const _internals = {
	closeSnapshotCoordinationInitialization,
	closeRepoMemory,
	unlinkActiveStateFileWithRetry:
		undefined as unknown as typeof import('./fs-helpers.js').unlinkActiveStateFileWithRetry,
	unlink: fs.unlink,
	unlinkSidecarSync: fsSync.unlinkSync,
	sleep,
	collectGarbageBestEffort,
	ACTIVE_STATE_DIRS_TO_CLEAN,
	countSessionKnowledgeEntries:
		undefined as unknown as typeof import('./finalize-stage.js').countSessionKnowledgeEntries,
	CLOSE_SKILL_REVIEW_TIMEOUT_MS,
	CLOSE_REFLECTION_TIMEOUT_MS,
	detectFullAuto:
		undefined as unknown as typeof import('./orchestrator.js').detectFullAuto,
	guaranteeAllPlansComplete:
		undefined as unknown as typeof import('./finalize-stage.js').guaranteeAllPlansComplete,
	getGitRepositoryStatus,
	resetToMainAfterMerge,
	resetToRemoteBranch,
	copyDirRecursive:
		undefined as unknown as typeof import('./fs-helpers.js').copyDirRecursive,
	loadPluginConfigWithMeta,
	curateAndStoreSwarm,
	checkHivePromotions,
	runCuratorPostMortem,
	createCuratorLLMDelegate,
	resetSwarmStatePreservingSingletons,
	runFinalizeStage:
		undefined as unknown as typeof import('./finalize-stage.js').runFinalizeStage,
	runFinalizeRewardSweep,
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
	archiveEvidence,
	closePlanTerminalState:
		undefined as unknown as typeof import('./finalize-stage.js').reconcileCloseTerminalStateForPlan,
	endAgentSession,
	flushAndDrainTelemetry: async (): Promise<void> => {
		const { flushAndDrainTelemetry } = await import('../../telemetry.js');
		return flushAndDrainTelemetry();
	},
	finalizeContextTelemetry: (directory: string): void => {
		finalizeContextTelemetryImpl(directory);
	},
	finalizeCoreEvents: (directory: string): void => {
		finalizeCoreEventsForCloseImpl(directory);
	},
	finalizeShellAudit: (directory: string): void => {
		finalizeShellAuditForCloseImpl(directory, {
			lineTransform: redactDecisionLineForArchive,
		});
	},
};
