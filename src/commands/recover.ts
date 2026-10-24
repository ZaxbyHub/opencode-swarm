import * as fs from 'node:fs';
import { coreEventsFilePath } from '../events/core-events.js';
import { readTaskEvidenceRaw } from '../gate-evidence.js';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import { retrySnapshotCoordinationInitialization } from '../session/snapshot-coordination-init.js';
import {
	listCoderSettlementWalStates,
	recoverStaleCoderSettlements,
	type StaleSettlementRecoveryOutcome,
} from '../workflow/coder-settlement.js';
import { renderRecoveryInvocationQuickForms } from '../workflow/recovery-invocation.js';
import {
	repairWedgedStageA,
	type StageARepairOutcome,
} from '../workflow/stage-a-repair.js';

/** Bounded ceiling for the dispatch-history scan: events.jsonl is
 * retention-bounded, but a pathological file must not be read whole. */
const DISPATCH_HISTORY_SCAN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Whether any coder-settlement lifecycle event mentions this task (#3422:
 * the recover no-WAL branch must distinguish "never dispatched" from
 * "dispatched, WAL lost" — events are best-effort but their PRESENCE rules
 * out the never-dispatched shape). 'unknown' on a missing/oversized file so
 * the caller can fall back to an honest weaker message.
 */
function scanTaskDispatchHistory(
	directory: string,
	taskId: string,
): 'present' | 'absent' | 'unknown' {
	try {
		const eventsPath = coreEventsFilePath(directory);
		if (!fs.existsSync(eventsPath)) return 'absent';
		const stat = fs.statSync(eventsPath);
		if (stat.size > DISPATCH_HISTORY_SCAN_MAX_BYTES) return 'unknown';
		const content = fs.readFileSync(eventsPath, 'utf-8');
		return content.includes('coder_settlement') && content.includes(taskId)
			? 'present'
			: 'absent';
	} catch {
		return 'unknown';
	}
}

/**
 * Whether an exact-task evidence file exists for the task ('present'), is
 * missing ('absent'), or exists but cannot be parsed ('corrupt').
 */
