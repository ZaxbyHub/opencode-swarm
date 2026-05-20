/**
 * Write mutation evidence tool for persisting mutation testing gate results.
 * Accepts phase, verdict, killRate, adjustedKillRate, and summary from the Architect
 * and writes a gate-contract formatted evidence file.
 *
 * Unlike write_drift_evidence, this tool does NOT lock the QA gate profile or
 * write a plan snapshot — those side-effects belong to drift verification only.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the write_mutation_evidence tool
 */
export interface WriteMutationEvidenceArgs {
	/** The phase number for the mutation gate */
	phase: number;
	/** Verdict of the mutation gate: 'PASS', 'WARN', 'FAIL', or 'SKIP' */
	verdict: 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
	/** The raw kill rate (e.g., 0.85) */
	killRate?: number;
	/** The adjusted kill rate accounting for timeout survived mutants (e.g., 0.87) */
	adjustedKillRate?: number;
	/** Human-readable summary of the mutation gate result */
	summary: string;
	/** Optional JSON-serialized list of survived mutants */
	survivedMutants?: string;
}

/**
 * Normalize verdict string to lowercase format
 */
function normalizeVerdict(verdict: string): 'pass' | 'warn' | 'fail' | 'skip' {
	switch (verdict) {
		case 'PASS':
			return 'pass';
		case 'WARN':
			return 'warn';
		case 'FAIL':
			return 'fail';
		case 'SKIP':
			return 'skip';
		default:
			throw new Error(
				`Invalid verdict: must be 'PASS', 'WARN', 'FAIL', or 'SKIP', got '${verdict}'`,
			);
	}
}

/**
 * Execute the write_mutation_evidence tool.
 */
export async function executeWriteMutationEvidence(
	args: WriteMutationEvidenceArgs,
	directory: string,
): Promise<string> {
	const phase = args.phase;
	if (!Number.isInteger(phase) || phase < 1) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid phase: must be a positive integer',
			},
			null,
			2,
		);
	}

	const validVerdicts = ['PASS', 'WARN', 'FAIL', 'SKIP'] as const;
	if (!validVerdicts.includes(args.verdict)) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: "Invalid verdict: must be 'PASS', 'WARN', 'FAIL', or 'SKIP'",
			},
			null,
			2,
		);
	}

	if (args.killRate !== undefined) {
		if (typeof args.killRate !== 'number' || Number.isNaN(args.killRate)) {
			return JSON.stringify(
				{
					success: false,
					phase: phase,
					message: 'Invalid killRate: must be a number',
				},
				null,
				2,
			);
		}
	}

	if (args.adjustedKillRate !== undefined) {
		if (
			typeof args.adjustedKillRate !== 'number' ||
			Number.isNaN(args.adjustedKillRate)
		) {
			return JSON.stringify(
				{
					success: false,
					phase: phase,
					message: 'Invalid adjustedKillRate: must be a number',
				},
				null,
				2,
			);
		}
	}

	const summary = args.summary;
	if (typeof summary !== 'string' || summary.trim().length === 0) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid summary: must be a non-empty string',
			},
			null,
			2,
		);
	}

	const normalizedVerdict = normalizeVerdict(args.verdict);

	const evidenceEntry: {
		type: 'mutation-gate';
		verdict: 'pass' | 'warn' | 'fail' | 'skip';
		killRate: number;
		adjustedKillRate: number;
		summary: string;
		timestamp: string;
		survivedMutants?: string;
	} = {
		type: 'mutation-gate',
		verdict: normalizedVerdict,
		killRate: args.killRate ?? 0,
		adjustedKillRate: args.adjustedKillRate ?? 0,
		summary: summary.trim(),
		timestamp: new Date().toISOString(),
	};

	if (args.survivedMutants !== undefined) {
		evidenceEntry.survivedMutants = args.survivedMutants;
	}

	const evidenceContent = {
		entries: [evidenceEntry],
	};

	const filename = 'mutation-gate.json';
	const relativePath = path.join('evidence', String(phase), filename);
	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, relativePath);
	} catch (error) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message:
					error instanceof Error ? error.message : 'Failed to validate path',
			},
			null,
			2,
		);
	}

	const evidenceDir = path.dirname(validatedPath);

	try {
		await fs.promises.mkdir(evidenceDir, { recursive: true });

		// Atomic write: temp file then rename to prevent partial reads
		const tempPath = path.join(evidenceDir, `.${filename}.tmp`);
		await fs.promises.writeFile(
			tempPath,
			JSON.stringify(evidenceContent, null, 2),
			'utf-8',
		);
		await fs.promises.rename(tempPath, validatedPath);

		return JSON.stringify(
			{
				success: true,
				phase: phase,
				verdict: normalizedVerdict,
				message: `Mutation gate evidence written to .swarm/evidence/${phase}/mutation-gate.json`,
			},
			null,
			2,
		);
	} catch (error) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: error instanceof Error ? error.message : String(error),
			},
			null,
			2,
		);
	}
}

/**
 * Tool definition for write_mutation_evidence
 */
export const write_mutation_evidence: ToolDefinition = createSwarmTool({
	description:
		'Write mutation gate evidence for a completed phase. Accepts phase, verdict (PASS/WARN/FAIL/SKIP), killRate, adjustedKillRate, summary, and optional survivedMutants. Normalizes uppercase verdicts to lowercase (PASS→pass, WARN→warn, FAIL→fail, SKIP→skip) and writes entries[0].type="mutation-gate" to .swarm/evidence/{phase}/mutation-gate.json using atomic temp+rename write. Use this after mutation_test tool returns to persist the gate verdict.',
	args: {
		phase: z
			.number()
			.int()
			.min(1)
			.describe('The phase number for the mutation gate (e.g., 1, 2, 3)'),
		verdict: z
			.enum(['PASS', 'WARN', 'FAIL', 'SKIP'])
			.describe(
				"Verdict of the mutation gate: 'PASS', 'WARN', 'FAIL', or 'SKIP'",
			),
		killRate: z.number().optional().describe('The raw kill rate (e.g., 0.85)'),
		adjustedKillRate: z
			.number()
			.optional()
			.describe(
				'The adjusted kill rate accounting for timeout survived mutants (e.g., 0.87)',
			),
		summary: z
			.string()
			.describe('Human-readable summary of the mutation gate result'),
		survivedMutants: z
			.string()
			.optional()
			.describe('Optional JSON-serialized list of survived mutants'),
	},
	execute: async (args, directory) => {
		const rawPhase = args.phase !== undefined ? Number(args.phase) : 0;
		try {
			const typedArgs: WriteMutationEvidenceArgs = {
				phase: Number(args.phase),
				verdict: String(args.verdict) as 'PASS' | 'WARN' | 'FAIL' | 'SKIP',
				killRate:
					args.killRate !== undefined ? Number(args.killRate) : undefined,
				adjustedKillRate:
					args.adjustedKillRate !== undefined
						? Number(args.adjustedKillRate)
						: undefined,
				summary: String(args.summary ?? ''),
				survivedMutants:
					args.survivedMutants !== undefined
						? String(args.survivedMutants)
						: undefined,
			};
			return await executeWriteMutationEvidence(typedArgs, directory);
		} catch (error) {
			return JSON.stringify(
				{
					success: false,
					phase: rawPhase,
					message: error instanceof Error ? error.message : 'Unknown error',
				},
				null,
				2,
			);
		}
	},
});
