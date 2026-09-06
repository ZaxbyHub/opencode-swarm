import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetAutomationManager } from '../background/manager';
import { validateSwarmPath } from '../hooks/utils';
import { clearPlanLedgerForReset } from '../plan/ledger.js';
import { withPlanLifecycleLock } from '../plan/manager.js';
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
	clearPlanLedgerForReset: typeof clearPlanLedgerForReset;
	withPlanLifecycleLock: typeof withPlanLifecycleLock;
	existsSync: typeof fs.existsSync;
	readFileSync: typeof fs.readFileSync;
	unlinkSync: typeof fs.unlinkSync;
	writeFileSync: typeof fs.writeFileSync;
	rmSync: typeof fs.rmSync;
} = {
	backupSwarmStateBeforeReset,
	clearPlanLedgerForReset,
	withPlanLifecycleLock,
	existsSync: fs.existsSync,
	readFileSync: fs.readFileSync,
	unlinkSync: fs.unlinkSync,
	writeFileSync: fs.writeFileSync,
	rmSync: fs.rmSync,
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
		'events-authority-index.json',
		// Per-attempt task outcomes keyed by plan task ID. Reset wipes the plan,
		// so a survivor would attribute the old plan's failures to the new plan's
		// identically-numbered tasks in the architect's injected run-memory block.
		'run-memory.jsonl',
		// Issue-trace per-issue receipts (issue #2131). They are issue-bound so a
		// survivor cannot mis-satisfy a new trace's gates, but reset clears them so
		// they do not accumulate across issues.
		'reproduction.json',
		'issue-publication.json',
		'recurrence-sweep.json',
		'implementation-review.json',
	];
	const results: string[] = [];

	// Auto-backup the state we are about to delete BEFORE any deletion, so the
	// user can recover by copying files back (replaces the old "run /swarm export
	// first" manual-only safety). Fail-open: a backup failure never blocks reset.
	// #1692
	try {
		const backup = _internals.backupSwarmStateBeforeReset(directory, 'reset', [
			// The managed clear removes this portable ledger while holding the
			// plan-ledger lock; include it in the archive without deleting it again.
			'plan-ledger.jsonl',
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

	// The ledger is authoritative. Hold the same plan lock used by savePlan while
	// clearing authority and deleting every derived projection. The lifecycle
	// helper establishes the repository-wide order: plan.json lock, then ledger
	// lock inside clearPlanLedgerForReset. A concurrent save therefore cannot
	// publish a fresh projection between those two destructive steps.
	try {
		await _internals.withPlanLifecycleLock(
			directory,
			'reset-plan-lifecycle',
			async () => {
				const criticalProjectionNames = new Set(['plan.md', 'plan.json']);
				const criticalProjectionBytes = new Map<string, Buffer>();
				for (const filename of criticalProjectionNames) {
					const resolvedPath = validateSwarmPath(directory, filename);
					if (_internals.existsSync(resolvedPath)) {
						criticalProjectionBytes.set(
							filename,
							_internals.readFileSync(resolvedPath),
						);
					}
				}
				try {
					for (const filename of criticalProjectionNames) {
						const resolvedPath = validateSwarmPath(directory, filename);
						if (_internals.existsSync(resolvedPath))
							_internals.unlinkSync(resolvedPath);
					}
					await _internals.clearPlanLedgerForReset(directory);
				} catch (error) {
					for (const [filename, bytes] of criticalProjectionBytes) {
						try {
							_internals.writeFileSync(
								validateSwarmPath(directory, filename),
								bytes,
							);
						} catch {}
					}
					throw error;
				}
				results.push('- ✅ Cleared authoritative plan ledger');
				for (const filename of criticalProjectionNames) {
					results.push(
						criticalProjectionBytes.has(filename)
							? `- ✅ Deleted ${filename}`
							: `- ⏭️ ${filename} not found (skipped)`,
					);
				}

				for (const filename of filesToReset) {
					if (criticalProjectionNames.has(filename)) continue;
					try {
						const resolvedPath = validateSwarmPath(directory, filename);
						if (_internals.existsSync(resolvedPath)) {
							_internals.unlinkSync(resolvedPath);
							results.push(`- ✅ Deleted ${filename}`);
						} else {
							results.push(`- ⏭️ ${filename} not found (skipped)`);
						}
					} catch {
						results.push(`- ❌ Failed to delete ${filename}`);
					}
				}
			},
		);
	} catch (err) {
		results.push(
			`- ❌ Failed to clear authoritative plan ledger: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [
			'## Swarm Reset Aborted',
			'',
			...results,
			'',
			'The reset could not complete safely. Any deleted critical projections were restored best-effort and the authoritative ledger was preserved whenever projection cleanup failed. Resolve the reported filesystem or ledger error and retry /swarm reset --confirm.',
		].join('\n');
	}

	// Also clean up legacy root-level SWARM_PLAN artifacts (pre-v7.x sessions)
	for (const filename of ['SWARM_PLAN.md', 'SWARM_PLAN.json']) {
		try {
			const rootPath = path.join(directory, filename);
			if (_internals.existsSync(rootPath)) {
				_internals.unlinkSync(rootPath);
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
		if (_internals.existsSync(summariesPath)) {
			_internals.rmSync(summariesPath, { recursive: true, force: true });
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
