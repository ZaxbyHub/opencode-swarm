import { z } from 'zod';
import type { ProposeMemoryInput } from '../memory/gateway';
import { MemoryKindSchema } from '../memory/schema';

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

export interface ExtractedAgentMemoryProposals {
	proposals: ProposeMemoryInput[];
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

function candidateJsonBlocks(outputText: string): string[] {
	const trimmed = outputText.trim();
	const candidates: string[] = [];
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		candidates.push(trimmed);
	}
	const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of outputText.matchAll(fencePattern)) {
		const block = match[1]?.trim();
		if (block?.startsWith('{') && block.endsWith('}')) {
			candidates.push(block);
		}
	}
	return candidates;
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
