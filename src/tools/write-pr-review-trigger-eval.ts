import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readLaneOutput } from '../background/lane-output-store.js';
import { findByBatchId } from '../background/pending-delegations.js';
import {
	formatPrReviewRuntimeFieldError,
	formatPrReviewValidationIssues,
	PrReviewRunIdSchema,
} from '../background/pr-review-contract.js';
import {
	buildPrReviewTriggerReceiptV2,
	PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES,
	PrReviewWriterInputRowSchema,
	parsePrReviewTriggerReceipt,
	type TriggerCoverageDegradation,
	validatePrReviewInlineTriggerLedger,
	validatePrReviewPersistedInputLedger,
	validatePrReviewWriterInputLedger,
} from '../background/pr-review-trigger-contract.js';
import {
	resolveExactMergeBase,
	resolveExactMergeBaseAsync,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
} from '../background/workspace-snapshot.js';
import {
	assertPrReviewBaseCoverageSettled,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_MICRO_LANE_FLOORS,
	prReviewDiscoveryArtifactCoversLane,
	readPrWorkflowGateState,
	resolvePrReviewWriterRunId,
} from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils';
import { criticalWarn } from '../utils/logger.js';
import { createSwarmTool } from './create-tool';

export { PR_REVIEW_TRIGGER_DEFINITIONS } from '../background/pr-review-trigger-contract.js';

export const _internals = {
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
	resolveMergeBase: resolveExactMergeBase,
	resolveMergeBaseAsync: resolveExactMergeBaseAsync,
	markPrReviewTriggerEvaluationComplete,
};

type TriggerReceiptV2 = ReturnType<typeof buildPrReviewTriggerReceiptV2>;

function comparableTriggerReceipt(receipt: TriggerReceiptV2): string {
	return JSON.stringify({
		...receipt,
		evaluated_at: undefined,
		base_verification: undefined,
	});
}

