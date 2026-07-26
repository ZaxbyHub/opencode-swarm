export type TaskResultClassification = 'running' | 'success' | 'non_success';

const SUCCESS_STATES = new Set([
	'completed',
	'complete',
	'success',
	'succeeded',
]);
const RUNNING_STATES = new Set(['running', 'pending', 'queued', 'in_progress']);
const NON_SUCCESS_STATES = new Set([
	'error',
	'failed',
	'failure',
	'cancelled',
	'canceled',
	'stale',
	'timeout',
	'timed_out',
	'aborted',
]);

/**
 * Shared Task-result classifier for every Stage-B lifecycle consumer.
 * Explicit state/status and error fields win. Unknown shapes fail closed.
 */
export function classifyTaskResult(output: unknown): TaskResultClassification {
	if (!output || typeof output !== 'object') return 'non_success';
	const record = output as Record<string, unknown>;
	const nestedRecords = [record.metadata, record.result].filter(
		(candidate): candidate is Record<string, unknown> =>
			typeof candidate === 'object' && candidate !== null,
	);
	const records = [record, ...nestedRecords];
	const states = records
		.flatMap((candidate) => [candidate.state, candidate.status])
		.filter((candidate): candidate is string => typeof candidate === 'string')
		.map((candidate) => candidate.trim().toLowerCase());
	const hasError = records.some(
		(candidate) =>
			(candidate.error !== undefined && candidate.error !== null) ||
			(Array.isArray(candidate.errors) && candidate.errors.length > 0),
	);
	if (hasError || states.some((state) => NON_SUCCESS_STATES.has(state))) {
		return 'non_success';
	}
	const knownStates = new Set([
		...SUCCESS_STATES,
		...RUNNING_STATES,
		...NON_SUCCESS_STATES,
	]);
	if (states.some((state) => !knownStates.has(state))) return 'non_success';
	const metadata = nestedRecords[0];
	if (
		states.some((state) => RUNNING_STATES.has(state)) ||
		metadata?.background === true
	) {
		return 'running';
	}
	if (states.some((state) => SUCCESS_STATES.has(state))) return 'success';
	if (typeof record.output === 'string') return 'success';
	// OpenCode's historical successful void Task completion is `{}`. Preserve
	// that explicit hook contract while failing every unknown populated shape
	// closed.
	return Object.keys(record).length === 0 ? 'success' : 'non_success';
}