function inspectTaskEvidenceState(
	directory: string,
	taskId: string,
): 'present' | 'absent' | 'corrupt' {
	try {
		const evidence = readTaskEvidenceRaw(directory, taskId);
		return evidence ? 'present' : 'absent';
	} catch {
		return 'corrupt';
	}
}

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
			return `⚠️ Task ${outcome.taskId}: settlement WAL is unreadable (corrupt) — this command refuses corrupt WALs; inspect .swarm/coder-settlements/${outcome.taskId}.json and consult docs/troubleshooting/recovery-runbook.md; do not delete or hand-edit the file`;
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
			// Issue #2755: rework_required wedges have their own architect-legal
			// exit that this scan deliberately does not touch — point at it instead
			// of reporting a bare dead end.
			if (outcome.state === 'rework_required') {
				return `⏭️ Task ${outcome.taskId}: workflow state is rework_required — not a coder_delegated Stage A wedge, nothing to repair here. If the Stage B verdict did not require a code change, have the architect run the recover_rework_task tool for this task; otherwise delegate the coder to repair first.`;
			}
			// Issue #2828: idle/blocked are the settlement-wedge states. When the
			// scan refuses there, either the receipts are incomplete OR Stage A
			// is already recorded (proof-present idle is outside the mechanical
			// envelope and needs no repair) — name both honestly instead of a
			// conflated "proof present or not settled" dead end, and state
			// plainly that --force never overrides Stage A wedge-classification
			// refusals.
			if (outcome.state === 'idle' || outcome.state === 'blocked') {
				return `⏭️ Task ${outcome.taskId}: workflow state is ${outcome.state} — no Stage A repair is needed or provable here (a mechanical repair requires a COMMITTED accepted coder settlement AND green post-settlement pre-check evidence AND no Stage A proof already recorded). When Stage A is already recorded the task needs nothing; when the receipts exist but the mechanical envelope excludes them, the architect can run the audited recover_stage_a_task tool. --force does not override Stage A wedge-classification refusals.`;
			}
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
	sessionID?: string,
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

	if (listed.length === 0 || (taskId && !hasKnownWal)) {
		// No settlement WAL for this task. Distinguish the two shapes that
		// both used to print the same bare dead end (#3422): a stuck
		// settlement (recoverable here) versus a task for which no coder
		// dispatch or settlement evidence exists at all — the wedge class
		// where the deliverable was produced outside the worktree lane and
		// the coder-mutation completion gate can never be satisfied.
		if (taskId) {
			const dispatchHistory = scanTaskDispatchHistory(directory, taskId);
			const evidenceState = inspectTaskEvidenceState(directory, taskId);
			if (dispatchHistory === 'present') {
				report.push(
					`⚠️ No settlement WAL for task ${taskId}, but coder-settlement lifecycle events exist for it in the core event log — this looks like a partial cleanup or a background dispatch (WALs are optional for background dispatches). Nothing to recover here; see docs/troubleshooting/recovery-runbook.md.`,
				);
			} else if (evidenceState === 'corrupt') {
				report.push(
					`⚠️ No settlement WAL for task ${taskId} and its task-evidence file is unreadable (corrupt) — inspect .swarm/evidence/${taskId}.json; this command refuses corrupt evidence. See docs/troubleshooting/recovery-runbook.md.`,
				);
			} else if (dispatchHistory === 'absent' && evidenceState === 'absent') {
				report.push(
					`❌ No coder dispatch or settlement evidence was found for task ${taskId} (no settlement WAL, no exact-task workflow evidence file, no coder_settlement events).`,
					'',
					'This is the git-external-deliverable shape (issue #3422): if the work was commit/push/gh ops done outside a coder lane, there is nothing to recover — the coder-mutation gate cannot be satisfied by recovery. Options:',
					'1. If the task declares evidence_class external_git (or you can re-plan it to): run `/swarm attest ' +
						taskId +
						'` to verify the deliverable with its pinned anchors and admit completion.',
					'2. manual close — flip the task status in the TUI and record the wedge plus the close reason in your execution trace.',
					'3. Re-plan the task as a thin coder dispatch (the coder executes the pinned-scope git commands) so a settlement exists and the normal gate applies.',
				);
				if (listed.length > 0) {
					report.push(
						`Known tasks: ${listed.map((entry) => entry.taskId).join(', ')}`,
					);
				}
			} else {
				// Evidence exists but no WAL and no dispatch events — the
				// incomplete-evidence shape: name what is missing instead of a
				// bare dead end.
				report.push(
					`❌ No settlement WAL for task ${taskId}. Task-evidence exists (${evidenceState}) but no coder dispatch ran for this task, so in-machine settlement recovery does not apply.`,
					'',
					'Next steps: run `/swarm attest ' +
						taskId +
						'` if the task declares external_git evidence (or re-plan it to), or re-plan it as a thin coder dispatch so a settlement exists.',
				);
			}
		} else {
			report.push(
				'No coder settlement WALs found in .swarm/coder-settlements/ — nothing to recover.',
			);
		}
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
			await repairWedgedStageA(
				directory,
				// Issue #3043: the invoking session's in-memory workflow view is
				// refreshed for repaired / already-recovered tasks so a
				// blocked-start wedge does not survive this command in the very
				// session that ran it (refresh is skipped for an unknown or
				// absent session id — fail-closed).
				{
					...(taskId ? { taskIds: [taskId] } : {}),
					...(sessionID ? { sessionId: sessionID } : {}),
				},
			);
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

	// Shell-correct invocation quick forms (issue #2665 AC3): every run of the
	// recovery command carries the per-shell guidance so the emitted advice
	// itself is correct in PowerShell, Git Bash (MSYS), and the CLI.
	report.push('', renderRecoveryInvocationQuickForms());

	return report.join('\n');
}
