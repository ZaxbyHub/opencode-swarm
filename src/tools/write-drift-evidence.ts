/**
 * Write drift evidence tool for persisting drift verification results.
 * Accepts phase, verdict, and summary from the Architect and writes
 * a gate-contract formatted evidence file.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { lockProfile } from '../db/qa-gate-profile.js';
import { validateSwarmPath } from '../hooks/utils';
import { takeSnapshotEvent } from '../plan/ledger';
import { loadPlanJsonOnly } from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the write_drift_evidence tool
 */
export interface WriteDriftEvidenceArgs {
	/** The phase number for the drift verification */
	phase: number;
	/** Verdict of the drift verification: 'APPROVED' or 'NEEDS_REVISION' */
	verdict: 'APPROVED' | 'NEEDS_REVISION';
	/** Human-readable summary of the drift verification */
	summary: string;
	/** Requirement coverage report from req_coverage tool */
	requirementCoverage?: string;
}

/**
 * Normalize verdict string to lowercase format
 * @param verdict - Raw verdict from caller
 * @returns Normalized verdict: 'approved' | 'rejected'
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
 * Execute the write_drift_evidence tool.
 * Validates input, builds a gate-contract entry, and writes to disk.
 * @param args - The write drift evidence arguments
 * @param directory - Working directory
 * @returns JSON string with success status and details
 */
export async function executeWriteDriftEvidence(
	args: WriteDriftEvidenceArgs,
	directory: string,
): Promise<string> {
	// Validate phase is a positive integer
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

	// Validate verdict is one of the allowed values
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

	// Validate summary is non-empty string
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

	// Normalize verdict
	const normalizedVerdict = normalizeVerdict(args.verdict);

	// Build the evidence entry
	const evidenceEntry = {
		type: 'drift-verification',
		verdict: normalizedVerdict,
		summary: summary.trim(),
		timestamp: new Date().toISOString(),
		requirementCoverage: args.requirementCoverage,
	};

	// Build the gate-contract format
	const evidenceContent = {
		entries: [evidenceEntry],
	};

	// Validate and construct the file path using validateSwarmPath
	const filename = 'drift-verifier.json';
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

	// Write the evidence file
	try {
		// Ensure the directory exists
		await fs.promises.mkdir(evidenceDir, { recursive: true });

		// Write the file atomically by writing to a temp file then renaming
		const tempPath = path.join(evidenceDir, `.${filename}.tmp`);
		await fs.promises.writeFile(
			tempPath,
			JSON.stringify(evidenceContent, null, 2),
			'utf-8',
		);
		await fs.promises.rename(tempPath, validatedPath);

		// On APPROVED: write an immutable plan snapshot to the append-only ledger
		// tagged source='critic_approved'. This provides a durable fallback the
		// Architect can restore from, and a reference point the Critic can
		// drift-check against. Snapshot errors are non-fatal — the drift evidence
		// write has already succeeded.
		let snapshotInfo: { seq: number; timestamp: string } | undefined;
		let snapshotError: string | undefined;
		let qaProfileLocked:
			| { plan_id: string; locked_at: string; locked_by_snapshot_seq: number }
			| undefined;
		let qaProfileLockError: string | undefined;
		if (normalizedVerdict === 'approved') {
			try {
				const currentPlan = await loadPlanJsonOnly(directory);
				if (currentPlan) {
					const snapshotEvent = await takeSnapshotEvent(
						directory,
						currentPlan,
						{
							source: 'critic_approved',
							approvalMetadata: {
								phase,
								verdict: 'APPROVED',
								summary: summary.trim(),
								approved_at: new Date().toISOString(),
							},
						},
					);
					snapshotInfo = {
						seq: snapshotEvent.seq,
						timestamp: snapshotEvent.timestamp,
					};

					// Lock the QA gate profile to the approved snapshot. Non-fatal:
					// snapshot + evidence write already succeeded. If no profile
					// exists yet (approval before the architect touched gates), skip
					// silently — the get_approved_plan drift check tolerates a null
					// qa_profile_hash.
					try {
						const planId = derivePlanId(currentPlan);
						const locked = lockProfile(directory, planId, snapshotEvent.seq);
						qaProfileLocked = {
							plan_id: planId,
							locked_at: locked.locked_at ?? '',
							locked_by_snapshot_seq: locked.locked_by_snapshot_seq ?? -1,
						};
					} catch (lockErr) {
						const msg =
							lockErr instanceof Error ? lockErr.message : String(lockErr);
						// A missing profile is expected when gates were never configured.
						if (!/No QA gate profile/i.test(msg)) {
							qaProfileLockError = msg;
							console.warn(
								'[write_drift_evidence] QA gate profile lock failed:',
								msg,
							);
						}
					}
				} else {
					snapshotError = 'plan.json not available for snapshot';
				}
			} catch (err) {
				snapshotError = err instanceof Error ? err.message : String(err);
				console.warn(
					'[write_drift_evidence] critic-approved snapshot failed:',
					snapshotError,
				);
			}
		}

		return JSON.stringify(
			{
				success: true,
				phase: phase,
				verdict: normalizedVerdict,
				message: `Drift evidence written to .swarm/evidence/${phase}/drift-verifier.json`,
				approvedSnapshot: snapshotInfo,
				snapshotError,
				qaProfileLocked,
				qaProfileLockError,
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
 * Tool definition for write_drift_evidence
 */
export const write_drift_evidence: ToolDefinition = createSwarmTool({
	description:
		'Write drift verification evidence for a completed phase. ' +
		'Normalizes verdict (APPROVED->approved, NEEDS_REVISION->rejected) and writes ' +
		'a gate-contract formatted EvidenceBundle to .swarm/evidence/{phase}/drift-verifier.json. ' +
		'Use this after critic_drift_verifier delegation to persist the verification result.',
	args: {
		phase: z
			.number()
			.int()
			.min(1)
			.describe('The phase number for the drift verification (e.g., 1, 2, 3)'),
		verdict: z
			.enum(['APPROVED', 'NEEDS_REVISION'])
			.describe(
				"Verdict of the drift verification: 'APPROVED' or 'NEEDS_REVISION'",
			),
		summary: z
			.string()
			.describe('Human-readable summary of the drift verification'),
		requirementCoverage: z
			.string()
			.optional()
			.describe(
				'Requirement coverage report from req_coverage tool (JSON string)',
			),
	},
	execute: async (args, directory) => {
		const rawPhase = args.phase !== undefined ? Number(args.phase) : 0;
		try {
			const writeDriftEvidenceArgs: WriteDriftEvidenceArgs = {
				phase: Number(args.phase),
				verdict: String(args.verdict) as 'APPROVED' | 'NEEDS_REVISION',
				summary: String(args.summary ?? ''),
				requirementCoverage:
					args.requirementCoverage !== undefined
						? String(args.requirementCoverage)
						: undefined,
			};
			return await executeWriteDriftEvidence(writeDriftEvidenceArgs, directory);
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
