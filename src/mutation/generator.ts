/**
 * LLM-based mutation patch generator.
 *
 * Uses the opencode SDK to call an LLM session and generate mutation testing patches
 * for specified source files. Produces MutationPatch[] for use by executeMutationSuite.
 */

import type { ToolContext } from '@opencode-ai/plugin';
import { swarmState } from '../state.js';
import type { MutationPatch } from './engine.js';

/** Slugify a string for use in mutation IDs */
function slugify(str: string): string {
	return str.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

/**
 * Extract a JSON array substring from an LLM response that may include
 * markdown code fences or natural-language preamble/postamble text.
 *
 * Handles the three most common non-compliant LLM response patterns:
 *   1. Markdown-fenced:  ```json\n[...]\n```
 *   2. Prefixed prose:   "Here are the mutations:\n[...]"
 *   3. Plain JSON:       "[...]"
 */
function extractJsonArray(text: string): string {
	const trimmed = text.trim();
	// Try markdown code fence first (```json ... ``` or ``` ... ```)
	const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) return fenceMatch[1].trim();
	// Find a '[' that starts a JSON value (object '{', nested array '[', string '"',
	// number '0-9', boolean 't'/'f', null 'n', or empty array ']').
	// This skips bare-word brackets like [off-by-one] in surrounding prose.
	const start = trimmed.search(/\[\s*[{["0-9\]tfn]/);
	const end = trimmed.lastIndexOf(']');
	if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
	return trimmed;
}

/**
 * Generate mutation testing patches for the given source files using an LLM.
 *
 * @param files - Array of file paths to generate mutations for
 * @param ctx - Optional ToolContext providing sessionID and directory
 * @returns Promise<MutationPatch[]> array of mutation patches, never throws
 */
export async function generateMutants(
	files: string[],
	ctx?: ToolContext,
): Promise<MutationPatch[]> {
	// Graceful fallback: no ToolContext means no LLM access
	if (!ctx) {
		console.warn(
			'[generateMutants] No ToolContext — cannot call LLM; returning empty patch set',
		);
		return [];
	}

	// Graceful fallback: no opencodeClient available
	const client = swarmState.opencodeClient;
	if (!client) {
		console.warn(
			'[generateMutants] opencodeClient not available; returning empty patch set',
		);
		return [];
	}

	const directory = ctx.directory ?? process.cwd();
	let ephemeralSessionId: string | undefined;

	/** Best-effort session cleanup — never throws. */
	const cleanup = () => {
		if (ephemeralSessionId) {
			const id = ephemeralSessionId;
			ephemeralSessionId = undefined;
			client.session.delete({ path: { id } }).catch(() => {});
		}
	};

	try {
		// 1. Create ephemeral session scoped to project directory
		const createResult = await client.session.create({
			query: { directory },
		});
		if (!createResult.data) {
			console.warn(
				`[generateMutants] Failed to create session: ${JSON.stringify(createResult.error)}; returning empty patch set`,
			);
			return [];
		}
		ephemeralSessionId = createResult.data.id;

		// 2. Prompt the LLM to generate mutation patches
		const mutationTypes = [
			'off-by-one',
			'null-substitution',
			'operator-swap',
			'guard-removal',
			'branch-swap',
			'side-effect-deletion',
		].join(', ');

		const promptText = `Generate mutation testing patches for the following files: ${files.join(', ')}

Return a JSON array where each element has:
{ id, filePath, functionName, mutationType, patch, lineNumber }

- id: unique string like "mut-001"
- mutationType: one of: ${mutationTypes}
- patch: unified diff format (--- a/file\\n+++ a/file\\n@@ ... @@\\n-old\\n+new)
- Generate 3-5 mutations per function

Return ONLY a valid JSON array. No markdown, no code fences, no explanation. Start your response with [ and end with ].`;

		const promptResult = await client.session.prompt({
			path: { id: ephemeralSessionId },
			body: {
				// Use default session agent (no specific agent name)
				agent: undefined,
				tools: { write: false, edit: false, patch: false },
				parts: [{ type: 'text', text: promptText }],
			},
		});

		if (!promptResult.data) {
			console.warn(
				`[generateMutants] LLM prompt failed: ${JSON.stringify(promptResult.error)}; returning empty patch set`,
			);
			return [];
		}

		// 3. Extract text parts from response
		const textParts = promptResult.data.parts.filter(
			(p): p is typeof p & { text: string } => p.type === 'text',
		);
		const rawText = textParts.map((p) => p.text).join('\n');

		// 4. Parse JSON response — strip markdown fences and prose preamble first
		let parsed: unknown;
		try {
			parsed = JSON.parse(extractJsonArray(rawText));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const hint =
				msg.includes('EOF') || msg.includes('Unexpected end')
					? ' (response appears truncated — LLM may have hit an output token limit)'
					: '';
			console.warn(
				`[generateMutants] Failed to parse LLM response as MutationPatch[]: ${msg}${hint}; returning empty patch set`,
			);
			return [];
		}

		// 5. Validate structure
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return [];
		}

		// 6. Normalize and validate each patch
		const patches: MutationPatch[] = [];
		for (const item of parsed) {
			if (
				typeof item !== 'object' ||
				item === null ||
				typeof item.filePath !== 'string' ||
				typeof item.functionName !== 'string' ||
				typeof item.mutationType !== 'string' ||
				typeof item.patch !== 'string'
			) {
				continue;
			}

			const mutationType = item.mutationType;
			const fileSlug = slugify(item.filePath);
			const fnSlug = slugify(item.functionName);
			const typeSlug = slugify(mutationType);

			// Generate unique ID if not provided or doesn't match expected format
			const idStr = typeof item.id === 'string' ? item.id : '';
			const id = idStr.startsWith('mut-')
				? idStr
				: `mut-${fileSlug}-${fnSlug}-${typeSlug}-${String(patches.length + 1).padStart(3, '0')}`;

			patches.push({
				id,
				filePath: item.filePath,
				functionName: item.functionName,
				mutationType,
				patch: item.patch,
				lineNumber:
					typeof item.lineNumber === 'number' ? item.lineNumber : undefined,
			});
		}

		return patches;
	} catch (error) {
		console.warn(
			`[generateMutants] LLM call failed: ${error instanceof Error ? error.message : String(error)}; returning empty patch set`,
		);
		return [];
	} finally {
		cleanup();
	}
}
