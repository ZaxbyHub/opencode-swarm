import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { createSwarmTool } from './create-tool';

interface GitingestResponse {
	summary: string;
	tree: string;
	content: string;
}

export interface GitingestArgs {
	url: string;
	maxFileSize?: number;
	pattern?: string;
	patternType?: 'include' | 'exclude';
}

export const GITINGEST_TIMEOUT_MS = 10_000;
export const GITINGEST_MAX_RESPONSE_BYTES = 5_242_880;
export const GITINGEST_MAX_RETRIES = 2;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch repository content via gitingest.com API with timeout, size guard, and retry logic
 */
export async function fetchGitingest(args: GitingestArgs): Promise<string> {
	for (let attempt = 0; attempt <= GITINGEST_MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				GITINGEST_TIMEOUT_MS,
			);

			const response = await fetch('https://gitingest.com/api/ingest', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					input_text: args.url,
					max_file_size: args.maxFileSize ?? 50000,
					pattern: args.pattern ?? '',
					pattern_type: args.patternType ?? 'exclude',
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (response.status >= 500 && attempt < GITINGEST_MAX_RETRIES) {
				const backoff = 200 * 2 ** attempt;
				await delay(backoff);
				continue;
			}

			if (response.status >= 400 && response.status < 500) {
				throw new Error(
					`gitingest API error: ${response.status} ${response.statusText}`,
				);
			}

			if (!response.ok) {
				throw new Error(
					`gitingest API error: ${response.status} ${response.statusText}`,
				);
			}

			const contentLength = Number(response.headers.get('content-length'));
			if (
				Number.isFinite(contentLength) &&
				contentLength > GITINGEST_MAX_RESPONSE_BYTES
			) {
				throw new Error('gitingest response too large');
			}

			const text = await response.text();
			if (Buffer.byteLength(text) > GITINGEST_MAX_RESPONSE_BYTES) {
				throw new Error('gitingest response too large');
			}

			let data: GitingestResponse;
			try {
				data = JSON.parse(text) as GitingestResponse;
			} catch {
				throw new Error(
					`gitingest API returned non-JSON response (${text.length} chars, starts: ${text.slice(0, 80)})`,
				);
			}
			return `${data.summary}\n\n${data.tree}\n\n${data.content}`;
		} catch (error) {
			// Timeout errors — convert to domain-specific error
			if (
				error instanceof DOMException &&
				(error.name === 'TimeoutError' || error.name === 'AbortError')
			) {
				if (attempt >= GITINGEST_MAX_RETRIES) {
					throw new Error('gitingest request timed out');
				}
				const backoff = 200 * 2 ** attempt;
				await delay(backoff);
				continue;
			}

			// Domain-specific errors (size limit, 4xx, etc.) — throw immediately
			if (error instanceof Error && error.message.startsWith('gitingest ')) {
				throw error;
			}

			// Network errors — retry with backoff
			if (attempt < GITINGEST_MAX_RETRIES) {
				const backoff = 200 * 2 ** attempt;
				await delay(backoff);
				continue;
			}

			throw error;
		}
	}
	// This line is a safety net — the loop should always return or throw above
	throw new Error('gitingest request failed after retries');
}

/**
 * Gitingest tool for fetching GitHub repository contents
 */
export const gitingest: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		"Fetch a GitHub repository's full content via gitingest.com. Returns summary, directory tree, and file contents optimized for LLM analysis. Use when you need to understand an external repository's structure or code.",
	args: {
		url: z
			.string()
			.describe('GitHub repository URL (e.g., https://github.com/owner/repo)'),
		maxFileSize: z
			.number()
			.optional()
			.describe('Maximum file size in bytes to include (default: 50000)'),
		pattern: z
			.string()
			.optional()
			.describe("Glob pattern to filter files (e.g., '*.ts' or 'src/**/*.py')"),
		patternType: z
			.enum(['include', 'exclude'])
			.optional()
			.describe(
				'Whether pattern includes or excludes matching files (default: exclude)',
			),
	},
	async execute(args: unknown, _directory: string, _ctx?: ToolContext) {
		const typedArgs = args as GitingestArgs;
		return fetchGitingest(typedArgs);
	},
});
