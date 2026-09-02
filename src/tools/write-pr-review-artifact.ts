import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { FindingsSeverity } from '../background/candidate-contract.js';
import {
	formatPrReviewRuntimeFieldError,
	formatPrReviewValidationIssues,
	PR_REVIEW_FINDINGS_MAX_BYTES,
	PR_REVIEW_HANDOFF_MAX_BYTES,
	PrReviewFindingSchema,
	PrReviewHandoffSchema,
	PrReviewPartialBaseCoverageSchema,
	PrReviewRunIdSchema,
	WritePrReviewArtifactArgsSchema,
} from '../background/pr-review-contract.js';
import {
	admitPrReviewPartialBaseCoverage,
	assertPrReviewArtifactBoundary,
	assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts,
	markPrReviewArtifactBoundary,
	markPrReviewHandoffComplete,
	normalizePrReviewPartialBaseCoverageRecord,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
	resolvePrReviewWriterRunId,
	rollbackPrReviewPartialBaseCoverageAdmission,
} from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { createSwarmTool } from './create-tool.js';

/**
 * READ shape. Deliberately tolerant of a missing `severity`: `readFindings`
 * JSON-parses persisted lines without re-validating them, so rows written before
 * severity became mandatory must still load (issue #2279 durable readability).
 * The WRITE boundary is what enforces presence.
 */
type PersistedFinding = Omit<
	z.infer<typeof PrReviewFindingSchema>,
	'severity'
> & {
	severity?: FindingsSeverity;
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic';
	pr_head_sha: string;
	recorded_at: string;
};

const PersistedFindingSchema = PrReviewFindingSchema.extend({
	boundary: z.enum(['post_explorer', 'post_reviewer', 'post_critic']),
	pr_head_sha: z.string().regex(/^[0-9a-f]{6,64}$/i),
	recorded_at: z.string().datetime(),
}).strict();

const PersistedHandoffSchema = PrReviewHandoffSchema.extend({
	schema_version: z.literal(1),
	run_id: PrReviewRunIdSchema,
	pr_head_sha: z.string().regex(/^[0-9a-f]{6,64}$/i),
	created_at: z.string().datetime(),
}).strict();

type PersistedHandoff = z.infer<typeof PersistedHandoffSchema>;

function failure(message: string): string {
	return JSON.stringify({ success: false, message }, null, 2);
}

