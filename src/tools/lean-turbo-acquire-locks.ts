/**
 * Lean Turbo Acquire Locks Tool.
 * Wraps acquireLaneLocks from src/parallel/file-locks.
 * Acquires file locks for all files in a lane (all-or-nothing).
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { acquireLaneLocks, type FileLock } from '../parallel/file-locks';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the lean_turbo_acquire_locks tool
 */
export interface LeanTurboAcquireLocksArgs {
	directory: string;
	laneId: string;
	files: string[];
	agent: string;
	taskId: string;
	sessionID: string;
}

/**
 * Result from executing lean_turbo_acquire_locks
 */
export interface LeanTurboAcquireLocksResult {
	success: boolean;
	locks?: FileLock[];
	conflicts?: string[];
	errors?: string[];
}

/**
 * Execute the lean_turbo_acquire_locks tool.
 * Acquires locks for all files in a lane (all-or-nothing).
 */
export async function executeLeanTurboAcquireLocks(
	args: LeanTurboAcquireLocksArgs,
): Promise<LeanTurboAcquireLocksResult> {
	const { directory, laneId, files, agent, taskId, sessionID } = args;

	try {
		const result = await acquireLaneLocks(
			directory,
			laneId,
			files,
			agent,
			taskId,
			sessionID,
		);

		if (result.acquired) {
			return {
				success: true,
				locks: result.locks,
			};
		} else {
			return {
				success: false,
				conflicts: result.conflicts,
			};
		}
	} catch (error) {
		return {
			success: false,
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
}

/**
 * Tool definition for lean_turbo_acquire_locks
 */
export const lean_turbo_acquire_locks: ToolDefinition = createSwarmTool({
	description:
		'Acquire file locks for all files in a lane (all-or-nothing). ' +
		'Wraps acquireLaneLocks from src/parallel/file-locks. ' +
		'If any file is already locked, releases all previously acquired locks.',
	args: {
		directory: z.string().describe('Project root directory'),
		laneId: z.string().describe('Unique lane identifier (e.g., "lane-1")'),
		files: z
			.array(z.string().min(1))
			.min(1)
			.describe('Array of file paths to lock'),
		agent: z.string().describe('Agent name acquiring the locks'),
		taskId: z.string().describe('Task ID (e.g., "4.1")'),
		sessionID: z.string().describe('Session ID for the Lean Turbo run'),
	},
	execute: async (args: unknown, _directory: string) => {
		const parsed = args as LeanTurboAcquireLocksArgs;
		// Use _directory from tool context for .swarm containment (invariant #4)
		return JSON.stringify(
			await executeLeanTurboAcquireLocks({ ...parsed, directory: _directory }),
			null,
			2,
		);
	},
});
