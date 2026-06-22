import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
	type ArtifactInput,
	type ParseFlags,
	type ParsePersistOptions,
	type ParseResultWithSidecar,
	parseAndPersist,
} from '../background/candidate-parser';
import { readLaneOutput } from '../background/lane-output-store';
import { validateSwarmPath } from '../hooks/utils';
import { createSwarmTool } from './create-tool';

// ---------------------------------------------------------------------------
// Zod args schema
// ---------------------------------------------------------------------------

const ParseLaneCandidatesArgsSchema = z
	.object({
		output_ref: z
			.string()
			.min(1)
			.describe(
				'Opaque lane output ref returned as output_ref by dispatch_lanes or collect_lane_results.',
			),
		accept_partial: z
			.boolean()
			.default(false)
			.describe(
				'Accept sources where transcriptIncomplete is true (partial transcripts).',
			),
		accept_degraded: z
			.boolean()
			.default(false)
			.describe(
				'Accept sources where the artifact storage was degraded (output_degraded).',
			),
		degraded: z
			.boolean()
			.default(false)
			.describe(
				'Passed through from DispatchLaneResult.output_degraded by the orchestrator.',
			),
		row_format_version: z
			.number()
			.int()
			.nonnegative()
			.default(1)
			.describe('Row format version; currently only version 1 is supported.'),
		producer: z
			.string()
			.optional()
			.default('swarm-pr-review')
			.describe('Producer label for cross-skill filtering in the sidecar.'),
		use_lockfile: z
			.boolean()
			.default(false)
			.describe(
				'When true, use proper-lockfile for concurrency-safe sidecar writes.',
			),
		project_root: z
			.string()
			.optional()
			.describe(
				'Project root directory where .swarm/ lives. Defaults to the injected working directory.',
			),
	})
	.strict();

// ---------------------------------------------------------------------------
// Lane-output ref path derivation (mirrors lane-output-store internals)
// ---------------------------------------------------------------------------

const REF_RE = /^L1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/;