async function readFindings(filePath: string): Promise<PersistedFinding[]> {
	try {
		const text = await readBoundedUtf8File(
			filePath,
			PR_REVIEW_FINDINGS_MAX_BYTES,
			'findings artifact',
		);
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line, index) => {
				let decoded: unknown;
				try {
					decoded = JSON.parse(line);
				} catch (error) {
					throw new Error(
						`line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				// Issue #2383 single read/migration boundary: a legacy row that
				// predates typed risk metadata is normalized here to UNKNOWN /
				// no tags — the honest, fail-safe classification that routes it
				// to critic review. New writes carry the fields and are
				// validated by the write boundary; malformed values on new rows
				// are rejected below rather than backfilled from any heuristic.
				if (decoded !== null && typeof decoded === 'object') {
					const record = decoded as Record<string, unknown>;
					if (record.risk_impact === undefined) {
						record.risk_impact = 'UNKNOWN';
					}
					if (record.risk_tags === undefined) {
						record.risk_tags = [];
					}
				}
				const parsed = PersistedFindingSchema.safeParse(decoded);
				if (!parsed.success) {
					throw new Error(
						`line ${index + 1} violates the persisted finding schema: ${formatPrReviewValidationIssues(parsed.error.issues, decoded).join('; ')}`,
					);
				}
				return parsed.data;
			});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

async function readBoundedUtf8File(
	filePath: string,
	maxBytes: number,
	label: string,
): Promise<string> {
	const stat = await fs.promises.stat(filePath);
	if (!stat.isFile() || stat.size > maxBytes) {
		throw new Error(
			`${label} is not a bounded regular file (max ${maxBytes} bytes)`,
		);
	}
	const text = await fs.promises.readFile(filePath, 'utf8');
	const bytes = Buffer.byteLength(text, 'utf8');
	if (bytes > maxBytes) {
		throw new Error(
			`${label} exceeds ${maxBytes} bytes after read (got ${bytes})`,
		);
	}
	return text;
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

async function atomicCreate(
	filePath: string,
	content: string,
): Promise<boolean> {
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
		try {
			await fs.promises.link(tempPath, filePath);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
			throw error;
		}
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

export const _internals = {
	atomicWrite,
	atomicCreate,
	assertBoundary: assertPrReviewArtifactBoundary,
	/** Exposed so the #2383 read/migration boundary is testable directly. */
	readFindings,
};

function operationFailure(
	operation: string,
	relativePath: string,
	expected: string,
	error: unknown,
): string {
	return failure(
		`operation ${operation} path "${relativePath}": expected ${expected}, got ${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
	);
}

function latestFindings(
	records: readonly PersistedFinding[],
): Map<string, PersistedFinding> {
	const latest = new Map<string, PersistedFinding>();
	for (const record of records) latest.set(record.finding_id, record);
	return latest;
}

function canonicalFindingRecords(
	records: readonly (
		| PersistedFinding
		| z.infer<typeof PrReviewFindingSchema>
	)[],
): string {
	return JSON.stringify(
		records
			.map((record) => ({
				finding_id: record.finding_id,
				status: record.status,
				file_line: record.file_line,
				evidence: record.evidence,
				next_action: record.next_action,
				severity: record.severity,
				category: record.category,
				// Typed risk metadata participates in the replay-identity key
				// (issue #2383): a record whose routing-relevant metadata
				// differs is never an exact replay.
				risk_impact: record.risk_impact,
				risk_tags: record.risk_tags,
			}))
			.sort((left, right) => left.finding_id.localeCompare(right.finding_id)),
	);
}

export async function executeWritePrReviewArtifact(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = WritePrReviewArtifactArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			`Invalid PR-review artifact: ${formatPrReviewValidationIssues(
				parsed.error.issues,
				args,
			).join('; ')}`,
		);
	}
	const sessionID = context.sessionID?.trim();
	if (!sessionID)
		return failure(
			formatPrReviewRuntimeFieldError(
				'session_id',
				'a non-empty active session identifier',
				context.sessionID,
			),
		);
	let state: Awaited<ReturnType<typeof readPrWorkflowGateState>>;
	try {
		state = await readPrWorkflowGateState(directory, sessionID);
	} catch (error) {
		return operationFailure(
			'read',
			`pr-workflow-gates/${prWorkflowSessionFileStem(sessionID)}.json`,
			'a bounded valid PR workflow state artifact',
			error,
		);
	}
	if (state?.mode !== 'PR_REVIEW' || !state.prHeadSha) {
		return failure(
			formatPrReviewRuntimeFieldError(
				'workflow.mode',
				'an active head-bound "PR_REVIEW" workflow',
				state ? { mode: state.mode, pr_head_sha: state.prHeadSha } : null,
			),
		);
	}
	if (state.prHeadSha !== parsed.data.pr_head_sha.toLowerCase()) {
		return failure(
			formatPrReviewRuntimeFieldError(
				'pr_head_sha',
				`"${state.prHeadSha}"`,
				parsed.data.pr_head_sha,
			),
		);
	}
	let resolvedRunId: string;
	try {
		resolvedRunId = await resolvePrReviewWriterRunId(
			directory,
			sessionID,
			parsed.data.run_id,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return message.startsWith('BLOCKED: field ')
			? failure(message)
			: operationFailure(
					'reserve',
					`pr-review/${parsed.data.run_id ?? '<generated-run-id>'}/run-reservation.json`,
					'a create-only reservation owned by the active workflow',
					error,
				);
	}

	const relativeFindingsPath = path.join(
		'pr-review',
		resolvedRunId,
		'findings.jsonl',
	);
	let findingsPath: string;
	try {
		findingsPath = validateSwarmPath(directory, relativeFindingsPath);
	} catch (error) {
		return operationFailure(
			'resolve',
			relativeFindingsPath.split(path.sep).join('/'),
			'a contained path below the project .swarm directory',
			error,
		);
	}
	let existing: PersistedFinding[];
	try {
		existing = await readFindings(findingsPath);
	} catch (error) {
		return failure(
			`operation read path "${relativeFindingsPath.split(path.sep).join('/')}": expected bounded JSONL matching the persisted findings schema, got ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (parsed.data.kind === 'findings') {
		const findingsInput = parsed.data;
		const findingIds = findingsInput.records.map((record) => record.finding_id);
		const existingBoundaryRecords = existing.filter(
			(record) => record.boundary === findingsInput.boundary,
		);
		const hasExistingBoundaryRecords = existingBoundaryRecords.length > 0;
		const isExactReplay =
			hasExistingBoundaryRecords &&
			canonicalFindingRecords(existingBoundaryRecords) ===
				canonicalFindingRecords(findingsInput.records);
		const boundaryCommitted =
			state.prReviewArtifactRunId === resolvedRunId &&
			(state.prReviewArtifactBoundaries ?? []).includes(findingsInput.boundary);
		const existingBoundaryIds = new Set(
			existingBoundaryRecords.map((record) => record.finding_id),
		);
		const requestedFindingIds = new Set(findingIds);
		const isPostExplorerSupersession =
			boundaryCommitted &&
			findingsInput.boundary === 'post_explorer' &&
			Boolean(state.prReviewTriggerEvalPath) &&
			existingBoundaryIds.size < requestedFindingIds.size &&
			[...existingBoundaryIds].every((id) => requestedFindingIds.has(id));
		const isCommittedReplay = isExactReplay && boundaryCommitted;
		let partialAdmissionToRollback:
			| {
					runId: string;
					boundary: 'post_explorer' | 'post_reviewer' | 'post_critic';
					relativePath: string;
					digest: string;
			  }
			| undefined;
		const rollbackPartialAdmission = async (): Promise<string | undefined> => {
			if (!partialAdmissionToRollback) return undefined;
			try {
				const rolledBack = await rollbackPrReviewPartialBaseCoverageAdmission(
					directory,
					sessionID,
					partialAdmissionToRollback,
				);
				return rolledBack
					? undefined
					: 'partial base coverage admission could not be safely rolled back because durable state changed';
			} catch (error) {
				return `partial base coverage admission rollback failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		};
		const withPartialAdmissionRollback = async (
			result: string,
		): Promise<string> => {
			const rollbackError = await rollbackPartialAdmission();
			if (!rollbackError) return result;
			try {
				const decoded = JSON.parse(result) as { message?: unknown };
				return typeof decoded.message === 'string'
					? failure(`${decoded.message}; ${rollbackError}`)
					: result;
			} catch {
				return result;
			}
		};
		// An exact replay is idempotent and may skip the boundary revalidation,
		// but a non-identical write must always re-run it.  In particular, the
		// base-only post_explorer checkpoint is intentionally superseded by the
		// full-inventory post_explorer checkpoint after trigger evaluation; the
		// same boundary name is committed in both writes, so `boundaryCommitted`
		// alone cannot distinguish a legal refresh from an unsafe rewrite.
		if (!isCommittedReplay) {
			try {
				// Preserve the actionable boundary/coverage error contract before
				// checking the record projection. A caller writing too early must be
				// told which checkpoint or inventory is missing, not that its records
				// cannot yet match verdicts that are not authoritative at this point.
				await _internals.assertBoundary(
					directory,
					sessionID,
					resolvedRunId,
					findingsInput.boundary,
					findingIds,
					findingsInput.partial_base_coverage
						? { skipBaseCoverage: true }
						: undefined,
				);
			} catch (error) {
				return withPartialAdmissionRollback(
					failure(
						formatPrReviewRuntimeFieldError(
							findingsInput.partial_base_coverage
								? 'partial_base_coverage'
								: 'boundary',
							findingsInput.partial_base_coverage
								? 'a terminal N-of-6 settlement: every declared unresolved dimension terminal (typed failure, explicit cancellation, or never launched) after every other boundary predicate passes'
								: `the legal next "${findingsInput.boundary}" checkpoint for run "${resolvedRunId}" with exact inventory [${findingIds.join(', ')}]`,
							error instanceof Error ? error.message : String(error),
						),
					),
				);
			}
		}
		try {
			await assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
				directory,
				sessionID,
				findingsInput.boundary,
				findingsInput.records,
			);
		} catch (error) {
			return failure(
				formatPrReviewRuntimeFieldError(
					'records',
					`records exactly matching authoritative ${findingsInput.boundary} verdicts and disposition rules`,
					error instanceof Error ? error.message : String(error),
				),
			);
		}
		if (
			hasExistingBoundaryRecords &&
			boundaryCommitted &&
			!isExactReplay &&
			!isPostExplorerSupersession
		) {
			return failure(
				formatPrReviewRuntimeFieldError(
					'records',
					`an exact replay of the already-persisted "${findingsInput.boundary}" boundary`,
					findingsInput.records,
				),
			);
		}
		if (!isCommittedReplay) {
			try {
				if (findingsInput.partial_base_coverage) {
					const hadPartialAdmission = Boolean(
						state.prReviewPartialBaseCoverage ||
							state.prReviewCoverageDisclosurePath ||
							state.prReviewCoverageDisclosureDigest,
					);
					// Validate every boundary predicate except terminal coverage
					// before the admission mutates durable state. The normal call
					// below then proves the newly committed disclosure exactly
					// closes the derived coverage gap.
					await _internals.assertBoundary(
						directory,
						sessionID,
						resolvedRunId,
						findingsInput.boundary,
						findingIds,
						{ skipBaseCoverage: true },
					);
					state = await admitPrReviewPartialBaseCoverage(
						directory,
						sessionID,
						resolvedRunId,
						findingsInput.partial_base_coverage.unresolved_dimensions,
					);
					if (
						!hadPartialAdmission &&
						state.prReviewPartialBaseCoverage &&
						state.prReviewCoverageDisclosurePath &&
						state.prReviewCoverageDisclosureDigest
					) {
						partialAdmissionToRollback = {
							runId: state.prReviewPartialBaseCoverage.runId,
							boundary: findingsInput.boundary,
							relativePath: state.prReviewCoverageDisclosurePath,
							digest: state.prReviewCoverageDisclosureDigest,
						};
					}
				}
				if (findingsInput.partial_base_coverage) {
					await _internals.assertBoundary(
						directory,
						sessionID,
						resolvedRunId,
						findingsInput.boundary,
						findingIds,
					);
				}
			} catch (error) {
				return withPartialAdmissionRollback(
					failure(
						formatPrReviewRuntimeFieldError(
							findingsInput.partial_base_coverage
								? 'partial_base_coverage'
								: 'boundary',
							findingsInput.partial_base_coverage
								? 'a terminal N-of-6 settlement: every declared unresolved dimension terminal (typed failure, explicit cancellation, or never launched) after every other boundary predicate passes'
								: `the legal next "${findingsInput.boundary}" checkpoint for run "${resolvedRunId}" with exact inventory [${findingIds.join(', ')}]`,
							error instanceof Error ? error.message : String(error),
						),
					),
				);
			}
		}
		const recordedAt = new Date().toISOString();
		const appended: PersistedFinding[] = isExactReplay
			? []
			: findingsInput.records.map((record) => ({
					...record,
					boundary: findingsInput.boundary,
					pr_head_sha: state!.prHeadSha!,
					recorded_at: recordedAt,
				}));
		const allRecords = [...existing, ...appended];
		if (!isExactReplay) {
			const serializedFindings =
				allRecords.map((record) => JSON.stringify(record)).join('\n') +
				(allRecords.length > 0 ? '\n' : '');
			const serializedBytes = Buffer.byteLength(serializedFindings, 'utf8');
			if (serializedBytes > PR_REVIEW_FINDINGS_MAX_BYTES) {
				return withPartialAdmissionRollback(
					failure(
						formatPrReviewRuntimeFieldError(
							'records',
							`a complete findings artifact at most ${PR_REVIEW_FINDINGS_MAX_BYTES} UTF-8 bytes`,
							`${serializedBytes} bytes`,
						),
					),
				);
			}
			try {
				await _internals.atomicWrite(findingsPath, serializedFindings);
			} catch (error) {
				return withPartialAdmissionRollback(
					operationFailure(
						'write',
						relativeFindingsPath.split(path.sep).join('/'),
						'an atomic findings checkpoint write',
						error,
					),
				);
			}
		}
		const latest = latestFindings(allRecords);
		const handoffRequired = [...latest.values()].some(
			(record) =>
				record.status === 'CONFIRMED' &&
				record.next_action === 'handoff_to_feedback',
		);
		if (!isCommittedReplay) {
			try {
				await markPrReviewArtifactBoundary(
					directory,
					sessionID,
					resolvedRunId,
					findingsInput.boundary,
					relativeFindingsPath.split(path.sep).join('/'),
					findingIds,
					handoffRequired,
				);
			} catch (error) {
				return withPartialAdmissionRollback(
					operationFailure(
						'update',
						`pr-workflow-gates/${prWorkflowSessionFileStem(sessionID)}.json`,
						`a durable ${findingsInput.boundary} boundary receipt`,
						error,
					),
				);
			}
		}
		return JSON.stringify(
			{
				success: true,
				run_id: resolvedRunId,
				path: relativeFindingsPath.split(path.sep).join('/'),
				boundary: findingsInput.boundary,
				appended: appended.length,
				replayed: isExactReplay,
				handoff_required: handoffRequired,
				...(state.prReviewPartialBaseCoverage
					? {
							partial_base_coverage: {
								unresolved_dimensions:
									normalizePrReviewPartialBaseCoverageRecord(
										state.prReviewPartialBaseCoverage,
									).unresolvedDimensions.map((entry) => ({
										dimension: entry.dimension,
										terminal_state: entry.terminalState,
										reason_kind: entry.reasonKind,
										failure_class: entry.failureClass,
									})),
								path: state.prReviewCoverageDisclosurePath,
								digest: state.prReviewCoverageDisclosureDigest,
							},
						}
					: {}),
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
			`field handoff.finding_ids: expected authoritative actionable set [${actionableIds.join(', ') || '(none)'}], got requested [${requestedIds.join(', ') || '(none)'}]`,
		);
	}
	const relativeHandoffPath = path.join(
		'pr-review',
		resolvedRunId,
		'feedback-handoff.json',
	);
	let handoffPath: string;
	try {
		handoffPath = validateSwarmPath(directory, relativeHandoffPath);
	} catch (error) {
		return operationFailure(
			'resolve',
			relativeHandoffPath.split(path.sep).join('/'),
			'a contained path below the project .swarm directory',
			error,
		);
	}
	const handoffRecord = {
		schema_version: 1 as const,
		run_id: resolvedRunId,
		pr_head_sha: state.prHeadSha,
		created_at: new Date().toISOString(),
		...parsed.data.handoff,
	};
	const comparableHandoff = (record: PersistedHandoff) => ({
		schema_version: record.schema_version,
		run_id: record.run_id,
		pr_head_sha: record.pr_head_sha,
		pr_url: record.pr_url,
		finding_ids: record.finding_ids,
		summary: record.summary,
		provenance: record.provenance,
	});
	const handoffsMatch = (existing: PersistedHandoff): boolean =>
		JSON.stringify(comparableHandoff(existing)) ===
		JSON.stringify(comparableHandoff(handoffRecord));
	const readPersistedHandoff = async (): Promise<PersistedHandoff> => {
		const raw = await readBoundedUtf8File(
			handoffPath,
			PR_REVIEW_HANDOFF_MAX_BYTES,
			'handoff artifact',
		);
		let decoded: unknown;
		try {
			decoded = JSON.parse(raw);
		} catch (error) {
			throw new Error(
				`invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const validated = PersistedHandoffSchema.safeParse(decoded);
		if (!validated.success) {
			throw new Error(
				`schema mismatch: ${formatPrReviewValidationIssues(validated.error.issues, decoded).join('; ')}`,
			);
		}
		return validated.data;
	};
	let existingHandoff: PersistedHandoff | null = null;
	try {
		existingHandoff = await readPersistedHandoff();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			return failure(
				`operation read path "${relativeHandoffPath.split(path.sep).join('/')}": expected bounded JSON matching the persisted handoff schema, got ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (existingHandoff) {
		if (!handoffsMatch(existingHandoff)) {
			return failure(
				'field handoff: expected an exact retry of the persisted handoff, got conflicting handoff content',
			);
		}
	} else {
		const serializedHandoff = `${JSON.stringify(handoffRecord, null, 2)}\n`;
		const serializedHandoffBytes = Buffer.byteLength(serializedHandoff, 'utf8');
		if (serializedHandoffBytes > PR_REVIEW_HANDOFF_MAX_BYTES) {
			return failure(
				formatPrReviewRuntimeFieldError(
					'handoff',
					`a persisted handoff artifact at most ${PR_REVIEW_HANDOFF_MAX_BYTES} UTF-8 bytes`,
					`${serializedHandoffBytes} bytes`,
				),
			);
		}
		let created: boolean;
		try {
			created = await _internals.atomicCreate(handoffPath, serializedHandoff);
		} catch (error) {
			return operationFailure(
				'create',
				relativeHandoffPath.split(path.sep).join('/'),
				'an atomic create-only handoff artifact',
				error,
			);
		}
		if (!created) {
			let raced: PersistedHandoff;
			try {
				raced = await readPersistedHandoff();
			} catch (error) {
				return failure(
					`operation read path "${relativeHandoffPath.split(path.sep).join('/')}": expected the concurrently persisted handoff schema, got ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!handoffsMatch(raced)) {
				return failure(
					'field handoff: expected an exact retry of the persisted handoff, got conflicting concurrent handoff content',
				);
			}
		}
	}
	let alreadyOffered: boolean;
	try {
		const marked = await markPrReviewHandoffComplete(
			directory,
			sessionID,
			resolvedRunId,
			relativeHandoffPath.split(path.sep).join('/'),
		);
		alreadyOffered = marked.alreadyOffered;
	} catch (error) {
		return operationFailure(
			'update',
			`pr-review/${resolvedRunId}/feedback-consent.json and pr-workflow-gates/${prWorkflowSessionFileStem(sessionID)}.json`,
			'a matching durable consent offer and handoff receipt',
			error,
		);
	}
	return JSON.stringify(
		{
			success: true,
			run_id: resolvedRunId,
			path: relativeHandoffPath.split(path.sep).join('/'),
			finding_count: actionableIds.length,
			already_offered: alreadyOffered,
			confirmation_command: `/swarm pr-feedback ${parsed.data.handoff.pr_url} continue from .swarm/${relativeHandoffPath.split(path.sep).join('/')}`,
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
			run_id: PrReviewRunIdSchema.optional(),
			pr_head_sha: z
				.string()
				.trim()
				.regex(/^[0-9a-f]{6,64}$/i),
			boundary: z
				.enum(['post_explorer', 'post_reviewer', 'post_critic'])
				.optional(),
			records: z.array(PrReviewFindingSchema).min(1).max(1000).optional(),
			partial_base_coverage: PrReviewPartialBaseCoverageSchema.optional(),
			handoff: PrReviewHandoffSchema.optional(),
		},
		execute: executeWritePrReviewArtifact,
	});
