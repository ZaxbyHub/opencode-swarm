/**
 * `/swarm attest <task_id>` (issue #3422): verify a git-external deliverable
 * with the task's pinned read-only git anchors and record the durable
 * external-evidence bundle that admits completion — the in-machine exit for
 * tasks whose deliverable (commit/push, gh ops) can never produce a coder
 * settlement. Human- or agent-invoked; everything fails closed exactly as
 * the underlying executor does (undeclared tasks, non-read-only commands,
 * mismatched anchors, oversized output all refuse).
 */
export async function handleAttestCommand(
	directory: string,
	args: string[],
	sessionID?: string,
): Promise<string> {
	const positional = args.filter((arg) => !arg.startsWith('--'));
	if (positional.length !== 1) {
		return [
			'## External Evidence Attestation',
			'',
			positional.length === 0
				? '❌ Missing task id. Usage: /swarm attest <task_id>'
				: `❌ Unexpected arguments: ${positional.join(' ')}. Usage: /swarm attest <task_id>`,
		].join('\n');
	}
	const taskId = positional[0]!;
	// Lazy import: a static one would pull tools/update-task-status.js's heavy
	// state graph into every src/commands barrel consumer and break the
	// close-command suites that mock src/state.js with a partial stub object
	// ("Export named 'hasModifiedFilesForTask' not found", the #2415 class).
	const { executeAttestTask } = await import('../tools/attest-task.js');
	const result = await executeAttestTask(
		{
			task_id: taskId,
			working_directory: directory,
			reason: `swarm attest (${sessionID ?? 'no-session'})`,
		},
		directory,
	);
	const lines = ['## External Evidence Attestation', ''];
	lines.push(result.success ? '✅ ' + result.message : '❌ ' + result.message);
	for (const error of result.errors ?? []) {
		lines.push(`- ${error}`);
	}
	if (!result.success) {
		lines.push(
			'',
			'The attest path is fail-closed: the plan task must declare evidence_class external_git with 1..16 pinned read-only git anchors, every anchor must match, and the task must never have entered the coder QA workflow. See docs/commands.md (/swarm attest) and docs/plan-durability.md.',
		);
	}
	return lines.join('\n');
}
