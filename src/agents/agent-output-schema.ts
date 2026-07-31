import { z } from 'zod';
import type { CuratorMemoryDecision, ProposeMemoryInput } from '../memory';
import {
	CuratorMemoryDecisionSchema,
	MemoryKindSchema,
} from '../memory/schema';

const AgentMemoryProposalSchema = z
	.object({
		operation: z.enum([
			'add',
			'update',
			'delete',
			'ignore',
			'merge',
			'supersede',
		]),
		kind: MemoryKindSchema.optional(),
		text: z.string().min(1).max(2000).optional(),
		targetMemoryId: z.string().optional(),
		relatedMemoryIds: z.array(z.string()).optional(),
		rationale: z.string().min(1).max(2000),
		evidenceRefs: z.array(z.string().min(1).max(500)).max(20).optional(),
	})
	.strict();

export const AgentOutputMemorySchema = z
	.object({
		memoryProposals: z.array(AgentMemoryProposalSchema).max(20).optional(),
	})
	.passthrough();

export const CuratorOutputMemoryDecisionSchema = z
	.object({
		curatorMemoryDecisions: z
			.array(CuratorMemoryDecisionSchema)
			.max(20)
			.optional(),
	})
	.passthrough();

export const ReviewFindingSchema = z
	.object({
		title: z.string().trim().min(1).max(200),
		body: z.string().trim().min(1).max(2000),
		severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
		confidence: z.number().finite().min(0).max(1),
		file: z.string().trim().min(1).max(500),
		line_start: z.number().int().min(1).max(10_000_000),
		line_end: z.number().int().min(1).max(10_000_000),
	})
	.strict()
	.superRefine((finding, ctx) => {
		if (finding.line_end < finding.line_start) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['line_end'],
				message: 'line_end must be greater than or equal to line_start',
			});
		}
	});

export const ReviewFindingsSchema = z
	.object({
		findings: z.array(ReviewFindingSchema).max(50),
		verdict: z.enum(['APPROVED', 'REJECTED']),
		overall_confidence: z.number().finite().min(0).max(1),
	})
	.strict();

export const FindingValidationSchema = z
	.object({
		finding_id: z.string().trim().min(1).max(128),
		disposition: z.enum(['CONFIRMED', 'DISPROVED', 'UNVERIFIED']),
		confidence: z.number().finite().min(0).max(1),
		evidence: z.string().trim().min(1).max(2000),
	})
	.strict();

export const FindingValidationsSchema = z
	.object({
		validations: z.array(FindingValidationSchema).max(50),
	})
	.strict();

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewFindings = z.infer<typeof ReviewFindingsSchema>;
export type FindingValidation = z.infer<typeof FindingValidationSchema>;
export type FindingValidations = z.infer<typeof FindingValidationsSchema>;

export interface ExtractedAgentMemoryProposals {
	proposals: ProposeMemoryInput[];
	error?: string;
}

export interface ExtractedCuratorMemoryDecisions {
	decisions: CuratorMemoryDecision[];
	error?: string;
}

export interface ExtractedReviewFindings {
	findings: ReviewFinding[];
	review?: ReviewFindings;
	error?: string;
}

export interface ExtractedFindingValidations {
	validations: FindingValidation[];
	error?: string;
}

export function extractMemoryProposalsFromAgentOutput(
	outputText: string,
): ExtractedAgentMemoryProposals {
	const candidates = candidateJsonBlocks(outputText);
	for (const candidate of candidates) {
		const parsedJson = parseJsonObject(candidate);
		if (parsedJson === null) continue;
		const parsed = AgentOutputMemorySchema.safeParse(parsedJson);
		if (!parsed.success) {
			return {
				proposals: [],
				error: parsed.error.issues.map((issue) => issue.message).join('; '),
			};
		}
		if (parsed.data.memoryProposals) {
			return { proposals: parsed.data.memoryProposals };
		}
	}
	return { proposals: [] };
}

