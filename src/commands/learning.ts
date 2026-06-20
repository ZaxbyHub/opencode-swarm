import {
	computeLearningMetrics,
	formatLearningJSON,
	formatLearningMarkdown,
} from '../services/learning-metrics.js';

const DEFAULT_LEARNING_TIMEOUT_MS = 30_000;
const MAX_LEARNING_TIMEOUT_MS = 300_000;

class LearningMetricsTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Learning metrics timed out after ${timeoutMs}ms`);
		this.name = 'LearningMetricsTimeoutError';
	}
}

function parseTimeoutMs(args: string[]): number {
	const timeoutIdx = args.indexOf('--timeout-ms');
	if (timeoutIdx === -1 || timeoutIdx + 1 >= args.length) {
		return DEFAULT_LEARNING_TIMEOUT_MS;
	}
	const parsed = Number(args[timeoutIdx + 1]);
	if (
		!Number.isInteger(parsed) ||
		parsed < 1 ||
		parsed > MAX_LEARNING_TIMEOUT_MS
	) {
		return DEFAULT_LEARNING_TIMEOUT_MS;
	}
	return parsed;
}

function timeoutMessage(timeoutMs: number): string {
	return `LEARNING_METRICS_TIMEOUT: exceeded ${timeoutMs}ms while computing learning metrics. Run /swarm diagnose to check .swarm/ health.`;
}

async function computeWithTimeout(
	directory: string,
	currentPhase: number | undefined,
	timeoutMs: number,
) {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const metricsPromise = _internals.computeLearningMetrics(directory, {
		currentPhase,
		signal: controller.signal,
	});
	void metricsPromise.catch(() => {
		/* handled by Promise.race or intentional timeout cancellation */
	});
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			reject(new LearningMetricsTimeoutError(timeoutMs));
			controller.abort();
		}, timeoutMs);
	});

	try {
		return await Promise.race([metricsPromise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function handleLearningCommand(
	directory: string,
	args: string[],
): Promise<string> {
	try {
		const jsonMode = args.includes('--json');
		const timeoutMs = parseTimeoutMs(args);

		let currentPhase: number | undefined;
		const phaseIdx = args.indexOf('--phase');
		if (phaseIdx !== -1 && phaseIdx + 1 < args.length) {
			const parsed = Number(args[phaseIdx + 1]);
			if (Number.isFinite(parsed)) {
				currentPhase = parsed;
			}
		}

		const metrics = await computeWithTimeout(
			directory,
			currentPhase,
			timeoutMs,
		);

		if (jsonMode) {
			return `[LEARNING_JSON]\n${JSON.stringify(formatLearningJSON(metrics), null, 2)}\n[/LEARNING_JSON]`;
		}

		return formatLearningMarkdown(metrics);
	} catch (err: unknown) {
		if (err instanceof LearningMetricsTimeoutError) {
			if (args.includes('--json')) {
				return `[LEARNING_JSON]\n${JSON.stringify(
					{
						ok: false,
						error: {
							code: 'LEARNING_METRICS_TIMEOUT',
							timeout_ms: err.timeoutMs,
							message: timeoutMessage(err.timeoutMs),
						},
					},
					null,
					2,
				)}\n[/LEARNING_JSON]`;
			}
			return timeoutMessage(err.timeoutMs);
		}
		const message = err instanceof Error ? err.message : String(err);
		return `Error computing learning metrics: ${message}. Run /swarm diagnose to check .swarm/ health.`;
	}
}

export const _internals = {
	computeLearningMetrics,
};
