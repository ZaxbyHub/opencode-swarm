import { runAlignStage } from './close/align-stage.js';
import {
	runArchiveEvidenceRetention,
	runArchiveStage,
} from './close/archive-stage.js';
import { runCleanStage } from './close/clean-stage.js';
import { runFinalizeDryRun } from './close/dry-run.js';
import {
	countSessionKnowledgeEntries,
	guaranteeAllPlansComplete,
	reconcileCloseTerminalStateForPlan,
	runFinalizeStage,
} from './close/finalize-stage.js';
import {
	copyDirRecursive,
	unlinkActiveStateFileWithRetry,
} from './close/fs-helpers.js';
import { _internals } from './close/internals.js';
import {
	acquireFinalizeLock,
	archiveCloseSummary,
	detectFullAuto,
} from './close/orchestrator.js';
import { wireCloseInternals } from './close/wiring.js';

Object.assign(_internals, {
	unlinkActiveStateFileWithRetry,
	countSessionKnowledgeEntries,
	detectFullAuto,
	guaranteeAllPlansComplete,
	copyDirRecursive,
	runFinalizeStage,
	acquireFinalizeLock,
	runArchiveStage,
	archiveCloseSummary,
	runArchiveEvidenceRetention,
	runCleanStage,
	runAlignStage,
	runFinalizeDryRun,
	closePlanTerminalState: reconcileCloseTerminalStateForPlan,
});
wireCloseInternals();

export { runAlignStage } from './close/align-stage.js';
export {
	emitCloseArchiveResult,
	runArchiveEvidenceRetention,
	runArchiveStage,
} from './close/archive-stage.js';
export { runCleanStage } from './close/clean-stage.js';
export {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	ACTIVE_STATE_TO_CLEAN,
	ARCHIVE_ARTIFACTS,
} from './close/constants.js';
export type {
	ArchiveAttempt,
	ArchiveRequiredness,
	ArchiveSourceDisposition,
	ArchiveStageContext,
	ArchiveValidation,
	ArtifactArchiveResult,
	CleanStageResult,
	CloseStageContext,
	GitAlignResult,
} from './close/context.js';
export { removeSqliteSidecarsAfterClose } from './close/db-helpers.js';
export { runFinalizeDryRun } from './close/dry-run.js';
export { runFinalizeStage } from './close/finalize-stage.js';
export {
	_internals,
	closeReceiptLifecycleInternals,
} from './close/internals.js';
export { handleCloseCommand } from './close/orchestrator.js';
