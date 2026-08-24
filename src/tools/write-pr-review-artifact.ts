import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
	FINDINGS_SEVERITIES,
	type FindingsSeverity,
} from '../background/candidate-contract.js';
import {
	assertPrReviewArtifactBoundary,
	assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts,
	markPrReviewArtifactBoundary,
	markPrReviewHandoffComplete,
	readPrWorkflowGateState,
} from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { createSwarmTool } from './create-tool.js';

const RunIdSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
		'run_id must be a safe relative identifier',
	);

const FindingSchema = z
	.object({
		finding_id: z.string().trim().min(1).max(128),
		status: z.enum(['PENDING', 'CONFIRMED', 'DISPROVED', 'PRE_EXISTING']),
		file_line: z.string().trim().min(1).max(1000),
		evidence: z.string().trim().min(1).max(20_000),
		next_action: z.enum([
			'route_to_reviewer',
			'route_to_critic',
			'report',
			'suppress_with_reason',
			'handoff_to_feedback',
		]),
		/**
		 * Speaks the VERDICT dialect (includes `NONE`), because a findings record
		 * is a projection of an authenticated reviewer/critic row.
		 *
		 * Kept `.optional()` at the SCHEMA layer on purpose: presence is required,
		 * but it is `assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts` that
		 * enforces it, so an omitted field is reported as
		 * `severity expected "MEDIUM", got (omitted)` — naming the required value —
		 * alongside every other violation in one batched rejection (the #2277
		 * one-round-trip repair contract). A schema-level required enum would
		 * instead abort with a generic domain message and discard that batch.
		 */
		severity: z.enum(FINDINGS_SEVERITIES).optional(),
		category: z.string().trim().min(1).max(128).optional(),
	})
	.strict();

const HandoffSchema = z
	.object({
		pr_url: z.string().url(),
		finding_ids: z.array(z.string().trim().min(1).max(128)).min(1),
		summary: z.string().trim().min(1).max(20_000),
		provenance: z.array(z.string().trim().min(1).max(4000)).min(1),
	})
	.strict();

const WritePrReviewArtifactArgsSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('findings'),
			run_id: RunIdSchema,
			pr_head_sha: z
				.string()
				.trim()
				.regex(/^[0-9a-f]{6,64}$/i),
			boundary: z.enum(['post_explorer', 'post_reviewer', 'post_critic']),
			records: z.array(FindingSchema).min(1).max(1000),
		})
		.strict(),
	z
		.object({
			kind: z.literal('handoff'),
			run_id: RunIdSchema,
			pr_head_sha: z
				.string()
				.trim()
				.regex(/^[0-9a-f]{6,64}$/i),
			handoff: HandoffSchema,
		})
		.strict(),
]);

/**
 * READ shape. Deliberately tolerant of a missing `severity`: `readFindings`
 * JSON-parses persisted lines without re-validating them, so rows written before
 * severity became mandatory must still load (issue #2279 durable readability).
 * The WRITE boundary is what enforces presence.
 */
type PersistedFinding = Omit<z.infer<typeof FindingSchema>, 'severity'> & {
	severity?: FindingsSeverity;
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic';
	pr_head_sha: string;
	recorded_at: string;
};

function failure(message: string): string {
	return JSON.stringify({ success: false, message }, null, 2);
}

