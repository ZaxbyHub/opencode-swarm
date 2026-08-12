import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readLaneOutput } from '../background/lane-output-store.js';
import { findByBatchId } from '../background/pending-delegations.js';
import {
	buildPrReviewTriggerReceiptV2,
	PrReviewWriterInputRowSchema,
	validatePrReviewInlineTriggerLedger,
	validatePrReviewPersistedInputLedger,
	validatePrReviewWriterInputLedger,
} from '../background/pr-review-trigger-contract.js';
import {
	resolveExactMergeBase,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
} from '../background/workspace-snapshot.js';
import {
	assertPrReviewBaseCoverageSettled,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_MICRO_LANE_FLOORS,
	prReviewDiscoveryArtifactCoversLane,
	readPrWorkflowGateState,
} from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils';
import { createSwarmTool } from './create-tool';

export { PR_REVIEW_TRIGGER_DEFINITIONS } from '../background/pr-review-trigger-contract.js';

export const _internals = {
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
	resolveMergeBase: resolveExactMergeBase,
};

/**
 * Production uses the non-blocking, chunked digest implementation; the three
 * blocking `spawnSync` git calls plus a full re-read of every changed file do
 * not belong on a tool call's synchronous path. The synchronous member stays as
 * the injection seam existing focused tests stub, and is selected only while it
 * is overridden — mirroring `resolvePrWorkflowRevisionDigestForGate` in the
 * gate itself.
 */
async function resolveCurrentRevisionDigest(
	directory: string,
	prHeadSha: string,
): Promise<string | null> {
	if (
		_internals.resolvePrWorkflowRevisionDigest !==
		resolvePrWorkflowRevisionDigest
	) {
		return _internals.resolvePrWorkflowRevisionDigest(directory, prHeadSha);
	}
	return _internals.resolvePrWorkflowRevisionDigestAsync(directory, prHeadSha);
}

const WritePrReviewTriggerEvalArgsSchema = z
	.object({
		run_id: z
			.string()
			.regex(
				/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
				'run_id must be a safe relative identifier',
			),
		pr_head_sha: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{6,64}$/i),
		base_sha: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{6,64}$/i)
			.optional(),
		base_ref: z
			.string()
			.trim()
			.regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/)
			.optional(),
		rows: z.array(PrReviewWriterInputRowSchema).min(1),
	})
	.strict();

export type WritePrReviewTriggerEvalArgs = z.infer<
	typeof WritePrReviewTriggerEvalArgsSchema
>;

function failure(message: string): string {
	return JSON.stringify({ success: false, message }, null, 2);
}

