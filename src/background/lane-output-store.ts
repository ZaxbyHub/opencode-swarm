import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';

export const LANE_OUTPUT_REF_PREFIX = 'L1';
export const MAX_LANE_OUTPUT_STORED_BYTES = 10 * 1024 * 1024;
const LANE_OUTPUT_SCHEMA_VERSION = 1;
const REF_RE = /^L1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/;

const LaneOutputArtifactSchema = z
	.object({
		schemaVersion: z.literal(LANE_OUTPUT_SCHEMA_VERSION),
		ref: z.string().regex(REF_RE),
		batchId: z.string().min(1),
		laneId: z.string().min(1),
		agent: z.string().min(1),
		role: z.string().min(1),
		sessionId: z.string().min(1).optional(),
		parentSessionId: z.string().min(1).optional(),
		mode: z.string().min(1).optional(),
		workflowLane: z.string().min(1).optional(),
		prHeadSha: z.string().min(1).optional(),
		gitHead: z.string().min(1).optional(),
		revisionDigest: z.string().min(1).optional(),
		scope: z.string().min(1).optional(),
		source: z.enum(['dispatch_lanes', 'collect_lane_results']),
		text: z.string(),
		chars: z.number().int().nonnegative(),
		bytes: z.number().int().nonnegative(),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		messageCount: z.number().int().nonnegative().optional(),
		transcriptIncomplete: z.boolean().optional(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.strict();

export type LaneOutputSource = z.infer<
	typeof LaneOutputArtifactSchema
>['source'];
export type LaneOutputArtifact = z.infer<typeof LaneOutputArtifactSchema>;

export interface StoreLaneOutputInput {
	batchId: string;
	laneId: string;
	agent: string;
	role: string;
	sessionId?: string;
	parentSessionId?: string;
	mode?: string;
	workflowLane?: string;
	prHeadSha?: string;
	gitHead?: string;
	revisionDigest?: string;
	scope?: string;
	source: LaneOutputSource;
	text: string;
	messageCount?: number;
	transcriptIncomplete?: boolean;
}

export interface StoreLaneOutputResult {
	ref?: string;
	digest: string;
	chars: number;
	bytes: number;
	degraded: boolean;
	error?: string;
}

export interface ReadLaneOutputResult {
	artifact: LaneOutputArtifact;
}

export function storeLaneOutput(
	directory: string,
	input: StoreLaneOutputInput,
	now: () => number = Date.now,
): StoreLaneOutputResult {
	const bytes = Buffer.byteLength(input.text, 'utf-8');
	const digest = digestText(input.text);
	if (bytes > MAX_LANE_OUTPUT_STORED_BYTES) {
		return {
			digest,
			chars: input.text.length,
			bytes,
			degraded: true,
			error: `lane output exceeds ${MAX_LANE_OUTPUT_STORED_BYTES} byte storage limit`,
		};
	}

	const batchDigest = digestText(input.batchId);
	const laneDigest = digestText(input.laneId);
	const ref = `${LANE_OUTPUT_REF_PREFIX}:${batchDigest}:${laneDigest}:${digest}`;
	const relPath = laneOutputRelativePath(ref);
	const absPath = validateSwarmPath(directory, relPath);
	const timestamp = new Date(now()).toISOString();

	try {
		if (existsSync(absPath)) {
			const existing = LaneOutputArtifactSchema.safeParse(
				JSON.parse(readFileSync(absPath, 'utf-8')),
			);
			if (
				existing.success &&
				hasValidArtifactIntegrity(existing.data, ref) &&
				artifactIdentityMatchesInput(existing.data, input)
			) {
				return {
					ref,
					digest,
					chars: existing.data.chars,
					bytes: existing.data.bytes,
					degraded: false,
				};
			}
			if (existing.success && hasValidArtifactIntegrity(existing.data, ref)) {
				return {
					digest,
					chars: input.text.length,
					bytes,
					degraded: true,
					error:
						'lane output ref collision has incompatible agent/session provenance',
				};
			}
		}

		const artifact: LaneOutputArtifact = {
			schemaVersion: LANE_OUTPUT_SCHEMA_VERSION,
			ref,
			batchId: input.batchId,
			laneId: input.laneId,
			agent: input.agent,
			role: input.role,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			...(input.parentSessionId
				? { parentSessionId: input.parentSessionId }
				: {}),
			...(input.mode ? { mode: input.mode } : {}),
			...(input.workflowLane ? { workflowLane: input.workflowLane } : {}),
			...(input.prHeadSha ? { prHeadSha: input.prHeadSha } : {}),
			...(input.gitHead ? { gitHead: input.gitHead } : {}),
			...(input.revisionDigest ? { revisionDigest: input.revisionDigest } : {}),
			...(input.scope ? { scope: input.scope } : {}),
			source: input.source,
			text: input.text,
			chars: input.text.length,
			bytes,
			digest,
			...(input.messageCount !== undefined
				? { messageCount: input.messageCount }
				: {}),
			...(input.transcriptIncomplete !== undefined
				? { transcriptIncomplete: input.transcriptIncomplete }
				: {}),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		writeAtomicJson(absPath, artifact);
		return {
			ref,
			digest,
			chars: artifact.chars,
			bytes: artifact.bytes,
			degraded: false,
		};
	} catch (error) {
		return {
			digest,
			chars: input.text.length,
			bytes,
			degraded: true,
			error:
				error instanceof Error
					? error.message
					: 'failed to store lane output artifact',
		};
	}
}

export function readLaneOutput(
	directory: string,
	ref: string,
): ReadLaneOutputResult | null {
	if (!REF_RE.test(ref)) return null;
	const absPath = validateSwarmPath(directory, laneOutputRelativePath(ref));
	if (!existsSync(absPath)) return null;
	let parsed: ReturnType<typeof LaneOutputArtifactSchema.safeParse>;
	try {
		parsed = LaneOutputArtifactSchema.safeParse(
			JSON.parse(readFileSync(absPath, 'utf-8')),
		);
	} catch {
		return null;
	}
	if (!parsed.success || !hasValidArtifactIntegrity(parsed.data, ref)) {
		return null;
	}
	return { artifact: parsed.data };
}

export function buildLaneOutputPreview(args: {
	text: string;
	ref?: string;
	degraded?: boolean;
	maxChars: number;
}): { output: string; output_chars: number; output_truncated: boolean } {
	const { text, ref, degraded, maxChars } = args;
	const needsPreview = text.length > maxChars;
	if (!needsPreview && !degraded) {
		return {
			output: text,
			output_chars: text.length,
			output_truncated: false,
		};
	}

	const marker = buildPreviewMarker({
		omittedChars: Math.max(0, text.length - maxChars),
		ref,
		degraded: degraded === true,
	});
	if (text.length <= maxChars && degraded) {
		return {
			output: `${text}${marker}`,
			output_chars: text.length,
			output_truncated: false,
		};
	}

	const budget = Math.max(0, maxChars - marker.length);
	const headChars = Math.ceil(budget / 2);
	const tailChars = Math.floor(budget / 2);
	const head = text.slice(0, headChars);
	const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
	return {
		output: `${head}${marker}${tail}`,
		output_chars: text.length,
		output_truncated: true,
	};
}

export function paginateLaneOutput(
	text: string,
	offset: number,
	limit: number,
): {
	totalLines: number;
	startLine: number;
	endLine: number;
	content: string;
	exhausted: boolean;
} {
	const lines = text.length === 0 ? [] : text.split('\n');
	const totalLines = lines.length;
	const startLine = Math.max(0, offset);
	if (startLine >= totalLines) {
		return {
			totalLines,
			startLine,
			endLine: totalLines,
			content: '',
			exhausted: true,
		};
	}
	const endLine = Math.min(startLine + limit, totalLines);
	return {
		totalLines,
		startLine,
		endLine,
		content: lines.slice(startLine, endLine).join('\n'),
		exhausted: false,
	};
}

function buildPreviewMarker(args: {
	omittedChars: number;
	ref?: string;
	degraded: boolean;
}): string {
	const retrieval = args.ref
		? ` retrieve_lane_output ref=${args.ref} for full output.`
		: ' no full output artifact is available; treat this lane as degraded.';
	const degraded = args.degraded ? ' Artifact storage degraded.' : '';
	return `\n[... lane output preview omitted middle content.${degraded}${retrieval} ...]\n`;
}

function laneOutputRelativePath(ref: string): string {
	const [, batchDigest, laneDigest, outputDigest] = ref.split(':');
	return path.join(
		'lane-results',
		batchDigest,
		laneDigest,
		`${outputDigest}.json`,
	);
}

function hasValidArtifactIntegrity(
	artifact: LaneOutputArtifact,
	expectedRef: string,
): boolean {
	const digest = digestText(artifact.text);
	if (artifact.digest !== digest) return false;
	if (artifact.chars !== artifact.text.length) return false;
	if (artifact.bytes !== Buffer.byteLength(artifact.text, 'utf-8')) {
		return false;
	}
	const batchDigest = digestText(artifact.batchId);
	const laneDigest = digestText(artifact.laneId);
	const expectedArtifactRef = `${LANE_OUTPUT_REF_PREFIX}:${batchDigest}:${laneDigest}:${digest}`;
	return artifact.ref === expectedRef && artifact.ref === expectedArtifactRef;
}

function artifactIdentityMatchesInput(
	artifact: LaneOutputArtifact,
	input: StoreLaneOutputInput,
): boolean {
	return (
		artifact.agent === input.agent &&
		artifact.role === input.role &&
		artifact.sessionId === input.sessionId &&
		artifact.parentSessionId === input.parentSessionId &&
		artifact.mode === input.mode &&
		artifact.workflowLane === input.workflowLane &&
		artifact.prHeadSha === input.prHeadSha &&
		artifact.gitHead === input.gitHead &&
		artifact.revisionDigest === input.revisionDigest &&
		artifact.scope === input.scope &&
		artifact.source === input.source
	);
}

// Windows can briefly hold a file handle after close; retry on transient errors.
const WINDOWS_RENAME_MAX_RETRIES = 3;

function writeAtomicJson(absPath: string, value: unknown): void {
	mkdirSync(path.dirname(absPath), { recursive: true });
	const tempFile = `${absPath}.tmp-${Date.now()}-${process.pid}`;
	try {
		writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf-8');
		let lastRenameError: unknown;
		for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
			try {
				renameSync(tempFile, absPath);
				lastRenameError = undefined;
				break;
			} catch (err) {
				lastRenameError = err;
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EPERM') break;
			}
		}
		if (lastRenameError) throw lastRenameError;
	} finally {
		if (existsSync(tempFile)) {
			try {
				unlinkSync(tempFile);
			} catch {
				/* best-effort cleanup */
			}
		}
	}
}

function digestText(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}