async function readFindings(filePath: string): Promise<PersistedFinding[]> {
	try {
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile() || stat.size > 10 * 1024 * 1024) {
			throw new Error('findings artifact is not a bounded regular file');
		}
		const text = await fs.promises.readFile(filePath, 'utf8');
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as PersistedFinding);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${randomUUID()}.tmp`,
	);
	try {
		await fs.promises.writeFile(tempPath, content, {
			encoding: 'utf8',
			flag: 'wx',
		});
		await fs.promises.rename(tempPath, filePath);
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

function latestFindings(
	records: readonly PersistedFinding[],
): Map<string, PersistedFinding> {
	const latest = new Map<string, PersistedFinding>();
	for (const record of records) latest.set(record.finding_id, record);
	return latest;
}

export async function executeWritePrReviewArtifact(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = WritePrReviewArtifactArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			`Invalid PR-review artifact: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	const sessionID = context.sessionID?.trim();
	if (!sessionID)
		return failure('PR-review artifact requires an active session');
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (state?.mode !== 'PR_REVIEW' || !state.prHeadSha) {
		return failure(
			'PR-review artifact requires an active, bound PR_REVIEW gate',
		);
	}
	if (state.prHeadSha !== parsed.data.pr_head_sha.toLowerCase()) {
		return failure(
			`PR-review artifact head mismatch: expected ${state.prHeadSha}, received ${parsed.data.pr_head_sha}`,
		);
	}
	if (
		state.prReviewArtifactRunId &&
		state.prReviewArtifactRunId !== parsed.data.run_id
	) {
		return failure(
			`PR-review artifacts are already bound to run ${state.prReviewArtifactRunId}`,
		);
	}

	const relativeFindingsPath = path.join(
		'pr-review',
		parsed.data.run_id,
		'findings.jsonl',
	);
	const findingsPath = validateSwarmPath(directory, relativeFindingsPath);
	const existing = await readFindings(findingsPath);

	if (parsed.data.kind === 'findings') {
		const findingsInput = parsed.data;
		const findingIds = findingsInput.records.map((record) => record.finding_id);
		await assertPrReviewArtifactBoundary(
			directory,
			sessionID,
			findingsInput.run_id,
			findingsInput.boundary,
			findingIds,
		);
		await assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
			directory,
			sessionID,
			findingsInput.boundary,
			findingsInput.records,
		);
		const recordedAt = new Date().toISOString();
		const appended: PersistedFinding[] = findingsInput.records.map(
			(record) => ({
				...record,
				boundary: findingsInput.boundary,
				pr_head_sha: state.prHeadSha!,
				recorded_at: recordedAt,
			}),
		);
		const allRecords = [...existing, ...appended];
		await atomicWrite(
			findingsPath,
			allRecords.map((record) => JSON.stringify(record)).join('\n') +
				(allRecords.length > 0 ? '\n' : ''),
		);
		const latest = latestFindings(allRecords);
		const handoffRequired = [...latest.values()].some(
			(record) =>
				record.status === 'CONFIRMED' &&
				record.next_action === 'handoff_to_feedback',
		);
		await markPrReviewArtifactBoundary(
			directory,
			sessionID,
			findingsInput.run_id,
			findingsInput.boundary,
			relativeFindingsPath.split(path.sep).join('/'),
			findingIds,
			handoffRequired,
		);
		return JSON.stringify(
			{
				success: true,
				path: relativeFindingsPath.split(path.sep).join('/'),
				boundary: findingsInput.boundary,
				appended: appended.length,
				handoff_required: handoffRequired,
			},
			null,
			2,
		);
	}

	const latest = latestFindings(existing);
	const actionableIds = [...latest.values()]
		.filter(
			(record) =>
				record.status === 'CONFIRMED' &&
				record.next_action === 'handoff_to_feedback',
		)
		.map((record) => record.finding_id)
		.sort();
	const requestedIds = [...new Set(parsed.data.handoff.finding_ids)].sort();
	if (
		actionableIds.length === 0 ||
		JSON.stringify(actionableIds) !== JSON.stringify(requestedIds)
	) {
		return failure(
			`handoff finding_ids must exactly match actionable findings: ${actionableIds.join(', ') || '(none)'}`,
		);
	}
	const relativeHandoffPath = path.join(
		'pr-review',
		parsed.data.run_id,
		'feedback-handoff.json',
	);
	const handoffPath = validateSwarmPath(directory, relativeHandoffPath);
	await atomicWrite(
		handoffPath,
		`${JSON.stringify(
			{
				schema_version: 1,
				run_id: parsed.data.run_id,
				pr_head_sha: state.prHeadSha,
				created_at: new Date().toISOString(),
				...parsed.data.handoff,
			},
			null,
			2,
		)}\n`,
	);
	await markPrReviewHandoffComplete(
		directory,
		sessionID,
		parsed.data.run_id,
		relativeHandoffPath.split(path.sep).join('/'),
	);
	return JSON.stringify(
		{
			success: true,
			path: relativeHandoffPath.split(path.sep).join('/'),
			finding_count: actionableIds.length,
		},
		null,
		2,
	);
}

export const write_pr_review_artifact: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		allowWorkingDirectoryOverride: true,
		description:
			'Persist schema-validated PR-review findings checkpoints and exact actionable feedback handoffs under the active run.',
		args: {
			kind: z.enum(['findings', 'handoff']),
			run_id: RunIdSchema,
			pr_head_sha: z
				.string()
				.trim()
				.regex(/^[0-9a-f]{6,64}$/i),
			boundary: z
				.enum(['post_explorer', 'post_reviewer', 'post_critic'])
				.optional(),
			records: z.array(FindingSchema).min(1).max(1000).optional(),
			handoff: HandoffSchema.optional(),
		},
		execute: executeWritePrReviewArtifact,
	});
