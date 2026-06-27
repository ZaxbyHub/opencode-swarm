/**
 * Checkpoint artifact writer.
 * Writes SWARM_PLAN.md and SWARM_PLAN.json inside .swarm/plan-export/.
 * Export-only — not a live runtime source of truth.
 * Called on: save_plan, phase completion, /swarm close.
 * NOT called on every task update.
 */
import * as fs from 'node:fs';

// _internals DI seam — allows tests to mock fs operations without mock.module pollution
export const _fsInternals = {
	mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) =>
		fs.mkdirSync(...args),
	writeFileSync: (path: string, data: string, encoding?: BufferEncoding) =>
		fs.writeFileSync(path, data, encoding ?? 'utf8'),
	readFileSync: (path: string, encoding?: BufferEncoding) =>
		fs.readFileSync(path, encoding ?? 'utf8'),
	existsSync: (path: string) => fs.existsSync(path),
};

import * as path from 'node:path';
import { type Plan, PlanSchema } from '../config/plan-schema';
import { appendLedgerEvent } from '../plan/ledger';
import { derivePlanId } from '../plan/utils.js';
import {
	derivePlanMarkdown,
	loadPlan,
	savePlanWithAutoAcknowledgedRemovals,
} from './manager';

/**
 * Write SWARM_PLAN.json and SWARM_PLAN.md inside the .swarm/plan-export/ directory under the project root.
 * Non-blocking: logs a warning on failure but never throws.
 * @param directory - The working directory (project root)
 */
export async function writeCheckpoint(directory: string): Promise<void> {
	try {
		const plan = await loadPlan(directory);
		if (!plan) return;

		const exportDir = path.join(directory, '.swarm', 'plan-export');
		_fsInternals.mkdirSync(exportDir, { recursive: true });
		const jsonPath = path.join(exportDir, 'SWARM_PLAN.json');
		const mdPath = path.join(exportDir, 'SWARM_PLAN.md');

		// Write JSON checkpoint
		_fsInternals.writeFileSync(jsonPath, JSON.stringify(plan, null, 2));

		// Write Markdown checkpoint
		const md = derivePlanMarkdown(plan);
		const header = `<!--
AUTO-GENERATED EXPORT/CHECKPOINT SNAPSHOT — DO NOT EDIT
This file is NOT the live plan. It is a derived export artifact.
- .swarm/plan-ledger.jsonl is the authoritative source of plan state.
- .swarm/plan.json and .swarm/plan.md are derived projections.
Regenerated on: save_plan and phase_complete.
-->
`;
		_fsInternals.writeFileSync(mdPath, header + md);
	} catch (error) {
		// Non-blocking: checkpoint failure must never break the calling operation
		console.warn(
			`[checkpoint] Failed to write SWARM_PLAN checkpoint: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Result of an importCheckpoint operation.
 */
export interface ImportCheckpointResult {
	success: boolean;
	plan?: Plan;
	error?: string;
}

/**
 * Import a checkpoint from .swarm/plan-export/SWARM_PLAN.json (with backward-compat fallback to .swarm/ and project root).
 * Validates the checkpoint against PlanSchema, persists it as the live plan
 * via savePlan, and appends a 'plan_rebuilt' ledger event.
 *
 * @param directory - The working directory (project root)
 * @param source - Optional source identifier for the ledger event (defaults to 'external_reseed')
 * @returns ImportCheckpointResult indicating success or failure with error message
 */
export async function importCheckpoint(
	directory: string,
	source?: string,
): Promise<ImportCheckpointResult> {
	try {
		const exportPath = path.join(
			directory,
			'.swarm',
			'plan-export',
			'SWARM_PLAN.json',
		);
		const swarmDirPath = path.join(directory, '.swarm', 'SWARM_PLAN.json');
		const rootPath = path.join(directory, 'SWARM_PLAN.json');
		let checkpointPath: string;
		let rawContent: string;
		if (_fsInternals.existsSync(exportPath)) {
			checkpointPath = exportPath;
			rawContent = _fsInternals.readFileSync(checkpointPath);
		} else if (_fsInternals.existsSync(swarmDirPath)) {
			checkpointPath = swarmDirPath;
			rawContent = _fsInternals.readFileSync(checkpointPath);
			console.warn(
				'[checkpoint] importCheckpoint: using legacy flat .swarm/SWARM_PLAN.json. This location is deprecated and will be removed in a future version. Run /swarm close to migrate.',
			);
		} else if (_fsInternals.existsSync(rootPath)) {
			checkpointPath = rootPath;
			rawContent = _fsInternals.readFileSync(checkpointPath);
			console.warn(
				'[checkpoint] importCheckpoint: using legacy root-level SWARM_PLAN.json. Consider running /swarm close to migrate.',
			);
		} else {
			return {
				success: false,
				error:
					'SWARM_PLAN.json not found in .swarm/plan-export/, .swarm/, or project root',
			};
		}
		const parsed = JSON.parse(rawContent);
		const plan = PlanSchema.parse(parsed) as Plan;

		await savePlanWithAutoAcknowledgedRemovals(
			directory,
			plan,
			'import_checkpoint',
			'import external checkpoint',
		);

		await appendLedgerEvent(directory, {
			event_type: 'plan_rebuilt',
			source: source ?? 'external_reseed',
			plan_id: derivePlanId(plan),
		});

		return { success: true, plan };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals = {
	writeCheckpoint,
	importCheckpoint,
};
