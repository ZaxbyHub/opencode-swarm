import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readLaneOutput } from '../background/lane-output-store.js';
import { findByBatchId } from '../background/pending-delegations.js';
import {
	resolveExactMergeBase,
	resolvePrWorkflowRevisionDigest,
} from '../background/workspace-snapshot.js';
import {
	assertPrReviewBaseCoverageSettled,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	prReviewDiscoveryArtifactCoversLane,
	readPrWorkflowGateState,
} from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils';
import { createSwarmTool } from './create-tool';

export const _internals = {
	resolvePrWorkflowRevisionDigest,
	resolveMergeBase: resolveExactMergeBase,
};

/** Canonical trigger IDs and display values shared with the PR-review protocol. */
export const PR_REVIEW_TRIGGER_DEFINITIONS = [
	{
		id: 'auth-identity-secrets',
		scope: 'universal',
		trigger_row:
			'authentication, authorization, identity, sessions, permissions, secrets, cryptography',
		micro_lane: 'Identity and secret boundaries',
	},
	{
		id: 'untrusted-input-boundaries',
		scope: 'universal',
		trigger_row:
			'parsing, serialization, queries, templates/rendering, file or network input/output',
		micro_lane: 'Untrusted input and sink analysis',
	},
	{
		id: 'subprocess-platform',
		scope: 'universal',
		trigger_row:
			'subprocesses, shell commands, filesystem operations, OS/runtime-specific code',
		micro_lane: 'Subprocess and platform safety',
	},
	{
		id: 'concurrency-state',
		scope: 'universal',
		trigger_row:
			'queues, caches, retries, transactions, locks, state machines, async coordination',
		micro_lane: 'Concurrency and state transitions',
	},
	{
		id: 'dependencies-build-release',
		scope: 'universal',
		trigger_row:
			'dependency manifests, lockfiles, installers, build scripts, CI, packaging, deployment',
		micro_lane: 'Dependency and delivery integrity',
	},
	{
		id: 'api-schema-migrations',
		scope: 'universal',
		trigger_row:
			'public API, wire/schema/config/storage formats, migrations, feature flags',
		micro_lane: 'Compatibility and migration safety',
	},
	{
		id: 'test-infrastructure',
		scope: 'universal',
		trigger_row: 'tests, mocks, fixtures, harnesses, coverage, CI matrices',
		micro_lane: 'Test validity and isolation',
	},
	{
		id: 'ui-accessibility-i18n',
		scope: 'universal',
		trigger_row:
			'user interfaces, interaction flows, rendering, accessibility, localization',
		micro_lane: 'UI and human-interface quality',
	},
	{
		id: 'privacy-observability',
		scope: 'universal',
		trigger_row: 'telemetry, logs, analytics, traces, retention, diagnostics',
		micro_lane: 'Privacy and observability safety',
	},
	{
		id: 'generated-provenance',
		scope: 'universal',
		trigger_row:
			'generated, vendored, binary, model-produced, codegen or checked-in build artifacts',
		micro_lane: 'Generated artifact provenance',
	},
	{
		id: 'unclassified-risk',
		scope: 'universal',
		trigger_row:
			'any changed artifact or behavior not confidently classified by the rows above',
		micro_lane: 'Unclassified high-risk fallback',
	},
] as const;

