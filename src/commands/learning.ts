import {
	computeLearningMetrics,
	formatLearningJSON,
	formatLearningMarkdown,
} from '../services/learning-metrics.js';

export async function handleLearningCommand(
	directory: string,
	args: string[],
): Promise<string> {
	try {
		const jsonMode = args.includes('--json');

		let currentPhase: number | undefined;
		const phaseIdx = args.indexOf('--phase');
		if (phaseIdx !== -1 && phaseIdx + 1 < args.length) {
			const parsed = Number(args[phaseIdx + 1]);
			if (Number.isFinite(parsed)) {
				currentPhase = parsed;
			}
		}

		const metrics = await computeLearningMetrics(directory, { currentPhase });

		if (jsonMode) {
			return `[LEARNING_JSON]\n${JSON.stringify(formatLearningJSON(metrics), null, 2)}\n[/LEARNING_JSON]`;
		}

		return formatLearningMarkdown(metrics);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return `Error computing learning metrics: ${message}. Run /swarm diagnose to check .swarm/ health.`;
	}
}