export function extractCuratorMemoryDecisionsFromAgentOutput(
	outputText: string,
): ExtractedCuratorMemoryDecisions {
	const candidates = candidateJsonBlocks(outputText);
	for (const candidate of candidates) {
		const parsedJson = parseJsonObject(candidate);
		if (parsedJson === null) continue;
		const parsed = CuratorOutputMemoryDecisionSchema.safeParse(parsedJson);
		if (!parsed.success) {
			return {
				decisions: [],
				error: parsed.error.issues.map((issue) => issue.message).join('; '),
			};
		}
		if (parsed.data.curatorMemoryDecisions) {
			return { decisions: parsed.data.curatorMemoryDecisions };
		}
	}
	return { decisions: [] };
}

export function extractReviewFindingsFromAgentOutput(
	outputText: string,
): ExtractedReviewFindings {
	let error: string | undefined;
	const validReviews: ReviewFindings[] = [];
	for (const candidate of candidateJsonBlocks(outputText)) {
		const parsedJson = parseJsonObject(candidate);
		if (parsedJson === null || !('findings' in parsedJson)) continue;
		const parsed = ReviewFindingsSchema.safeParse(parsedJson);
		if (!parsed.success) {
			error ??= formatSchemaError(parsed.error);
			continue;
		}
		validReviews.push(parsed.data);
	}
	if (validReviews.length !== 1) {
		return {
			findings: [],
			error:
				validReviews.length === 0
					? (error ??
						'expected exactly one valid structured findings block, found 0')
					: `expected exactly one valid structured findings block, found ${validReviews.length}`,
		};
	}
	return {
		findings: validReviews[0].findings,
		review: validReviews[0],
	};
}

export function extractFindingValidationsFromAgentOutput(
	outputText: string,
): ExtractedFindingValidations {
	let error: string | undefined;
	const validValidations: FindingValidations[] = [];
	for (const candidate of candidateJsonBlocks(outputText)) {
		const parsedJson = parseJsonObject(candidate);
		if (parsedJson === null || !('validations' in parsedJson)) continue;
		const parsed = FindingValidationsSchema.safeParse(parsedJson);
		if (!parsed.success) {
			error ??= formatSchemaError(parsed.error);
			continue;
		}
		validValidations.push(parsed.data);
	}
	if (validValidations.length !== 1) {
		return {
			validations: [],
			error:
				validValidations.length === 0
					? (error ??
						'expected exactly one valid structured validation block, found 0')
					: `expected exactly one valid structured validation block, found ${validValidations.length}`,
		};
	}
	return { validations: validValidations[0].validations };
}

const MAX_JSON_CANDIDATES = 20;
const MAX_JSON_CANDIDATE_CHARS = 262_144;
const MAX_AGENT_OUTPUT_CHARS = 1_048_576;

function candidateJsonBlocks(outputText: string): string[] {
	if (typeof outputText !== 'string' || outputText.length === 0) return [];
	const boundedOutput = outputText.slice(0, MAX_AGENT_OUTPUT_CHARS);
	const trimmed = boundedOutput.trim();
	const candidates: string[] = [];
	if (
		trimmed.length <= MAX_JSON_CANDIDATE_CHARS &&
		trimmed.startsWith('{') &&
		trimmed.endsWith('}')
	) {
		candidates.push(trimmed);
	}
	const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of boundedOutput.matchAll(fencePattern)) {
		const block = match[1]?.trim();
		if (
			block &&
			block.length <= MAX_JSON_CANDIDATE_CHARS &&
			block.startsWith('{') &&
			block.endsWith('}')
		) {
			candidates.push(block);
			if (candidates.length >= MAX_JSON_CANDIDATES) break;
		}
	}
	return candidates;
}

function formatSchemaError(error: z.ZodError): string {
	return error.issues
		.slice(0, 20)
		.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
		.join('; ')
		.slice(0, 2000);
}

function parseJsonObject(candidate: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(candidate);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
