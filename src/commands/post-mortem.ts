import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory.js';
import {
	type PostMortemOptions,
	runCuratorPostMortem,
} from '../hooks/curator-postmortem.js';

export async function handlePostMortemCommand(
	directory: string,
	args: string[],
	options?: { sessionID?: string },
): Promise<string> {
	try {
		const force = args.includes('--force');

		const pmOptions: PostMortemOptions = {
			force,
		};

		if (options?.sessionID) {
			try {
				pmOptions.llmDelegate = createCuratorLLMDelegate(
					directory,
					'phase',
					options.sessionID,
				);
			} catch {
				// LLM delegate unavailable — data-only report
			}
		}

		const result = await runCuratorPostMortem(directory, pmOptions);

		const lines: string[] = [];

		if (result.success) {
			lines.push('## Post-Mortem Report Generated');
			lines.push('');
			if (result.reportPath) {
				lines.push(`Report: \`${result.reportPath}\``);
			}
			if (result.summary) {
				lines.push('');
				lines.push(result.summary);
			}
		} else {
			lines.push('## Post-Mortem Failed');
			lines.push('');
			lines.push('The post-mortem report could not be generated.');
		}

		if (result.warnings.length > 0) {
			lines.push('');
			lines.push('### Warnings');
			for (const w of result.warnings) {
				lines.push(`- ${w}`);
			}
		}

		return lines.join('\n');
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return `Error running post-mortem: ${message}. Run /swarm diagnose to check .swarm/ health.`;
	}
}