const TriggerEvalRowSchema = z
	.object({
		trigger_id: z.string().min(1),
		result: z.literal('MATCHED'),
		evidence: z.string().trim().min(1).max(4000),
		source_batch_id: z.string().trim().min(1).optional(),
		source_lane_id: z.string().trim().min(1).optional(),
	})
	.strict();

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
		rows: z.array(TriggerEvalRowSchema).min(1),
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
	const parsed = WritePrReviewTriggerEvalArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			`Invalid trigger evaluation: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}

	const expectedIds = new Set<string>(PR_REVIEW_REQUIRED_MICRO_LANE_IDS);
	const seenIds = new Set<string>();
	const duplicateIds = new Set<string>();
	for (const row of parsed.data.rows) {
		if (seenIds.has(row.trigger_id)) duplicateIds.add(row.trigger_id);
		seenIds.add(row.trigger_id);
	}
	if (duplicateIds.size > 0) {
		return failure(`duplicate trigger IDs: ${[...duplicateIds].join(', ')}`);
	}

	const unknownIds = [...seenIds].filter((id) => !expectedIds.has(id));
	if (unknownIds.length > 0) {
		// Issue #1931: the validator accepts ONLY the 11 micro-lane IDs in
		// PR_REVIEW_REQUIRED_MICRO_LANE_IDS. Callers commonly confuse three
		// namespaces — dispatch `mode` strings (swarm-pr-review:base,
		// swarm-pr-review:micro), base-lane IDs (intent-architecture,
		// correctness-state, tests-falsifiability, security-trust,
		// reliability-performance, compatibility-delivery), and informal
		// short names (correctness, security, deps, docs, tests, perf).
		// Surface the valid set so the next call succeeds without a
		// skill-prose treasure hunt.
		return failure(
			`unknown trigger IDs: ${unknownIds.join(', ')}. ` +
				`trigger_id must be one of the 11 mandatory micro-lane IDs: ` +
				`${[...expectedIds].join(', ')}. ` +
				`Base-lane IDs and mode strings (e.g. swarm-pr-review:base) are NOT trigger IDs.`,
		);
	}
	const missingIds = [...expectedIds].filter((id) => !seenIds.has(id));
	if (missingIds.length > 0) {
		return failure(`missing trigger IDs: ${missingIds.join(', ')}`);
	}

	for (const row of parsed.data.rows) {
		if (row.result === 'MATCHED') {
			if (!row.source_batch_id || !row.source_lane_id) {
				return failure(
					`MATCHED rows require source_batch_id and source_lane_id: ${row.trigger_id}`,
				);
			}
		}
	}
	// One dispatch tuple may back several rows only when the dispatched lane
	// declared consolidated ownership of exactly those families; the per-row
	// record validation below enforces ownership containment and all-owned
	// artifact attestation, so a lane can never lend provenance to a family it
	// did not declare and fully attest.

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
	try {
		await assertPrReviewBaseCoverageSettled(directory, sessionID);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	const currentRevisionDigest = _internals.resolvePrWorkflowRevisionDigest(
		directory,
		parsed.data.pr_head_sha,
	);
	if (!currentRevisionDigest) {
		return failure(
			'Active PR_REVIEW trigger evaluation could not bind the current exact revision digest',
		);
	}
	for (const row of parsed.data.rows) {
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

	const rowsById = new Map(
		parsed.data.rows.map((row) => [row.trigger_id, row] as const),
	);
	const artifactRows = PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => {
		const row = rowsById.get(definition.id);
		if (!row)
			throw new Error(`Missing validated trigger row: ${definition.id}`);
		return {
			trigger_id: definition.id,
			scope: definition.scope,
			trigger_row: definition.trigger_row,
			micro_lane: definition.micro_lane,
			result: row.result,
			evidence: row.evidence,
			source_batch_id: row.source_batch_id,
			source_lane_id: row.source_lane_id,
		};
	});
	const matchedCount = artifactRows.length;
	const dispatchedMicroLaneCount = new Set(
		parsed.data.rows.map(
			(row) => `${row.source_batch_id}\0${row.source_lane_id}`,
		),
	).size;
	const artifact = {
		schema_version: 1,
		run_id: parsed.data.run_id,
		pr_head_sha: parsed.data.pr_head_sha,
		base_ref: parsed.data.base_ref,
		base_sha: parsed.data.base_sha,
		evaluated_at: new Date().toISOString(),
		trigger_count: artifactRows.length,
		matched_count: matchedCount,
		no_match_count: 0,
		dispatched_micro_lane_count: dispatchedMicroLaneCount,
		rows: artifactRows,
	};

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
		relativePath.split(path.sep).join('/'),
	);

	return JSON.stringify(
		{
			success: true,
			path: relativePath.split(path.sep).join('/'),
			trigger_count: artifactRows.length,
			matched_count: matchedCount,
			no_match_count: 0,
			dispatched_micro_lane_count: dispatchedMicroLaneCount,
		},
		null,
		2,
	);
}

export const write_pr_review_trigger_eval: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Persist the complete, exact-set PR-review micro-lane ledger after every repository-agnostic lane has completed.',
		args: {
			run_id: WritePrReviewTriggerEvalArgsSchema.shape.run_id,
			pr_head_sha: WritePrReviewTriggerEvalArgsSchema.shape.pr_head_sha,
			base_sha: WritePrReviewTriggerEvalArgsSchema.shape.base_sha,
			base_ref: WritePrReviewTriggerEvalArgsSchema.shape.base_ref,
			rows: WritePrReviewTriggerEvalArgsSchema.shape.rows,
		},
		execute: executeWritePrReviewTriggerEval,
	});
