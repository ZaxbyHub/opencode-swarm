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
 * Strips comments (single-line // and multi-line /* *\/), console.log/debugger statements,
 * trailing whitespace, and blank lines. Returns true if the stripped versions are identical.
 */
/**
 * Comment syntax family for a language hint (a file path or language id).
 * The default family preserves the historical 2-argument behavior exactly:
 * // line comments plus slash-star block comments (TS/JS/Go/PHP/Java/Kotlin/C/C++/Rust).
 */
interface CommentSyntaxFamily {
	lineTokens: string[];
	blockComments: boolean;
}

const DEFAULT_COMMENT_FAMILY: CommentSyntaxFamily = {
	lineTokens: ['//'],
	blockComments: true,
};

export function commentFamilyForLanguage(
	languageHint?: string,
): CommentSyntaxFamily {
	if (!languageHint) return DEFAULT_COMMENT_FAMILY;
	const hint = languageHint.toLowerCase();
	const ext = hint.includes('.') ? hint.slice(hint.lastIndexOf('.') + 1) : hint;
	switch (ext) {
		case 'py':
		case 'pyi':
		case 'python':
		case 'rb':
		case 'ruby':
		case 'sh':
		case 'bash':
		case 'zsh':
		case 'yaml':
		case 'yml':
		case 'toml':
		case 'r':
		case 'makefile':
			return { lineTokens: ['#'], blockComments: false };
		case 'php':
			// PHP accepts both // and # line comments plus block comments.
			return { lineTokens: ['//', '#'], blockComments: true };
		case 'sql':
		case 'lua':
			return { lineTokens: ['--'], blockComments: false };
		case 'pl':
		case 'perl':
			return { lineTokens: ['#'], blockComments: true };
		default:
			return DEFAULT_COMMENT_FAMILY;
	}
}

export function isStaticallyEquivalent(
	originalCode: string,
	mutatedCode: string,
	languageHint?: string,
): boolean {
	const family = commentFamilyForLanguage(languageHint);
	const stripCode = (code: string): string => {
		// Step 1: Remove multi-line block comments (families that support them)
		let inMultiLineComment = false;
		const afterMultiLine: string[] = [];
		for (const line of family.blockComments ? code.split('\n') : []) {
			if (!inMultiLineComment) {
				const openIndex = line.indexOf('/*');
				if (openIndex !== -1) {
					const closeIndex = line.indexOf('*/', openIndex + 2);
					if (closeIndex !== -1) {
						afterMultiLine.push(
							line.substring(0, openIndex) + line.substring(closeIndex + 2),
						);
					} else {
						afterMultiLine.push(line.substring(0, openIndex));
						inMultiLineComment = true;
					}
				} else {
					afterMultiLine.push(line);
				}
			} else {
				const closeIndex = line.indexOf('*/');
				if (closeIndex !== -1) {
					afterMultiLine.push(line.substring(closeIndex + 2));
					inMultiLineComment = false;
				}
				// else: entire line is inside multi-line comment, skip
			}
		}

		// Step 2: Remove single-line comments (family line tokens, with string state tracking)
		const afterSingleLine: string[] = [];
		const linesForSingle = family.blockComments
			? afterMultiLine
			: code.split('\n');
		for (const line of linesForSingle) {
			let inString: "'" | '"' | '`' | null = null;
			let commentStart = -1;
			for (let i = 0; i < line.length; i++) {
				const ch = line[i];
				if (inString) {
					if (ch === '\\') {
						i++;
						continue;
					}
					if (ch === inString) {
						inString = null;
					}
				} else {
					if (ch === "'" || ch === '"' || ch === '`') {
						inString = ch;
					} else {
						for (const token of family.lineTokens) {
							if (line.startsWith(token, i)) {
								commentStart = i;
								break;
							}
						}
						if (commentStart >= 0) break;
					}
				}
			}
			let processed =
				commentStart >= 0 ? line.substring(0, commentStart) : line;
			processed = processed.trimEnd();
			afterSingleLine.push(processed);
		}

		// Step 3: Strip console.log/debugger lines
		const afterConsole = afterSingleLine.filter((line) => {
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
	// Stage 1: Static analysis (language-aware via the patch's file path)
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
