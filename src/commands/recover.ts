import {
	listCoderSettlementWalStates,
	recoverStaleCoderSettlements,
	type StaleSettlementRecoveryOutcome,
} from '../workflow/coder-settlement.js';

/**
 * Renders one recovery outcome as a user-facing report line. Kept as a pure
 * function (no directory access) so tests can pin the exact remediation text
 * for every outcome class.
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
			return `ℹ️ Task ${outcome.taskId}: dispatch ${outcome.transitionId} is still registered as in flight in this process. If no coder is genuinely running, re-run with --force to release it.`;
		case 'owned_by_live_foreign_pid':
			return `ℹ️ Task ${outcome.taskId}: owned by live process pid ${outcome.processId} (another OpenCode instance). Close that instance or run /swarm recover there; this command never interrupts another live process's dispatch.`;
		case 'unreadable_wal':
			return `⚠️ Task ${outcome.taskId}: settlement WAL is unreadable — inspect .swarm/coder-settlements/${outcome.taskId}.json`;
		case 'error':
			return `❌ Task ${outcome.taskId}: recovery failed — ${outcome.message}`;
		default:
			return `❌ Task ${(outcome as { taskId: string }).taskId}: unknown outcome`;
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

	const listed = await listCoderSettlementWalStates(directory);
	if (listed.length === 0) {
		return [
			'## Coder Settlement Recovery',
			'',
			'No coder settlement WALs found in .swarm/coder-settlements/ — nothing to recover.',
		].join('\n');
	}

	if (taskId) {
		const target = listed.find((entry) => entry.taskId === taskId);
		if (!target) {
			return [
				'## Coder Settlement Recovery',
				'',
				`❌ No settlement WAL for task ${taskId}. Known tasks: ${listed
					.map((entry) => entry.taskId)
					.join(', ')}`,
			].join('\n');
		}
	}

	const results = await recoverStaleCoderSettlements(directory, {
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

	const report = [
		'## Coder Settlement Recovery',
		'',
		...lines,
		'',
		`Recovered ${recoveredCount} settlement(s)${
			blockedCount > 0
				? `; ${blockedCount} still owned by a live dispatch (see above for the exact remediation)`
				: ''
		}.`,
	];
	if (force && recoveredCount > 0) {
		report.push(
			'',
			'⚠️ --force released in-process ownership before recovery. If any of these dispatches was genuinely still running, its completion will report CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT — that error is expected and safe to ignore; the settlement is already durably recovered.',
		);
	}
	return report.join('\n');
}
