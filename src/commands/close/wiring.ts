import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { loadPluginConfigWithMeta } from '../../config';
import { finalizeContextTelemetry } from '../../context-map/telemetry.js';
import { finalizeCoreEventsForClose } from '../../events/core-events.js';
import { archiveEvidence } from '../../evidence/manager';
import { resetToMainAfterMerge, resetToRemoteBranch } from '../../git/branch';
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
import { readGitRepositoryStatusDetailedAsync } from '../git-status-read.js';
import { guardResetWithRecheck } from './align-stage.js';
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
		// #3427: async, reader-backed repository probe (same result
		// vocabulary as the old sync branch.getGitRepositoryStatus install).
		getGitRepositoryStatus: readGitRepositoryStatusDetailedAsync,
		// #2953: install the guard as the seam value — every dispatch through
		// _internals.resetToMainAfterMerge re-verifies the confirmed
		// tracked-dirty scope immediately before the real aggressive reset.
		// Tests that replace this seam value capture the guard as their
		// `real`, so write-then-delegate injections stay observable to it.
		resetToMainAfterMerge: (
			cwd: string,
			options?: Parameters<typeof guardResetWithRecheck>[2],
		) => guardResetWithRecheck(resetToMainAfterMerge, cwd, options),
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
