import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import { retrySnapshotCoordinationInitialization } from '../session/snapshot-coordination-init.js';
import {
	listCoderSettlementWalStates,
	recoverStaleCoderSettlements,
	type StaleSettlementRecoveryOutcome,
} from '../workflow/coder-settlement.js';
import {
	repairWedgedStageA,
	type StageARepairOutcome,
} from '../workflow/stage-a-repair.js';

/**
 * Renders one recovery outcome as a user-facing report line. Kept as a pure
 * function (no directory access) so tests can pin the exact remediation text
 * for every outcome class. WAL-derived free-form fields (transitionId, error
 * message) are sanitized per the repo's untrusted-diagnostic-field pattern —
 * they are length-validated only at the schema layer (issue #2268 review,
 * PRR-001/002).
 */
function renderOutcome(outcome: StaleSettlementRecoveryOutcome): string {
	switch (outcome.outcome) {
		case 'recovered':
			return `✅ Task ${outcome.taskId}: settlement recovered (${
				outcome.accepted
					? 'changes attributed'
					: 'no workspace change to attribute'
			}${outcome.forced ? ', in-process ownership released by --force' : ''})`;
		case 'already_terminal':
			return `⏭️ Task ${outcome.taskId}: settlement already ${outcome.state} (nothing to recover)`;
		case 'owned_in_process':
			return `ℹ️ Task ${outcome.taskId}: dispatch ${sanitizeDiagnosticText(
				outcome.transitionId,
			)} is still registered as in flight in this process. If no coder is genuinely running, re-run with --force to release it.`;
		case 'owned_by_live_foreign_pid':
			return `ℹ️ Task ${outcome.taskId}: owned by live process pid ${outcome.processId} (another OpenCode instance). Close that instance or run /swarm recover there; this command never interrupts another live process's dispatch.`;
		case 'unreadable_wal':
			return `⚠️ Task ${outcome.taskId}: settlement WAL is unreadable — inspect .swarm/coder-settlements/${outcome.taskId}.json`;
		case 'error':
			return `❌ Task ${outcome.taskId}: recovery failed — ${sanitizeDiagnosticText(
				outcome.message,
				512,
			)}`;
		default:
			return `❌ Task ${(outcome as { taskId: string }).taskId}: unknown outcome`;
	}
}

/**
 * Renders one Stage A repair outcome as a user-facing report line (pure
 * function; same sanitization rules as renderOutcome).
 */
function renderStageARepairOutcome(outcome: StageARepairOutcome): string {
	switch (outcome.outcome) {
		case 'repaired':
			return `✅ Task ${outcome.taskId}: Stage A repaired — stage_a_passed written at generation ${outcome.generation} without re-running the coder`;
		case 'skipped_not_wedged':
			return `⏭️ Task ${outcome.taskId}: workflow state is ${outcome.state} with pre_check proof present or not settled — nothing to repair`;
		case 'skipped_not_green':
			return `⏭️ Task ${outcome.taskId}: no green post-settlement pre-check evidence (${outcome.reason === 'no_pre_check_bundles' ? 'missing or non-green secretscan/SAST bundle — run pre_check_batch first' : 'latest pre-check run failed or predates the settlement'}) — refusing to mark Stage A passed without proof`;
		case 'error':
			return `❌ Task ${outcome.taskId}: Stage A repair failed — ${sanitizeDiagnosticText(
				outcome.message,
				512,
			)}`;
		default:
			return `❌ Task ${(outcome as { taskId: string }).taskId}: unknown repair outcome`;
	}
}

/**
 * Handles the /swarm recover command (issue #2268).
 *
 * The user-facing invoker for coder-settlement recovery. The wedge class this
 * exists for: a DISPATCHED settlement WAL whose completion (toolAfter) never
 * arrived — every dispatch retry is refused with CODER_SETTLEMENT_IN_PROGRESS
 * / CODER_DISPATCH_IN_PROGRESS and internal sinks (update_task_status, /swarm
 * close) are paused too. Safe mode recovers settlements whose owning process
 * is gone; --force additionally releases ownership keys still held by THIS
 * process (an operator assertion that no dispatch is genuinely in flight —
 * a still-running dispatch's late completion will then fail settlement with
 * CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT, which is safe to ignore).
 *
 * Human-only by policy: agents already self-heal dead-owner settlements via
 * update_task_status, and --force must stay an operator decision.
 */