/** Validate and atomically persist the complete PR-review trigger evaluation. */
export async function executeWritePrReviewTriggerEval(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	let writerLedger: ReturnType<typeof validatePrReviewWriterInputLedger>;
	try {
		writerLedger = validatePrReviewWriterInputLedger(
			typeof args === 'object' && args !== null
				? (args as { rows?: unknown }).rows
				: undefined,
		);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	const parsed = WritePrReviewTriggerEvalArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			`Invalid trigger evaluation: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}

	const sessionID = context.sessionID?.trim();
	if (!sessionID) {
		return failure(
			'PR_REVIEW trigger evaluation requires the current session to have an active, bound PR_REVIEW gate',
		);
	}
	let gateState: Awaited<ReturnType<typeof readPrWorkflowGateState>>;
	try {
		gateState = await readPrWorkflowGateState(directory, sessionID);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	if (gateState?.mode !== 'PR_REVIEW' || !gateState.prHeadSha) {
		return failure(
			'PR_REVIEW trigger evaluation requires the current session to have an active, bound PR_REVIEW gate',
		);
	}
	if (gateState.prHeadSha !== parsed.data.pr_head_sha) {
		return failure(
			`PR_REVIEW trigger evaluation head mismatch: expected ${gateState.prHeadSha}, received ${parsed.data.pr_head_sha}`,
		);
	}
	// Fail fast on a run_id that disagrees with an already-bound run, before the
	// expensive classification/provenance validation. Mirrors the findings writer
	// pre-check (`write-pr-review-artifact.ts`) and closes issue #2124.
	if (
		gateState.prReviewArtifactRunId &&
		gateState.prReviewArtifactRunId !== parsed.data.run_id
	) {
		return failure(
			`PR_REVIEW trigger evaluation run_id must match the findings artifact run "${gateState.prReviewArtifactRunId}"`,
		);
	}
	if (
		gateState.prReviewTriggerEvalRunId &&
		gateState.prReviewTriggerEvalRunId !== parsed.data.run_id
	) {
		return failure(
			`PR_REVIEW trigger evaluation is already bound to run "${gateState.prReviewTriggerEvalRunId}"`,
		);
	}
	try {
		await assertPrReviewBaseCoverageSettled(directory, sessionID);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	if (!gateState.prReviewTriggerLedger) {
		return failure(
			'PR_REVIEW trigger evaluation requires the canonical ledger frozen by the first micro dispatch',
		);
	}
	let frozenLedger: ReturnType<typeof validatePrReviewInlineTriggerLedger>;
	try {
		frozenLedger = validatePrReviewInlineTriggerLedger(
			gateState.prReviewTriggerLedger,
		);
	} catch (error) {
		return failure(
			`Persisted PR_REVIEW trigger ledger is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const classificationDrift = frozenLedger.rows
		.filter((row, index) => writerLedger.rows[index]?.result !== row.result)
		.map((row) => row.trigger_id);
	if (classificationDrift.length > 0) {
		return failure(
			`PR_REVIEW trigger classification drift from the canonical ledger frozen across micro dispatches: ${classificationDrift.join(', ')}`,
		);
	}
	let triggerLedger: ReturnType<typeof validatePrReviewPersistedInputLedger>;
	try {
		triggerLedger = validatePrReviewPersistedInputLedger(
			frozenLedger.rows.map((frozenRow, index) => {
				const writerRow = writerLedger.rows[index];
				if (frozenRow.result === 'NOT_TRIGGERED') return frozenRow;
				if (!writerRow || writerRow.result !== 'MATCHED') {
					throw new Error(
						`missing MATCHED provenance for ${frozenRow.trigger_id}`,
					);
				}
				return {
					...frozenRow,
					source_batch_id: writerRow.source_batch_id,
					source_lane_id: writerRow.source_lane_id,
				};
			}),
		);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	const validatedRows = triggerLedger.rows;

	// One dispatch tuple may back several rows only when the dispatched lane
	// declared consolidated ownership of exactly those families; the per-row
	// record validation below enforces ownership containment and all-owned
	// artifact attestation, so a lane can never lend provenance to a family it
	// did not declare and fully attest.
	const currentRevisionDigest = await resolveCurrentRevisionDigest(
		directory,
		parsed.data.pr_head_sha,
	);
	if (!currentRevisionDigest) {
		return failure(
			'Active PR_REVIEW trigger evaluation could not bind the current exact revision digest',
		);
	}
	// Two different (batchId, laneId) tuples cited across the row set must never
	// declare overlapping ownedWorkflowLanes: nothing else enforces that two
	// independently-dispatched micro batches stay disjoint over time, and an
	// overlap would let both artifacts legitimately back the same family,
	// duplicating (or reintroducing stale) content for it downstream.
	const citedLaneOwnership = new Map<string, string[]>();
	for (const row of validatedRows) {
		if (row.result !== 'MATCHED') continue;
		const records = findByBatchId(directory, row.source_batch_id!, {
			parentSessionId: sessionID,
		});
		const record = records.find(
			(candidate) => candidate.laneId === row.source_lane_id,
		);
		const recordOwnedLanes = record?.ownedWorkflowLanes?.length
			? record.ownedWorkflowLanes
			: record?.workflowLane
				? [record.workflowLane]
				: [];
		citedLaneOwnership.set(
			`${row.source_batch_id}\0${row.source_lane_id}`,
			recordOwnedLanes,
		);
		const outputRef = record?.result?.outputRef?.trim();
		const outputArtifact = outputRef
			? readLaneOutput(directory, outputRef)
			: null;
		if (
			!record ||
			record.mode !== 'swarm-pr-review:micro' ||
			!recordOwnedLanes.includes(row.trigger_id) ||
			record.status !== 'completed' ||
			record.result?.outputDegraded === true ||
			record.result?.transcriptIncomplete === true ||
			record.result?.truncated === true ||
			(record.result?.chars ?? 0) <= 0 ||
			!record.result?.digest?.trim() ||
			!record.result?.outputRef?.trim() ||
			!outputArtifact ||
			outputArtifact.artifact.batchId !== row.source_batch_id ||
			outputArtifact.artifact.laneId !== row.source_lane_id ||
			outputArtifact.artifact.mode !== 'swarm-pr-review:micro' ||
			outputArtifact.artifact.sessionId !== record.subagentSessionId ||
			outputArtifact.artifact.parentSessionId !== record.parentSessionId ||
			outputArtifact.artifact.agent !== record.swarmPrefixedAgent ||
			outputArtifact.artifact.role !== record.normalizedAgent ||
			outputArtifact.artifact.source !== 'collect_lane_results' ||
			outputArtifact.artifact.workflowLane !== record.workflowLane ||
			outputArtifact.artifact.prHeadSha !== record.workspace?.prHeadSha ||
			outputArtifact.artifact.gitHead !== record.workspace?.gitHead ||
			outputArtifact.artifact.revisionDigest !== currentRevisionDigest ||
			outputArtifact.artifact.digest !== record.result?.digest ||
			outputArtifact.artifact.chars !== record.result?.chars ||
			!recordOwnedLanes.every((ownedFamily) =>
				prReviewDiscoveryArtifactCoversLane(
					outputArtifact.artifact.text,
					ownedFamily,
					recordOwnedLanes,
					record.mode,
				),
			) ||
			record.workspace?.prHeadSha !== parsed.data.pr_head_sha ||
			record.workspace?.gitHead !== parsed.data.pr_head_sha
		) {
			return failure(
				`MATCHED trigger ${row.trigger_id} does not reference a completed non-degraded micro-lane artifact`,
			);
		}
	}
	const citedLaneEntries = [...citedLaneOwnership.entries()];
	for (let i = 0; i < citedLaneEntries.length; i++) {
		for (let j = i + 1; j < citedLaneEntries.length; j++) {
			const [keyA, ownedA] = citedLaneEntries[i];
			const [keyB, ownedB] = citedLaneEntries[j];
			const overlap = ownedA.filter((family) => ownedB.includes(family));
			if (overlap.length > 0) {
				return failure(
					`PR_REVIEW trigger evaluation cites two lanes with overlapping ownership: "${keyA}" and "${keyB}" both declare ${overlap.join(', ')}`,
				);
			}
		}
	}
	const matchedFamilySet = new Set<string>(triggerLedger.matchedIds);
	const citedOwnershipSet = new Set(
		citedLaneEntries.flatMap(([, owned]) => owned),
	);
	const ownershipOutsideMatchedLedger = [...citedOwnershipSet].filter(
		(family) => !matchedFamilySet.has(family),
	);
	const matchedWithoutOwnedLane = [...matchedFamilySet].filter(
		(family) => !citedOwnershipSet.has(family),
	);
	if (
		ownershipOutsideMatchedLedger.length > 0 ||
		matchedWithoutOwnedLane.length > 0
	) {
		return failure(
			`PR_REVIEW cited lane ownership must equal the MATCHED trigger set; owned but NOT_TRIGGERED/unlisted: ${ownershipOutsideMatchedLedger.join(', ') || '(none)'}; MATCHED without cited ownership: ${matchedWithoutOwnedLane.join(', ') || '(none)'}`,
		);
	}
	if (!parsed.data.base_sha) {
		return failure(
			'Active PR_REVIEW trigger evaluation requires the exact merge-base base_sha',
		);
	}
	if (!parsed.data.base_ref) {
		return failure(
			'Active PR_REVIEW trigger evaluation requires the exact live base_ref used to verify base_sha',
		);
	}
	const resolvedMergeBase = _internals.resolveMergeBase(
		directory,
		parsed.data.base_ref,
		parsed.data.pr_head_sha,
	);
	if (!resolvedMergeBase) {
		return failure(
			'Active PR_REVIEW trigger evaluation could not resolve the exact merge base from base_ref and pr_head_sha',
		);
	}
	if (resolvedMergeBase.toLowerCase() !== parsed.data.base_sha.toLowerCase()) {
		return failure(
			`PR_REVIEW merge-base mismatch: expected ${resolvedMergeBase}, received ${parsed.data.base_sha}`,
		);
	}
	if (
		gateState.prReviewBaseRef !== parsed.data.base_ref ||
		gateState.prReviewBaseSha !== parsed.data.base_sha.toLowerCase()
	) {
		return failure(
			`PR_REVIEW trigger evaluation scope mismatch: workflow is bound to ${gateState.prReviewBaseRef ?? '(unbound)'} at ${gateState.prReviewBaseSha ?? '(unbound)'}, received ${parsed.data.base_ref} at ${parsed.data.base_sha}`,
		);
	}

	const matchedCount = validatedRows.filter(
		(row) => row.result === 'MATCHED',
	).length;
	const dispatchedMicroLaneCount = new Set(
		validatedRows
			.filter((row) => row.result === 'MATCHED')
			.map((row) => `${row.source_batch_id}\0${row.source_lane_id}`),
	).size;
	// Aggregate per-tier micro-lane floor on the durable attestation. The final
	// ledger attributes every MATCHED family to a distinct dispatch tuple while
	// retaining NOT_TRIGGERED families as provenance-free rows.
	// Normal one-for-one lane retries preserve the count, so legitimate flows are
	// never rejected; only a final attestation that under-consolidates the matched
	// set into fewer than the floor's worth of independent lanes is blocked —
	// which is exactly the gap this gate closes (including split-batch dodges that
	// slip past the per-batch dispatch floor).
	const microFloor = Math.min(
		PR_REVIEW_MICRO_LANE_FLOORS[gateState.prReviewDepthTier ?? 'L'],
		matchedCount,
	);
	if (dispatchedMicroLaneCount < microFloor) {
		return failure(
			`PR_REVIEW micro lane floor unmet: depth tier ${
				gateState.prReviewDepthTier ?? 'L'
			} requires at least ${microFloor} dispatched micro lane(s) across the attestation; the ledger attributes ${matchedCount} matched families to only ${dispatchedMicroLaneCount}`,
		);
	}
	const artifact = buildPrReviewTriggerReceiptV2({
		run_id: parsed.data.run_id,
		pr_head_sha: parsed.data.pr_head_sha,
		base_ref: parsed.data.base_ref,
		base_sha: parsed.data.base_sha,
		evaluated_at: new Date().toISOString(),
		dispatched_micro_lane_count: dispatchedMicroLaneCount,
		rows: validatedRows,
	});

	const relativePath = path.join(
		'pr-review',
		parsed.data.run_id,
		'trigger-eval.json',
	);
	let destination: string;
	try {
		destination = validateSwarmPath(directory, relativePath);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	// The receipt is a tamper-evident coverage proof consumed once per run. A
	// repeat write for the same run_id must NOT silently replace the prior
	// receipt: `fs.rename` clobbers an existing destination, so refuse an existing
	// destination before writing. This guard closes the single-session retry
	// threat (#2124's scope): tool calls within a session are serialized, so the
	// check-then-rename has no intra-session race. A residual cross-session
	// TOCTOU remains (two sessions writing the same path concurrently) — that is
	// out of scope and is also bounded by the per-run binding above. Recovery is
	// `abort_pr_workflow` (see "Aborting an unrecoverable review" in the skill).
	if (fs.existsSync(destination)) {
		return failure(
			`PR_REVIEW trigger evaluation receipt already exists for run "${parsed.data.run_id}" and cannot be overwritten; abort the workflow with abort_pr_workflow to restart`,
		);
	}

	const parent = path.dirname(destination);
	const tempPath = path.join(parent, `.trigger-eval.${randomUUID()}.tmp`);
	try {
		await fs.promises.mkdir(parent, { recursive: true });
		await fs.promises.writeFile(
			tempPath,
			`${JSON.stringify(artifact, null, 2)}\n`,
			{ encoding: 'utf-8', flag: 'wx' },
		);
		await fs.promises.rename(tempPath, destination);
	} catch (error) {
		return failure(
			`Failed to persist trigger evaluation: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
	}
	await markPrReviewTriggerEvaluationComplete(
		directory,
		sessionID,
		parsed.data.run_id,
		relativePath.split(path.sep).join('/'),
	);

	return JSON.stringify(
		{
			success: true,
			path: relativePath.split(path.sep).join('/'),
			trigger_count: artifact.trigger_count,
			matched_count: artifact.matched_count,
			not_triggered_count: artifact.not_triggered_count,
			no_match_count: artifact.no_match_count,
			dispatched_micro_lane_count: dispatchedMicroLaneCount,
		},
		null,
		2,
	);
}

export const write_pr_review_trigger_eval: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Persist the complete, exact-set PR-review trigger receipt after every MATCHED family has completed. Supply classifications and MATCHED provenance; evidence is optional and non-authoritative because the receipt reuses evidence frozen by the first micro dispatch. NOT_TRIGGERED families remain provenance-free.',
		args: {
			run_id: WritePrReviewTriggerEvalArgsSchema.shape.run_id,
			pr_head_sha: WritePrReviewTriggerEvalArgsSchema.shape.pr_head_sha,
			base_sha: WritePrReviewTriggerEvalArgsSchema.shape.base_sha,
			base_ref: WritePrReviewTriggerEvalArgsSchema.shape.base_ref,
			rows: WritePrReviewTriggerEvalArgsSchema.shape.rows,
		},
		execute: executeWritePrReviewTriggerEval,
	});
