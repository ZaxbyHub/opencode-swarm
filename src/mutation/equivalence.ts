import * as path from 'node:path';
import type { MutationPatch } from './engine.js';

/** Result of equivalence check for a single mutant */
export interface EquivalenceResult {
	patchId: string;
	isEquivalent: boolean;
	method: 'static' | 'llm_judge' | 'skipped';
	confidence: number; // 0-1
	reason: string;
}

/** Callback signature for LLM judge — injected by caller */
export type LLMJudgeCallback = (
	original: string,
	mutated: string,
	context: string,
) => Promise<{ isEquivalent: boolean; confidence: number; reason: string }>;

/**
 * Stage 1: Static equivalence filter.
 *
 * Comment syntax is selected from the source path. A missing path is unknown,
 * so direct callers do not get an unsafe language-specific comment heuristic.
 * An unknown extension is deliberately conservative and does not discard
 * comments at all.
 */
export function isStaticallyEquivalent(
	originalCode: string,
	mutatedCode: string,
	filePath?: string,
): boolean {
	type CommentFamily = 'c-style' | 'hash' | 'unknown';
	const extension = filePath ? path.extname(filePath).toLowerCase() : '';
	const cStyleExtensions = new Set([
		'.c',
		'.cc',
		'.cpp',
		'.cxx',
		'.cts',
		'.cs',
		'.dart',
		'.go',
		'.h',
		'.java',
		'.cjs',
		'.js',
		'.jsx',
		'.jsonc',
		'.kt',
		'.kts',
		'.mjs',
		'.mts',
		'.php',
		'.rs',
		'.scala',
		'.scss',
		'.svelte',
		'.swift',
		'.ts',
		'.tsx',
		'.vue',
	]);
	const javaScriptExtensions = new Set([
		'.cjs',
		'.cts',
		'.js',
		'.jsx',
		'.mjs',
		'.mts',
		'.svelte',
		'.ts',
		'.tsx',
		'.vue',
	]);
	const hashExtensions = new Set(['.py', '.pyw', '.rb', '.rake']);
	const isJavaScriptFamily = javaScriptExtensions.has(extension);
	const commentFamily: CommentFamily = !filePath
		? 'unknown'
		: cStyleExtensions.has(extension)
			? 'c-style'
			: hashExtensions.has(extension)
				? 'hash'
				: 'unknown';

	const stripCode = (code: string): string => {
		const lines = code.split('\n');
		const withoutComments: string[] = [];
		let inBlockComment = false;
		for (const line of lines) {
			if (commentFamily === 'unknown') {
				withoutComments.push(line.trimEnd());
				continue;
			}

			let output = '';
			let inString: "'" | '"' | '`' | null = null;
			let escaped = false;
			for (let i = 0; i < line.length; i++) {
				const ch = line[i];
				const next = line[i + 1];
				if (inBlockComment) {
					if (ch === '*' && next === '/') {
						inBlockComment = false;
						i++;
					}
					continue;
				}
				if (inString) {
					output += ch;
					if (escaped) escaped = false;
					else if (ch === '\\') escaped = true;
					else if (ch === inString) inString = null;
					continue;
				}
				if (
					ch === "'" ||
					ch === '"' ||
					(ch === '`' && commentFamily === 'c-style')
				) {
					inString = ch;
					output += ch;
					continue;
				}
				if (commentFamily === 'c-style' && ch === '/' && next === '*') {
					inBlockComment = true;
					i++;
					continue;
				}
				if (
					(commentFamily === 'c-style' && ch === '/' && next === '/') ||
					(commentFamily === 'hash' && ch === '#')
				) {
					break;
				}
				output += ch;
			}
			withoutComments.push(output.trimEnd());
		}

		// Keep the existing JavaScript-family logging/debugger filter. Unknown
		// and hash-comment languages are intentionally not interpreted as JS.
		const afterConsole = withoutComments.filter((line) => {
			if (!isJavaScriptFamily) return true;
			const trimmedLower = line.toLowerCase().trim();
			if (/^console\.(log|debug)\s*(\(|$)/.test(trimmedLower)) return false;
			if (trimmedLower === 'debugger;') return false;
			return true;
		});

		// Step 4: Remove empty lines
		return afterConsole.filter((line) => line.trim() !== '').join('\n');
	};

	const strippedOriginal = stripCode(originalCode);
	const strippedMutated = stripCode(mutatedCode);

	return strippedOriginal === strippedMutated;
}

export const _internals: {
	isStaticallyEquivalent: typeof isStaticallyEquivalent;
	checkEquivalence: typeof checkEquivalence;
	batchCheckEquivalence: typeof batchCheckEquivalence;
} = {
	isStaticallyEquivalent,
	checkEquivalence,
	batchCheckEquivalence,
} as const;

/**
 * Check a single mutant for equivalence using two-stage approach.
 * Stage 1: static analysis. Stage 2: LLM judge (if provided and Stage 1 didn't determine equivalence).
 */
export async function checkEquivalence(
	patch: MutationPatch,
	originalCode: string,
	mutatedCode: string,
	llmJudge?: LLMJudgeCallback,
): Promise<EquivalenceResult> {
	// Stage 1: Static analysis
	if (isStaticallyEquivalent(originalCode, mutatedCode, patch.filePath)) {
		return {
			patchId: patch.id,
			isEquivalent: true,
			method: 'static',
			confidence: 1.0,
			reason:
				'Mutated code is identical to original after stripping comments, logging, and whitespace',
		};
	}

	// Stage 2: LLM judge if provided
	if (llmJudge) {
		const context = `File: ${patch.filePath}\nFunction: ${patch.functionName}\nMutation Type: ${patch.mutationType}`;
		const verdict = await llmJudge(originalCode, mutatedCode, context);
		return {
			patchId: patch.id,
			isEquivalent: verdict.isEquivalent,
			method: 'llm_judge',
			confidence: verdict.confidence,
			reason: verdict.reason,
		};
	}

	// No LLM judge available
	return {
		patchId: patch.id,
		isEquivalent: false,
		method: 'skipped',
		confidence: 0,
		reason: 'No LLM judge provided — equivalence could not be determined',
	};
}

/**
 * Batch check multiple mutants for equivalence.
 * Returns results for all patches.
 */
export async function batchCheckEquivalence(
	patches: Array<{
		patch: MutationPatch;
		originalCode: string;
		mutatedCode: string;
	}>,
	llmJudge?: LLMJudgeCallback,
): Promise<EquivalenceResult[]> {
	const results: EquivalenceResult[] = [];

	for (const { patch, originalCode, mutatedCode } of patches) {
		try {
			const result = await _internals.checkEquivalence(
				patch,
				originalCode,
				mutatedCode,
				llmJudge,
			);
			results.push(result);
		} catch (err) {
			results.push({
				patchId: patch.id,
				isEquivalent: false,
				method: 'skipped',
				confidence: 0,
				reason: `Equivalence check failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	return results;
}