export async function handleRecoverCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const force = args.includes('--force');
	if (args.includes('--coordination')) {
		try {
			await retrySnapshotCoordinationInitialization(directory);
			return [
				'## SQLite Coordination Recovery',
				'',
				'✅ Coordination initialization/import completed successfully.',
			].join('\n');
		} catch (err) {
			return [
				'## SQLite Coordination Recovery',
				'',
				`❌ Recovery refused or failed: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 512)}`,
				'If an earlier attempt timed out, wait for that underlying attempt to settle before retrying; it is never abandoned or run concurrently.',
			].join('\n');
		}
	}
	const positional = args.filter((arg) => !arg.startsWith('--'));
	const taskId = positional[0];
	if (positional.length > 1) {
		return [
			'## Coder Settlement Recovery',
			'',
			`❌ Unexpected arguments: ${positional.join(' ')}`,
			'Usage: /swarm recover [task_id] [--force]',
		].join('\n');
	}

	const { states: listed, truncated: listTruncated } =
		await listCoderSettlementWalStates(directory);

	const report: string[] = ['## Coder Settlement Recovery', ''];
	const hasKnownWal =
		listed.length > 0 &&
		(!taskId || listed.some((entry) => entry.taskId === taskId));

	if (listed.length === 0) {
		report.push(
			taskId
				? `❌ No settlement WAL for task ${taskId} (no settlement WALs found in .swarm/coder-settlements/).`
				: 'No coder settlement WALs found in .swarm/coder-settlements/ — nothing to recover.',
		);
	} else if (taskId && !hasKnownWal) {
		report.push(
			`❌ No settlement WAL for task ${taskId}. Known tasks: ${listed
				.map((entry) => entry.taskId)
				.join(', ')}`,
		);
	} else {
		const { results, truncated: recoverTruncated } =
			await recoverStaleCoderSettlements(directory, {
				...(taskId ? { taskIds: [taskId] } : {}),
				force,
			});

		const lines = results.map((outcome) => renderOutcome(outcome));
		const recoveredCount = results.filter(
			(r) => r.outcome === 'recovered',
		).length;
		const blockedCount = results.filter(
			(r) =>
				r.outcome === 'owned_in_process' ||
				r.outcome === 'owned_by_live_foreign_pid',
		).length;

		report.push(
			...lines,
			'',
			`Recovered ${recoveredCount} settlement(s)${
				blockedCount > 0
					? `; ${blockedCount} still owned by a live dispatch (see above for the exact remediation)`
					: ''
			}.`,
		);
		if (listTruncated || recoverTruncated) {
			report.push(
				'',
				'⚠️ More settlement WALs exist than the recovery scan cap (200) — older settlements were NOT listed or processed. Re-run after the tasks above are settled to reach the rest.',
			);
		}
		if (force && recoveredCount > 0) {
			report.push(
				'',
				'⚠️ --force released in-process ownership before recovery. If any of these dispatches was genuinely still running, its completion will report CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT — that error is expected and safe to ignore; the settlement is already durably recovered.',
			);
		}
	}

	// Stage A wedge repair runs independently of settlement-WAL presence:
	// repairWedgedStageA scans .swarm/evidence/ directly and does not require
	// a settlement WAL to exist (background-dispatched coder tasks never
	// create one — see stage-b-gates.ts). Placing this after the
	// settlement-WAL early-return checks previously made this feature
	// unreachable whenever the target task had no listable WAL (PR review
	// finding F-003) — it now always runs, using whatever settlement-WAL
	// recency proof happens to be available (see stage-a-repair.ts's
	// updatedAt fallback for the WAL-less case). Emits the missing
	// stage_a_passed transition directly; audit events land in
	// .swarm/events.jsonl.
	try {
		const { results: repairResults, truncated: repairTruncated } =
			await repairWedgedStageA(directory, {
				...(taskId ? { taskIds: [taskId] } : {}),
			});
		const repaired = repairResults.filter((r) => r.outcome === 'repaired');
		if (repairResults.length > 0) {
			report.push(
				'',
				'## Wedged Stage A Repair',
				'',
				...repairResults.map(renderStageARepairOutcome),
				'',
				repaired.length === 0
					? 'No wedged tasks repaired.'
					: `Repaired ${repaired.length} wedged task(s); reviewer/test_engineer dispatch is now permitted for them.`,
			);
			if (repairTruncated) {
				report.push(
					'',
					'⚠️ More evidence files exist than the repair scan cap (200) — re-run after the tasks above are processed to reach the rest.',
				);
			}
		}
	} catch (err) {
		report.push(
			'',
			`⚠️ Wedged Stage A repair failed (settlement recovery above is unaffected): ${sanitizeDiagnosticText(
				err instanceof Error ? err.message : String(err),
				512,
			)}`,
		);
	}

	return report.join('\n');
}
