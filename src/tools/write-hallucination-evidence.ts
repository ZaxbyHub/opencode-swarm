/**
 * Write hallucination evidence tool for persisting hallucination verification results.
 * Accepts phase, verdict, and summary from the Architect and writes
 * a gate-contract formatted evidence file.
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
 * Arguments for the write_hallucination_evidence tool
 */
export interface WriteHallucinationEvidenceArgs {
	/** The phase number for the hallucination verification */
	phase: number;
	/** Verdict of the hallucination verification: 'APPROVED' or 'NEEDS_REVISION' */
	verdict: 'APPROVED' | 'NEEDS_REVISION';
	/** Human-readable summary of the hallucination verification */
	summary: string;
	/** Optional bullet list of FABRICATED/DRIFTED/UNSUPPORTED/BROKEN findings */
	findings?: string;
}

/**
 * Normalize verdict string to lowercase format
 */
function normalizeVerdict(verdict: string): 'approved' | 'rejected' {
	switch (verdict) {
		case 'APPROVED':
			return 'approved';
		case 'NEEDS_REVISION':
			return 'rejected';
		default:
			throw new Error(
				`Invalid verdict: must be 'APPROVED' or 'NEEDS_REVISION', got '${verdict}'`,
			);
	}
}

/**
 * Execute the write_hallucination_evidence tool.
 */
export async function executeWriteHallucinationEvidence(
	args: WriteHallucinationEvidenceArgs,
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

	const validVerdicts = ['APPROVED', 'NEEDS_REVISION'] as const;
	if (!validVerdicts.includes(args.verdict)) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: "Invalid verdict: must be 'APPROVED' or 'NEEDS_REVISION'",
			},
			null,
			2,
		);
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

	const evidenceEntry = {
		type: 'hallucination-verification',
		verdict: normalizedVerdict,
		summary: summary.trim(),
		timestamp: new Date().toISOString(),
		findings: args.findings,
	};

	const evidenceContent = {
		entries: [evidenceEntry],
	};

	const filename = 'hallucination-guard.json';
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
				message: `Hallucination evidence written to .swarm/evidence/${phase}/hallucination-guard.json`,
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
 * Tool definition for write_hallucination_evidence
 */
export const write_hallucination_evidence: ToolDefinition = createSwarmTool({
	description:
		'Write hallucination verification evidence for a completed phase. ' +
		'Normalizes verdict (APPROVED->approved, NEEDS_REVISION->rejected) and writes ' +
		'a gate-contract formatted EvidenceBundle to .swarm/evidence/{phase}/hallucination-guard.json. ' +
		'Use this after critic_hallucination_verifier delegation to persist the verification result. ' +
		'Unlike write_drift_evidence, this tool does NOT lock the QA gate profile.',
	args: {
		phase: z
			.number()
			.int()
			.min(1)
			.describe(
				'The phase number for the hallucination verification (e.g., 1, 2, 3)',
			),
		verdict: z
			.enum(['APPROVED', 'NEEDS_REVISION'])
			.describe(
				"Verdict of the hallucination verification: 'APPROVED' or 'NEEDS_REVISION'",
			),
		summary: z
			.string()
			.describe('Human-readable summary of the hallucination verification'),
		findings: z
			.string()
			.optional()
			.describe(
				'Optional bullet list of FABRICATED/DRIFTED/UNSUPPORTED/BROKEN findings (for NEEDS_REVISION)',
			),
	},
	execute: async (args, directory) => {
		const rawPhase = args.phase !== undefined ? Number(args.phase) : 0;
		try {
			const typedArgs: WriteHallucinationEvidenceArgs = {
				phase: Number(args.phase),
				verdict: String(args.verdict) as 'APPROVED' | 'NEEDS_REVISION',
				summary: String(args.summary ?? ''),
				findings:
					args.findings !== undefined ? String(args.findings) : undefined,
			};
			return await executeWriteHallucinationEvidence(typedArgs, directory);
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