function laneOutputRelativePath(ref: string): string {
	const parts = ref.split(':');
	if (parts.length !== 4) return '';
	const [, batchDigest, laneDigest, outputDigest] = parts;
	return path.join(
		'lane-results',
		batchDigest,
		laneDigest,
		`${outputDigest}.json`,
	);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const parse_lane_candidates: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Parse [CANDIDATE] rows from a dispatch_lanes or collect_lane_results artifact (by output_ref), produce structured records with provenance, optionally persist to a per-batch sidecar JSONL. Pure-parser variant exists as internal module.',
		args: {
			output_ref: ParseLaneCandidatesArgsSchema.shape.output_ref,
			accept_partial: ParseLaneCandidatesArgsSchema.shape.accept_partial,
			accept_degraded: ParseLaneCandidatesArgsSchema.shape.accept_degraded,
			degraded: ParseLaneCandidatesArgsSchema.shape.degraded,
			row_format_version:
				ParseLaneCandidatesArgsSchema.shape.row_format_version,
			producer: ParseLaneCandidatesArgsSchema.shape.producer,
			use_lockfile: ParseLaneCandidatesArgsSchema.shape.use_lockfile,
			project_root: ParseLaneCandidatesArgsSchema.shape.project_root,
		},
		async execute(args: unknown, directory: string): Promise<string> {
			const parsed = ParseLaneCandidatesArgsSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify(
					{
						success: false,
						failure_class: 'invalid_args',
						message: 'Invalid parse_lane_candidates arguments',
						errors: parsed.error.issues.map(
							(issue) => `${issue.path.join('.')}: ${issue.message}`,
						),
					},
					null,
					2,
				);
			}

			const {
				output_ref,
				accept_partial,
				accept_degraded,
				degraded,
				row_format_version,
				producer,
				use_lockfile,
				project_root,
			} = parsed.data;

			// AGENTS.md invariant 4: project_root (if provided) must resolve within
			// the injected working directory. We refuse values that escape the project
			// root via "..", absolute paths to other roots, or Windows cross-drive paths.
			if (project_root !== undefined) {
				const absRoot = path.resolve(project_root);
				const absDir = path.resolve(directory);
				const rel = path.relative(absDir, absRoot);
				if (
					rel === '..' ||
					rel.startsWith(`..${path.sep}`) ||
					path.isAbsolute(rel)
				) {
					return JSON.stringify(
						{
							success: false,
							failure_class: 'invalid_args',
							message:
								'project_root must resolve within the injected working directory',
							errors: [
								`project_root: ${project_root} is outside the project root ${directory}`,
							],
						},
						null,
						2,
					);
				}
			}

			// -------------------------------------------------------------------
			// Store lookup — distinguish ref-not-found vs artifact-corrupted
			// -------------------------------------------------------------------
			let loaded: ReturnType<typeof readLaneOutput>;
			try {
				loaded = readLaneOutput(directory, output_ref);
			} catch {
				loaded = null;
			}
			if (!loaded) {
				// Distinguish missing file from corrupt content so the parser's
				// own refusal logic can handle each case with the correct
				// artifact_status (FR-001).
				const relPath = REF_RE.test(output_ref)
					? laneOutputRelativePath(output_ref)
					: '';
				const absPath = relPath ? validateSwarmPath(directory, relPath) : '';
				const fileExists = absPath ? existsSync(absPath) : false;

				const artifactStatus: 'ref-not-found' | 'artifact-corrupted' =
					fileExists ? 'artifact-corrupted' : 'ref-not-found';

				// Extract what we can from the ref (format: `L1:BD:LD:OD`).
				const refParts = output_ref.split(':');
				const hasValidRef = REF_RE.test(output_ref) && refParts.length === 4;
				const syntheticBatchId = hasValidRef ? refParts[1] : 'unknown';
				const syntheticLaneId = hasValidRef ? refParts[2] : 'unknown';
				const syntheticDigest = '0'.repeat(64); // valid 64-char hex placeholder

				const artifactInput: ArtifactInput = {
					output_ref,
					batchId: syntheticBatchId,
					laneId: syntheticLaneId,
					agent: 'unknown',
					role: 'unknown',
					digest: syntheticDigest,
					text: '',
					artifact_status: artifactStatus,
					source: 'dispatch_lanes',
					produced_at: new Date().toISOString(),
				};

				const flags: ParseFlags = {
					accept_partial,
					accept_degraded,
					degraded,
					row_format_version,
					...(producer ? { producer } : {}),
				};

				const options: ParsePersistOptions = {
					projectRoot: project_root ?? directory,
					useLockfile: use_lockfile,
					batchDigest: syntheticBatchId,
				};

				const result: ParseResultWithSidecar = parseAndPersist(
					artifactInput,
					flags,
					options,
				);
				return JSON.stringify(result, null, 2);
			}

			const artifact = loaded.artifact;

			// -------------------------------------------------------------------
			// Map artifact → ArtifactInput
			// -------------------------------------------------------------------
			const artifactInput: ArtifactInput = {
				output_ref: artifact.ref,
				batchId: artifact.batchId,
				laneId: artifact.laneId,
				agent: artifact.agent,
				role: artifact.role,
				...(artifact.sessionId !== undefined
					? { sessionId: artifact.sessionId }
					: {}),
				...(artifact.parentSessionId !== undefined
					? { parentSessionId: artifact.parentSessionId }
					: {}),
				digest: artifact.digest,
				text: artifact.text,
				transcriptIncomplete: artifact.transcriptIncomplete,
				artifact_status: 'ok',
				source: artifact.source,
				produced_at: artifact.createdAt ?? artifact.updatedAt,
			};

			// -------------------------------------------------------------------
			// Build ParseFlags
			// -------------------------------------------------------------------
			const flags: ParseFlags = {
				accept_partial,
				accept_degraded,
				degraded,
				row_format_version,
				...(producer ? { producer } : {}),
			};

			// -------------------------------------------------------------------
			// Build ParsePersistOptions
			// -------------------------------------------------------------------
			const options: ParsePersistOptions = {
				projectRoot: project_root ?? directory,
				useLockfile: use_lockfile,
			};

			// -------------------------------------------------------------------
			// Parse and persist
			// -------------------------------------------------------------------
			const result: ParseResultWithSidecar = parseAndPersist(
				artifactInput,
				flags,
				options,
			);

			return JSON.stringify(result, null, 2);
		},
	});