async function readBoundedTriggerReceipt(
	destination: string,
): Promise<TriggerReceiptV2> {
	const stat = await fs.promises.stat(destination);
	if (!stat.isFile() || stat.size > PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES) {
		throw new Error(
			`trigger evaluation receipt is not a bounded regular file (max ${PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES} bytes)`,
		);
	}
	const raw = await fs.promises.readFile(destination, 'utf8');
	const bytes = Buffer.byteLength(raw, 'utf8');
	if (bytes > PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES) {
		throw new Error(
			`trigger evaluation receipt exceeds ${PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES} bytes after read (got ${bytes})`,
		);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`trigger evaluation receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	parsePrReviewTriggerReceipt(decoded);
	if ((decoded as { schema_version?: unknown }).schema_version !== 2) {
		throw new Error('trigger evaluation receipt must use schema_version 2');
	}
	return decoded as TriggerReceiptV2;
}

async function createTriggerReceipt(
	destination: string,
	content: string,
): Promise<boolean> {
	const parent = path.dirname(destination);
	const tempPath = path.join(parent, `.trigger-eval.${randomUUID()}.tmp`);
	await fs.promises.mkdir(parent, { recursive: true });
	try {
		await fs.promises.writeFile(tempPath, content, {
			encoding: 'utf8',
			flag: 'wx',
		});
		try {
			await fs.promises.link(tempPath, destination);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
			throw error;
		}
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

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

/**
 * Attempts allowed for the current-revision digest binding (issue #2242 R1).
 *
 * ONE bounded in-call retry. The underlying resolution is a bounded git read
 * that collapses timeout, spawn failure and unreadable-worktree into a single
 * bare `null`, and host contention makes that null transient — a single attempt
 * let one unlucky read end the whole trigger evaluation. Two attempts, never a
 * spin loop: the failure stays per-call and retryable because no durable state
 * is consumed on this path.
 */
const REVISION_DIGEST_RESOLUTION_ATTEMPTS = 2;

/**
 * Bounded retry around {@link resolveCurrentRevisionDigest}.
 *
 * There is deliberately **NO FALLBACK** here, and adding one would be a
 * forgery-enabling change rather than an availability improvement. Unlike the
 * merge-base check below — which degrades to a durably-bound, bind-time-VERIFIED
 * `prReviewBaseSha`/`prReviewBaseRef` — PR_REVIEW has no independently-bound
 * durable revision digest to fall back to: the gate-state digest fields are
 * PR_FEEDBACK's, and the only durable copies of a PR_REVIEW revision digest live
 * on the very lane artifacts this evaluation is validating (circular).
 * `lane-output-store` additionally declares `revisionDigest` optional, so a
 * set-comparison fallback would convert today's fail-closed `undefined !==
 * digest` into a passing `undefined === undefined`. Unavailability degrades only
 * where an independently-bound verified value exists; it does not here.
 */
async function resolveCurrentRevisionDigestWithRetry(
	directory: string,
	prHeadSha: string,
): Promise<string | null> {
	for (
		let attempt = 1;
		attempt <= REVISION_DIGEST_RESOLUTION_ATTEMPTS;
		attempt += 1
	) {
		const digest = await resolveCurrentRevisionDigest(directory, prHeadSha);
		if (digest) return digest;
	}
	return null;
}

/**
 * Same override-detecting seam as {@link resolveCurrentRevisionDigest}: a
 * blocking `spawnSync` git call does not belong on an async tool path, and its
 * 3s bound under host contention was a contributing cause of the transient
 * merge-base failures that wedged PR_REVIEW completion (issue #2242 / RC-B).
 * Production takes the async twin; the synchronous member is selected only
 * while it is overridden, so the six sibling suites that stub it keep working.
 */
async function resolveReviewMergeBase(
	directory: string,
	baseRef: string,
	prHeadSha: string,
): Promise<string | null> {
	if (_internals.resolveMergeBase !== resolveExactMergeBase) {
		return _internals.resolveMergeBase(directory, baseRef, prHeadSha);
	}
	return _internals.resolveMergeBaseAsync(directory, baseRef, prHeadSha);
}

const WritePrReviewTriggerEvalArgsSchema = z
	.object({
		run_id: PrReviewRunIdSchema.optional(),
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
			`Invalid trigger evaluation: ${formatPrReviewValidationIssues(
				parsed.error.issues,
				args,
			).join('; ')}`,
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
			formatPrReviewRuntimeFieldError(
				'pr_head_sha',
				`"${gateState.prHeadSha}"`,
				parsed.data.pr_head_sha,
			),
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
	const currentRevisionDigest = await resolveCurrentRevisionDigestWithRetry(
		directory,
		parsed.data.pr_head_sha,
	);
	if (!currentRevisionDigest) {
		return failure(
			`Active PR_REVIEW trigger evaluation could not bind the current exact revision digest for pr_head_sha "${parsed.data.pr_head_sha}" after ${REVISION_DIGEST_RESOLUTION_ATTEMPTS} attempts. A null digest collapses several causes: the bounded git call timed out, the git process failed to spawn, the working tree could not be read, or pr_head_sha was rejected as an unsafe revision token. This fails closed on purpose and has no bound-value fallback — no independently-bound durable PR_REVIEW revision digest exists to compare against, so accepting an unresolved digest would let a lane artifact self-certify its own revision. Nothing was persisted, so this call is retryable as-is. Recovery: confirm the checkout is readable and pr_head_sha exists here (git rev-parse), retry once the environment settles, or restart with abort_pr_workflow (kind "recovery").`,
		);
	}
	// Two different (batchId, laneId) tuples cited across the row set must never
	// declare overlapping ownedWorkflowLanes: nothing else enforces that two
	// independently-dispatched micro batches stay disjoint over time, and an
	// overlap would let both artifacts legitimately back the same family,
	// duplicating (or reintroducing stale) content for it downstream.
	const citedLaneOwnership = new Map<string, string[]>();
	const coverageDegradations: TriggerCoverageDegradation[] = [];
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
		// Provenance failures stay fail-closed: the cited lane must exist, be a
		// micro lane that declared ownership of this family, and the retained
		// artifact must be the exact, identity-checked output for this run's head.
		// Without this chain any text could back a MATCHED row.
		const provenanceFailure =
			!record ||
			record.mode !== 'swarm-pr-review:micro' ||
			!recordOwnedLanes.includes(row.trigger_id) ||
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
			record.workspace?.prHeadSha !== parsed.data.pr_head_sha ||
			record.workspace?.gitHead !== parsed.data.pr_head_sha;
		if (provenanceFailure) {
			return failure(
				`MATCHED trigger ${row.trigger_id} does not reference a verifiable micro-lane provenance chain`,
			);
		}
		// Coverage-quality failures are tolerated and DISCLOSED on the durable
		// receipt instead of dead-ending the whole review (retries remain the
		// first resort per the skill's COVERAGE GATE). A lane that completed but
		// could not be parsed into covered rows, or that ended failed/cancelled
		// after exhausting retries, still leaves its retained artifact as usable
		// negative context — the synthesis phase must surface every entry
		// recorded here in the final review report.
		const degradationReasons: string[] = [];
		if (record!.status !== 'completed') {
			degradationReasons.push(`lane status ${record!.status}`);
		}
		if (record!.result?.outputDegraded === true) {
			degradationReasons.push('output degraded');
		}
		if (record!.result?.transcriptIncomplete === true) {
			degradationReasons.push('transcript incomplete');
		}
		if (record!.result?.truncated === true) {
			degradationReasons.push('output truncated');
		}
		if ((record!.result?.chars ?? 0) <= 0) {
			degradationReasons.push('empty output');
		}
		// Coverage is checked for THIS row's family only. The lane's other owned
		// families are each checked by their own citing row (ownership==matched-set
		// is enforced below), so stamping a lane-wide uncovered list here would
		// misattribute degradations to covered families on a consolidated lane —
		// the exact shape that motivated this recoverability path. The
		// provenanceFailure gate above already guarantees the row's family is
		// owned by the cited lane, so the ownership check is not repeated here.
		const rowFamilyUncovered = !prReviewDiscoveryArtifactCoversLane(
			outputArtifact!.artifact.text,
			row.trigger_id,
			recordOwnedLanes,
			record!.mode,
		);
		if (rowFamilyUncovered) {
			degradationReasons.push(
				`no covered candidate or clean row for: ${row.trigger_id}`,
			);
		}
		for (const reason of degradationReasons) {
			coverageDegradations.push({
				trigger_id: row.trigger_id,
				source_batch_id: row.source_batch_id!,
				source_lane_id: row.source_lane_id!,
				reason,
			});
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
	// Explicit unbound guard, ahead of the resolution below. The bounded-fallback
	// branch derives its entire integrity from comparing against a durably bound
	// scope, so "no bound scope" must fail by construction here rather than
	// falling through to a later check that happens to reject it.
	if (!gateState.prReviewBaseRef || !gateState.prReviewBaseSha) {
		return failure(
			'Active PR_REVIEW trigger evaluation requires a durably bound review base; the active PR_REVIEW gate has no bound base_ref/base_sha, so the received scope cannot be verified against anything. Re-bind the review scope by dispatching the review lanes for this PR, or restart with abort_pr_workflow (kind "recovery").',
		);
	}
	const resolvedMergeBase = await resolveReviewMergeBase(
		directory,
		parsed.data.base_ref,
		parsed.data.pr_head_sha,
	);
	let baseVerification: 'live' | 'bound_fallback' = 'live';
	if (resolvedMergeBase) {
		if (
			resolvedMergeBase.toLowerCase() !== parsed.data.base_sha.toLowerCase()
		) {
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
		// Live re-derivation is a REDUNDANT re-verification of a fact already proven
		// at dispatch: the bound base is derived only at `dispatch-lanes.ts:1065-1092`
		// via `resolveExactMergeBaseAsync`, whose verified result reaches the sole
		// `bindPrReviewBase` call site (`dispatch-lanes.ts:1189-1192`), and
		// `bindPrReviewBase` itself (`pr-workflow-gate.ts:1597-1637`) only trims and
		// lowercases what it is handed — it never re-derives. So an exact match
		// against the bound scope means this base_ref/base_sha pair already passed a
		// real `git merge-base`. Because `resolveExactMergeBase{,Async}` collapses
		// git timeout, spawn failure, unresolvable ref, and unsafe-revision-token
		// rejection into one bare `null`, UNAVAILABILITY of that re-check must not be
		// read as REFUTATION: doing so made completion permanently unsatisfiable
		// (issue #2242 / RC-B) because every retry re-failed identically.
		// Two caveats, recorded deliberately:
		//   1. The property assumes durable-state integrity. An attacker who can
		//      write `.swarm` can forge the receipt directly, so this adds no new
		//      attack surface, but it is not a defense against that attacker either.
		//   2. The writer-suite tests bind literal SHAs rather than deriving them
		//      through dispatch, so they do NOT exercise this property.
		// Residual accepted risk: post-bind ref movement or deletion escapes
		// staleness detection on this path only, and only with disclosure. The
		// reviewed range stays SHA-scoped (`base_sha...pr_head_sha`), so what was
		// reviewed is unchanged either way.
	} else if (
		parsed.data.base_ref === gateState.prReviewBaseRef &&
		parsed.data.base_sha.toLowerCase() === gateState.prReviewBaseSha
	) {
		baseVerification = 'bound_fallback';
		criticalWarn(
			`PR_REVIEW trigger evaluation could not re-derive the merge base for base_ref "${parsed.data.base_ref}" at pr_head_sha "${parsed.data.pr_head_sha}"; proceeding on the durably bound, bind-time-verified review scope (${gateState.prReviewBaseRef} at ${gateState.prReviewBaseSha}). The receipt discloses base_verification: bound_fallback and the final review report must disclose it too.`,
		);
	} else {
		return failure(
			`Active PR_REVIEW trigger evaluation could not resolve the exact merge base from base_ref "${parsed.data.base_ref}" and pr_head_sha "${parsed.data.pr_head_sha}", and the received scope does not equal the durably bound review scope (${gateState.prReviewBaseRef} at ${gateState.prReviewBaseSha}), so the bound-scope fallback does not apply. A null resolution collapses several causes: the bounded git call timed out, the git process failed to spawn, base_ref is not resolvable in this checkout, or base_ref/pr_head_sha was rejected as an unsafe revision token. Recovery: verify both revisions exist here (git rev-parse), retry once the environment settles, or restart with abort_pr_workflow (kind "recovery").`,
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
	// Reservation is the first durable mutation. Keep every earlier validation
	// failure retryable without consuming a run directory or state binding.
	let resolvedRunId: string;
	try {
		resolvedRunId = await resolvePrReviewWriterRunId(
			directory,
			sessionID,
			parsed.data.run_id,
		);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	let artifact = buildPrReviewTriggerReceiptV2({
		run_id: resolvedRunId,
		pr_head_sha: parsed.data.pr_head_sha,
		base_ref: parsed.data.base_ref,
		base_sha: parsed.data.base_sha,
		evaluated_at: new Date().toISOString(),
		dispatched_micro_lane_count: dispatchedMicroLaneCount,
		rows: validatedRows,
		coverage_degradations: coverageDegradations,
		base_verification: baseVerification,
	});

	const relativePath = path.join(
		'pr-review',
		resolvedRunId,
		'trigger-eval.json',
	);
	let destination: string;
	try {
		destination = validateSwarmPath(directory, relativePath);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	let replayed = false;
	try {
		let existing: TriggerReceiptV2 | null = null;
		try {
			existing = await readBoundedTriggerReceipt(destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		if (existing) {
			if (
				comparableTriggerReceipt(existing) !==
				comparableTriggerReceipt(artifact)
			) {
				return failure(
					`PR_REVIEW trigger evaluation receipt already exists for run "${resolvedRunId}" with conflicting content`,
				);
			}
			artifact = existing;
			replayed = true;
		} else {
			const created = await createTriggerReceipt(
				destination,
				`${JSON.stringify(artifact, null, 2)}\n`,
			);
			if (!created) {
				const raced = await readBoundedTriggerReceipt(destination);
				if (
					comparableTriggerReceipt(raced) !== comparableTriggerReceipt(artifact)
				) {
					return failure(
						`PR_REVIEW trigger evaluation receipt concurrently appeared for run "${resolvedRunId}" with conflicting content`,
					);
				}
				artifact = raced;
				replayed = true;
			}
		}
	} catch (error) {
		return failure(
			`Failed to read or persist trigger evaluation at "${relativePath.split(path.sep).join('/')}": ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	try {
		await _internals.markPrReviewTriggerEvaluationComplete(
			directory,
			sessionID,
			resolvedRunId,
			relativePath.split(path.sep).join('/'),
		);
	} catch (error) {
		return failure(
			`Failed to persist trigger evaluation gate receipt for "${relativePath.split(path.sep).join('/')}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return JSON.stringify(
		{
			success: true,
			replayed,
			run_id: resolvedRunId,
			path: relativePath.split(path.sep).join('/'),
			trigger_count: artifact.trigger_count,
			matched_count: artifact.matched_count,
			not_triggered_count: artifact.not_triggered_count,
			no_match_count: artifact.no_match_count,
			dispatched_micro_lane_count: dispatchedMicroLaneCount,
			base_verification: baseVerification,
			...(baseVerification === 'bound_fallback'
				? {
						base_verification_note:
							'live merge-base re-derivation was unavailable; the bound review scope was used and MUST be disclosed in the final review report',
					}
				: {}),
			coverage_degradation_count: coverageDegradations.length,
			...(coverageDegradations.length > 0
				? {
						coverage_degradations: coverageDegradations,
						note: 'degraded families recorded on the receipt; disclose them in the final review report',
					}
				: {}),
		},
		null,
		2,
	);
}

export const write_pr_review_trigger_eval: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		allowWorkingDirectoryOverride: true,
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
