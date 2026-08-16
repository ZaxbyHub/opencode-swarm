import { reconcileSpecDrift } from '../services/spec-drift-recovery.js';
import { assertProjectRoot } from '../utils/project-boundary';

/**
 * Caller identification for spec-drift acknowledgment audit trail.
 * Previously hardcoded as 'architect' — see issue #890, where the architect
 * could shell out to `bunx opencode-swarm run acknowledge-spec-drift` and
 * the resulting event mis-attributed the action. Callers now pass an
 * explicit actor so events.jsonl can distinguish the legitimate paths
 * ('user' from chat slash command, 'cli' from a real terminal) from any
 * unidentified caller ('unknown').
 */
export type SpecDriftAcknowledgedBy = 'user' | 'cli' | 'unknown';

/**
 * Handle /swarm acknowledge-spec-drift command.
 * Acknowledges a previously detected spec-drift marker after reconciling
 * plan hash, snapshot, and audit state in a retry-safe order.
 */
export async function handleAcknowledgeSpecDriftCommand(
	directory: string,
	_args: string[],
	acknowledgedBy: SpecDriftAcknowledgedBy = 'unknown',
): Promise<string> {
	assertProjectRoot(directory);

	const result = await reconcileSpecDrift(directory, {
		mode: 'acknowledge',
		actor: acknowledgedBy,
	});

	switch (result.status) {
		case 'no_marker':
			return 'No spec drift detected.';
		case 'applied':
			return (
				`${result.message}\n\n` +
				'Warning: Spec drift was acknowledged; verify that the implementation still matches the current spec before proceeding.'
			);
		case 'cleanup_pending':
			return (
				`${result.message}\n\n` +
				'Warning: Acknowledgment is already committed, but the drift marker still exists until cleanup succeeds. Retry the command to finish cleanup.'
			);
		case 'retry_later':
		case 'corrupt_marker':
		case 'failed':
			return result.message;
	}
}
