import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory.js';
import {
	type PostMortemOptions,
	runCuratorPostMortem,
} from '../hooks/curator-postmortem.js';

// ── DI Seam ──────────────────────────────────────────────────────────

export const _internals = {
	createCuratorLLMDelegate,
	runCuratorPostMortem,
};

function parsePostMortemArgs(args: string[]): {
	force: boolean;
	scope: 'session' | 'project';
	error?: string;
} {
	let scope: 'session' | 'project' = 'project';
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--scope') {
			const value = args[i + 1];
			if (value !== 'session' && value !== 'project') {
				return {
					force: args.includes('--force'),
					scope,
					error:
						'Invalid --scope value. Use --scope session or --scope project.',
				};
			}
			scope = value;
			i++;
			continue;
		}
		if (arg.startsWith('--scope=')) {
			const value = arg.slice('--scope='.length);
			if (value !== 'session' && value !== 'project') {
				return {
					force: args.includes('--force'),
					scope,
					error:
						'Invalid --scope value. Use --scope=session or --scope=project.',
				};
			}
			scope = value;
		}
	}
	return { force: args.includes('--force'), scope };
}

// ── Command handler ───────────────────────────────────────────────────

export async function handlePostMortemCommand(
	directory: string,
	args: string[],
	options?: { sessionID?: string },
): Promise<string> {
	try {
		const parsedArgs = parsePostMortemArgs(args);
		if (parsedArgs.error) {
			return parsedArgs.error;
		}

		const pmOptions: PostMortemOptions = {
			force: parsedArgs.force,
			scope: parsedArgs.scope,
			sessionID: options?.sessionID,
		};

		if (options?.sessionID) {
			try {
				pmOptions.llmDelegate = _internals.createCuratorLLMDelegate(
					directory,
					'postmortem',
					options.sessionID,
				);
			} catch {
				// LLM delegate unavailable — data-only report
			}
		}

		const result = await _internals.runCuratorPostMortem(directory, pmOptions);

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
