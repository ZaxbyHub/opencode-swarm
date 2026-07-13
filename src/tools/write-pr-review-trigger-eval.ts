import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';
import { createSwarmTool } from './create-tool';

/** Canonical trigger IDs and display values shared with the PR-review protocol. */
export const PR_REVIEW_TRIGGER_DEFINITIONS = [
	{
		id: 'architect-prompts',
		trigger_row: 'agents, prompts, templates, prompt interpolation, role text',
		micro_lane: 'Architect prompt integrity',
	},
	{
		id: 'council-orchestration',
		trigger_row: 'council, verdict, quorum, veto, synthesis',
		micro_lane: 'Council orchestration',
	},
	{
		id: 'guardrail-bypass',
		trigger_row: 'guardrail, gate, delegation, rate limit, approval checks',
		micro_lane: 'Guardrail bypass paths',
	},
	{
		id: 'evidence-schema',
		trigger_row: 'schema, evidence, JSONL, migrations, serializers',
		micro_lane: 'Evidence schema drift',
	},
	{
		id: 'knowledge-contract',
		trigger_row: 'knowledge, curator, hive, quarantine, memory',
		micro_lane: 'Knowledge base contract',
	},
	{
		id: 'phase-transitions',
		trigger_row: 'phase, state, plan, .swarm/state, completion markers',
		micro_lane: 'Phase transition validation',
	},
	{
		id: 'model-role-mapping',
		trigger_row: 'model, role, prefix, tool, agent config',
		micro_lane: 'Model-to-role mapping',
	},
	{
		id: 'config-ratchet',
		trigger_row: 'config, defaults, ratchet, locks, policy flags',
		micro_lane: 'Config ratchet semantics',
	},
	{
		id: 'url-fetch',
		trigger_row: 'url, fetch, http, GitHub PR/issue parsing, package fetch',
		micro_lane: 'URL sanitization and external fetch',
	},
	{
		id: 'git-safety',
		trigger_row: 'git, branch, checkout, reset, worktree, .git',
		micro_lane: 'Git safety',
	},
	{
		id: 'shell-write',
		trigger_row: 'shell, exec, command parser, file writes, delete/move/copy',
		micro_lane: 'Shell/write authority and path containment',
	},
	{
		id: 'test-infrastructure',
		trigger_row: 'test, bun, mocks, fixtures, CI matrix',
		micro_lane: 'Test infrastructure',
	},
	{
		id: 'metrics-privacy',
		trigger_row: 'metrics, telemetry, logs, serialized traces',
		micro_lane: 'Metrics and evidence privacy',
	},
] as const;

const TriggerEvalRowSchema = z
	.object({
		trigger_id: z.string().min(1),
		result: z.enum(['MATCHED', 'NO-MATCH']),
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
): Promise<string> {
	const parsed = WritePrReviewTriggerEvalArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			`Invalid trigger evaluation: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}

	const expectedIds = new Set<string>(
		PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => definition.id),
	);
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
		return failure(`unknown trigger IDs: ${unknownIds.join(', ')}`);
	}
	const missingIds = [...expectedIds].filter((id) => !seenIds.has(id));
	if (missingIds.length > 0) {
		return failure(`missing trigger IDs: ${missingIds.join(', ')}`);
	}

	const provenance = new Set<string>();
	for (const row of parsed.data.rows) {
		if (row.result === 'MATCHED') {
			if (!row.source_batch_id || !row.source_lane_id) {
				return failure(
					`MATCHED rows require source_batch_id and source_lane_id: ${row.trigger_id}`,
				);
			}
			const tuple = `${row.source_batch_id}\0${row.source_lane_id}`;
			if (provenance.has(tuple)) {
				return failure(
					`MATCHED rows require unique dispatch provenance: ${row.trigger_id}`,
				);
			}
			provenance.add(tuple);
		} else if (row.source_batch_id || row.source_lane_id) {
			return failure(
				`NO-MATCH rows must not include dispatch provenance: ${row.trigger_id}`,
			);
		}
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
			trigger_row: definition.trigger_row,
			micro_lane: definition.micro_lane,
			result: row.result,
			evidence: row.evidence,
			...(row.result === 'MATCHED'
				? {
						source_batch_id: row.source_batch_id,
						source_lane_id: row.source_lane_id,
					}
				: {}),
		};
	});
	const matchedCount = artifactRows.filter(
		(row) => row.result === 'MATCHED',
	).length;
	const artifact = {
		schema_version: 1,
		run_id: parsed.data.run_id,
		evaluated_at: new Date().toISOString(),
		trigger_count: artifactRows.length,
		matched_count: matchedCount,
		no_match_count: artifactRows.length - matchedCount,
		dispatched_micro_lane_count: matchedCount,
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

	return JSON.stringify(
		{
			success: true,
			path: relativePath.split(path.sep).join('/'),
			trigger_count: artifactRows.length,
			matched_count: matchedCount,
			no_match_count: artifactRows.length - matchedCount,
			dispatched_micro_lane_count: matchedCount,
		},
		null,
		2,
	);
}

export const write_pr_review_trigger_eval: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Persist a complete, exact-set PR-review trigger ledger under .swarm/pr-review/<run_id>/trigger-eval.json.',
		args: {
			run_id: WritePrReviewTriggerEvalArgsSchema.shape.run_id,
			rows: WritePrReviewTriggerEvalArgsSchema.shape.rows,
		},
		execute: executeWritePrReviewTriggerEval,
	});
