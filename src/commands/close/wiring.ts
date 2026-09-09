import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { loadPluginConfigWithMeta } from '../../config';
import { finalizeContextTelemetry } from '../../context-map/telemetry.js';
import { finalizeCoreEventsForClose } from '../../events/core-events.js';
import { archiveEvidence } from '../../evidence/manager';
import {
	getGitRepositoryStatus,
	resetToMainAfterMerge,
	resetToRemoteBranch,
} from '../../git/branch';
import { runCuratorPostMortem } from '../../hooks/curator-postmortem';
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
import { _internals, closeReceiptLifecycleInternals } from './internals.js';

/** Wire concrete dependencies only after the close facade has loaded its stages. */
export function wireCloseInternals(): void {
	Object.assign(closeReceiptLifecycleInternals, {
		recordPhaseCloseIntent,
		reconcilePhaseClose,
	});
	Object.assign(_internals, {
		closeSnapshotCoordinationInitialization,
		closeRepoMemory,
		unlink: fs.unlink,
		unlinkSidecarSync: fsSync.unlinkSync,
		sleep,
		collectGarbageBestEffort,
		getGitRepositoryStatus,
		resetToMainAfterMerge,
		resetToRemoteBranch,
		loadPluginConfigWithMeta,
		curateAndStoreSwarm,
		checkHivePromotions,
		runCuratorPostMortem,
		resetSwarmStatePreservingSingletons,
		runFinalizeRewardSweep,
		archiveEvidence,
		endAgentSession,
		flushAndDrainTelemetry: async (): Promise<void> => {
			const { flushAndDrainTelemetry } = await import('../../telemetry.js');
			return flushAndDrainTelemetry();
		},
		finalizeContextTelemetry,
		finalizeCoreEvents: finalizeCoreEventsForClose,
	});
}
