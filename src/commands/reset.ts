import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetAutomationManager } from '../background/manager';
import { validateSwarmPath } from '../hooks/utils';
import {
	backupSwarmStateBeforeReset,
	type ResetBackupResult,
} from './reset-backup';

/**
 * _internals DI seam so tests can stub the pre-deletion backup without touching
 * the real filesystem-copy helper. Mutations are file-scoped and restorable in
 * afterEach.
 */
export const _internals: {
	backupSwarmStateBeforeReset: (
		directory: string,
		kind: 'reset' | 'reset-session',
		relEntries: string[],
	) => ResetBackupResult;
} = {
	backupSwarmStateBeforeReset,
};

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
	// NOTE: Uses synchronous fs calls (existsSync, unlinkSync, rmSync) intentionally.
	// reset is a single-pass synchronous cleanup path — no stage coordination needed.
	// close.ts uses async fs/promises for its multi-stage pipeline.

	const hasConfirm = args.includes('--confirm');

	if (!hasConfirm) {
		return [
			'## Swarm Reset',
			'',
			'⚠️ This will delete all swarm state from .swarm/ (plan, context, checkpoints, SWARM_PLAN artifacts including .swarm/plan-export/)',
			'',
			'A timestamped backup of the deleted state is saved to `.swarm/reset-backups/` automatically (restore by copying files back). Run `/swarm export` first if you also want a portable JSON snapshot.',
			'',
			'To confirm, run: `/swarm reset --confirm`',
		].join('\n');
	}

	// Individual files inside .swarm/ that are always safe to delete
	const filesToReset = [
		'plan.md',
		'plan.json',
		// Plan backing-state: a surviving ledger gets replayed by replayFromLedger()
		// on the next loadPlan(), resurrecting the wiped plan back into plan.json.
		'plan-ledger.jsonl',
		'context.md',
		// Single-session spec-drift state. spec-staleness.json is an existence-only
		// gate (enforceSpecDriftGate) that hard-blocks the core write tools
		// (save_plan, update_task_status, phase_complete, lean_turbo_run_phase,
		// lean_turbo_acquire_locks) — a survivor mis-routes or blocks the next session.
		'spec.md',
		'spec-staleness.json',
		'spec-snapshot.md',
		'SWARM_PLAN.md',
		'SWARM_PLAN.json',
		'plan-export/SWARM_PLAN.md',
		'plan-export/SWARM_PLAN.json',
		'checkpoints.json',
		'events.jsonl',
		// Per-attempt task outcomes keyed by plan task ID. Reset wipes the plan,
		// so a survivor would attribute the old plan's failures to the new plan's
		// identically-numbered tasks in the architect's injected run-memory block.
		'run-memory.jsonl',
		// Issue-trace per-issue receipts (issue #2131). They are issue-bound so a
		// survivor cannot mis-satisfy a new trace's gates, but reset clears them so
		// they do not accumulate across issues.
		'reproduction.json',
		'issue-publication.json',
	];
	const results: string[] = [];

	// Auto-backup the state we are about to delete BEFORE any deletion, so the
	// user can recover by copying files back (replaces the old "run /swarm export
	// first" manual-only safety). Fail-open: a backup failure never blocks reset.
	// #1692
	try {
		const backup = _internals.backupSwarmStateBeforeReset(directory, 'reset', [
			...filesToReset,
			'summaries',
		]);
		if (backup.backupDir && backup.copied.length > 0) {
			const rel = path.relative(directory, backup.backupDir);
			results.push(
				`- 📦 Backed up ${backup.copied.length} item(s) to ${rel}/ (restore by copying files back into .swarm/)`,
			);
		}
		for (const w of backup.warnings) {
			results.push(`- ⚠️ Backup warning: ${w}`);
		}
	} catch (err) {
		results.push(
			`- ⚠️ Auto-backup failed (continuing with reset): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

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
			// Justification: best-effort cleanup — deletion may fail for reasons
			// other than absence (permissions, concurrent lock, etc.). The file
			// was already skipped if it didn't exist; this catch records a
			// generic failure so the reset report reflects the partial result.
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
		} catch (err) {
			results.push(
				`- ❌ Failed to delete ${filename}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Stop background automation and reset in-memory queues
	try {
		resetAutomationManager();
		results.push(
			'- ✅ Stopped background automation (in-memory queues cleared)',
		);
	} catch {
		// Justification: best-effort — background automation may already be
		// stopped or never started. Failing open here keeps the reset path
		// usable even when the automation manager is in an unexpected state.
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
		// Justification: best-effort directory cleanup — summaries/ may be
		// locked or partially removed by an external process. Swallowing
		// keeps the reset path fail-open; the report already marks the failure.
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
