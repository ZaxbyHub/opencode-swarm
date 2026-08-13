/**
 * Write drift evidence tool for persisting drift verification results.
 * Accepts phase, verdict, and summary from the Architect and writes
 * a gate-contract formatted evidence file.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	getProfileLookupForIdentity,
	lockProfileForIdentity,
} from '../db/qa-gate-profile.js';
import {
	isAcceptedVerdict2,
	normalizeVerdict2,
	VERDICT_SET_2,
} from '../evidence/normalize-verdict';
import { validateSwarmPath } from '../hooks/utils';
import { takeSnapshotEvent } from '../plan/ledger';
import { loadPlanJsonOnly } from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import { formatLegacyQaBindingRecovery } from '../qa-gate/recovery.js';
import * as logger from '../utils/logger.js';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache.js';
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
	/** Agent name that produced this evidence (optional provenance) */
	provenanceAgentName?: string;
	/** Session ID of the agent that produced this evidence (optional provenance) */
	provenanceSessionId?: string;
}

interface ApprovalPreflightFailure {
	reason: string;
	message: string;
	recovery_guidance: string;
}

function buildApprovedPreflightFailure(
	phase: number,
	failure: ApprovalPreflightFailure,
): string {
	return JSON.stringify(
		{
			success: false,
			phase,
			reason: failure.reason,
			message: failure.message,
			recovery_guidance: failure.recovery_guidance,
		},
		null,
		2,
	);
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

	// Validate verdict is one of the allowed values (derived from shared module)
	if (!isAcceptedVerdict2(args.verdict)) {
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
	const normalizedVerdict = _internals.normalizeVerdict2(args.verdict);

	let approvedPlan: Awaited<ReturnType<typeof loadPlanJsonOnly>> | null = null;
	let snapshotInfo:
		| { seq: number; timestamp: string; locked_by_snapshot_seq: number }
		| undefined;
	let qaProfileLocked:
		| { plan_id: string; locked_at: string; locked_by_snapshot_seq: number }
		| undefined;

	if (normalizedVerdict === 'approved') {
		approvedPlan = await loadPlanJsonOnly(directory);
		if (!approvedPlan) {
			return buildApprovedPreflightFailure(phase, {
				reason: 'plan_required_for_approval',
				message:
					'PLAN_REQUIRED_FOR_APPROVAL: plan.json must exist before APPROVED drift evidence can be persisted.',
				recovery_guidance:
					'Restore the current .swarm/plan.json and ensure the exact plan identity is available before retrying write_drift_evidence.',
			});
		}

		const profileLookup = getProfileLookupForIdentity(directory, approvedPlan);
		if (profileLookup.kind === 'missing') {
			return buildApprovedPreflightFailure(phase, {
				reason: 'qa_gate_selection_required',
				message:
					'QA_GATE_SELECTION_REQUIRED: no durable QA gate selection exists for this exact plan identity.',
				recovery_guidance: `Call set_qa_gates with swarm_id=${JSON.stringify(approvedPlan.swarm)} and plan_title=${JSON.stringify(approvedPlan.title)} before retrying write_drift_evidence with the identical identity.`,
			});
		}
		if (profileLookup.kind === 'unbound_legacy') {
			return buildApprovedPreflightFailure(phase, {
				reason: 'qa_gate_identity_unbound',
				message:
					'QA_GATE_IDENTITY_UNBOUND: the current plan has a legacy QA gate profile row that is not exact-bound.',
				recovery_guidance: formatLegacyQaBindingRecovery(
					{ swarm: approvedPlan.swarm, title: approvedPlan.title },
					'retry write_drift_evidence with the identical identity',
				),
			});
		}

		try {
			// Persist a non-approved content anchor before locking the immutable QA
			// profile. Publishing the visible critic_approved marker first would leave
			// a durable approval behind if the subsequent profile lock failed.
			const lockAnchor = await takeSnapshotEvent(directory, approvedPlan, {
				source: 'drift_approval_prelock',
			});

			const planId = derivePlanId(approvedPlan);
			const locked = _internals.lockProfileForIdentity(
				directory,
				approvedPlan,
				lockAnchor.seq,
			);
			const lockedBySnapshotSeq =
				locked.locked_by_snapshot_seq ?? lockAnchor.seq;

			const approvedSnapshot = await takeSnapshotEvent(
				directory,
				approvedPlan,
				{
					source: 'critic_approved',
					approvalMetadata: {
						phase,
						verdict: 'APPROVED',
						summary: summary.trim(),
						approved_at: new Date().toISOString(),
						locked_by_snapshot_seq: lockedBySnapshotSeq,
					},
				},
			);
			snapshotInfo = {
				seq: approvedSnapshot.seq,
				timestamp: approvedSnapshot.timestamp,
				locked_by_snapshot_seq: lockedBySnapshotSeq,
			};

			qaProfileLocked = {
				plan_id: planId,
				locked_at: locked.locked_at ?? '',
				locked_by_snapshot_seq: locked.locked_by_snapshot_seq ?? -1,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.log(
				'[write_drift_evidence] critic-approved persistence failed:',
				message,
			);
			return buildApprovedPreflightFailure(phase, {
				reason: 'approval_persistence_failed',
				message: `APPROVAL_PERSISTENCE_FAILED: QA gate profile lock or critic-approved snapshot failed: ${message}`,
				recovery_guidance:
					'Resolve the ledger or QA profile persistence failure, then rerun write_drift_evidence. A completed profile lock is idempotent, and no visible approval is published until both persistence steps succeed.',
			});
		}
	}

	// Build provenance if provided
	const provenance =
		args.provenanceAgentName || args.provenanceSessionId
			? {
					agent_name: args.provenanceAgentName,
					session_id: args.provenanceSessionId,
					captured_at: new Date().toISOString(),
				}
			: undefined;

	// Build the evidence entry
	const evidenceEntry = {
		type: 'drift-verification',
		verdict: normalizedVerdict,
		summary: summary.trim(),
		timestamp: new Date().toISOString(),
		requirementCoverage: args.requirementCoverage,
		...(provenance ? { provenance } : {}),
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
		invalidateCachedArtifact(validatedPath);

		return JSON.stringify(
			{
				success: true,
				phase: phase,
				verdict: normalizedVerdict,
				message: `Drift evidence written to .swarm/evidence/${phase}/drift-verifier.json`,
				approvedSnapshot: snapshotInfo,
				qaProfileLocked,
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
 * Dependency-injection seam for testing. Tests can temporarily replace these
 * to verify that this writer delegates to the shared normalize-verdict module.
 * Restore each entry in afterEach via the saved original reference.
 */
export const _internals = {
	normalizeVerdict2,
	VERDICT_SET_2,
	isAcceptedVerdict2,
	lockProfileForIdentity,
};

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
			.enum(VERDICT_SET_2 as [string, ...string[]])
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
		provenanceAgentName: z
			.string()
			.min(1)
			.optional()
			.describe('Agent name that produced this evidence (optional provenance)'),
		provenanceSessionId: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Session ID of the agent that produced this evidence (optional provenance)',
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
				provenanceAgentName:
					args.provenanceAgentName !== undefined
						? String(args.provenanceAgentName)
						: undefined,
				provenanceSessionId:
					args.provenanceSessionId !== undefined
						? String(args.provenanceSessionId)
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
