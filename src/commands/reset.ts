import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetAutomationManager } from '../background/manager';
import { validateSwarmPath } from '../hooks/utils';

/**
 * Handles the /swarm reset command.
 * Clears all swarm state files from .swarm/ and project root.
 * Stops background automation and resets in-memory queues.
 * Requires --confirm flag as a safety gate.
 */
export async function handleResetCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const hasConfirm = args.includes('--confirm');

	if (!hasConfirm) {
		return [
			'## Swarm Reset',
			'',
			'⚠️ This will delete all swarm state from .swarm/ (plan, context, checkpoints, SWARM_PLAN artifacts)',
			'',
			'**Tip**: Run `/swarm export` first to backup your state.',
			'',
			'To confirm, run: `/swarm reset --confirm`',
		].join('\n');
	}

	// Individual files inside .swarm/ that are always safe to delete
	const filesToReset = [
		'plan.md',
		'plan.json',
		'context.md',
		'SWARM_PLAN.md',
		'SWARM_PLAN.json',
		'checkpoints.json',
		'events.jsonl',
	];
	const results: string[] = [];

	for (const filename of filesToReset) {
		try {
			const resolvedPath = validateSwarmPath(directory, filename);
			if (fs.existsSync(resolvedPath)) {
				fs.unlinkSync(resolvedPath);
				results.push(`- ✅ Deleted ${filename}`);
			} else {
				results.push(`- ⏭️ ${filename} not found (skipped)`);
			}
		} catch {
			results.push(`- ❌ Failed to delete ${filename}`);
		}
	}

	// Also clean up legacy root-level SWARM_PLAN artifacts (pre-v7.x sessions)
	for (const filename of ['SWARM_PLAN.md', 'SWARM_PLAN.json']) {
		try {
			const rootPath = path.join(directory, filename);
			if (fs.existsSync(rootPath)) {
				fs.unlinkSync(rootPath);
				results.push(`- ✅ Deleted ${filename} (root)`);
			}
		} catch {
			// Non-fatal: root-level cleanup is best-effort
		}
	}

	// Stop background automation and reset in-memory queues
	try {
		resetAutomationManager();
		results.push(
			'- ✅ Stopped background automation (in-memory queues cleared)',
		);
	} catch {
		results.push('- ⏭️ Background automation not running (skipped)');
	}

	// Clean up summaries directory
	try {
		const summariesPath = validateSwarmPath(directory, 'summaries');
		if (fs.existsSync(summariesPath)) {
			fs.rmSync(summariesPath, { recursive: true, force: true });
			results.push('- ✅ Deleted summaries/ directory');
		} else {
			results.push('- ⏭️ summaries/ not found (skipped)');
		}
	} catch {
		results.push('- ❌ Failed to delete summaries/');
	}

	return [
		'## Swarm Reset Complete',
		'',
		...results,
		'',
		'Swarm state has been cleared. Start fresh with a new plan.',
	].join('\n');
}
