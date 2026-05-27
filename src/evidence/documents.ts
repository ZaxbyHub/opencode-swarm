import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { redactSecrets } from '../memory/redaction';

const EVIDENCE_CACHE_FILE = 'evidence-cache/documents.jsonl';
const MAX_EVIDENCE_TEXT_LENGTH = 4000;

export type EvidenceDocumentSourceType =
	| 'api_docs'
	| 'web_search'
	| 'crawl'
	| 'manual';

export interface EvidenceDocumentInput {
	sourceType: EvidenceDocumentSourceType;
	query?: string;
	title?: string;
	url?: string;
	text?: string;
	snippet?: string;
	capturedAt?: string;
	createdBy?: string;
	metadata?: Record<string, unknown>;
}

export interface EvidenceDocumentRecord {
	id: string;
	ref: string;
	sourceType: EvidenceDocumentSourceType;
	query?: string;
	title?: string;
	url?: string;
	text: string;
	capturedAt: string;
	createdBy?: string;
	metadata: Record<string, unknown>;
}

export interface WriteEvidenceDocumentsResult {
	path: string;
	records: EvidenceDocumentRecord[];
	refs: string[];
}

export async function writeEvidenceDocuments(
	directory: string,
	inputs: EvidenceDocumentInput[],
	now: () => Date = () => new Date(),
): Promise<WriteEvidenceDocumentsResult> {
	const filePath = validateSwarmPath(directory, EVIDENCE_CACHE_FILE);
	const capturedAt = now().toISOString();
	const records = inputs
		.map((input) => createEvidenceDocumentRecord(input, capturedAt))
		.filter((record): record is EvidenceDocumentRecord => record !== null);

	if (records.length > 0) {
		await mkdir(path.dirname(filePath), { recursive: true });
		await appendFile(
			filePath,
			`${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
			'utf-8',
		);
	}

	return {
		path: '.swarm/evidence-cache/documents.jsonl',
		records,
		refs: records.map((record) => record.ref),
	};
}

export function createEvidenceDocumentRecord(
	input: EvidenceDocumentInput,
	defaultCapturedAt: string,
): EvidenceDocumentRecord | null {
	const text = normalizeEvidenceText(input.text ?? input.snippet ?? '');
	if (!text) return null;
	const capturedAt = input.capturedAt ?? defaultCapturedAt;
	const base = {
		sourceType: input.sourceType,
		query: normalizeOptional(input.query),
		title: normalizeOptional(input.title),
		url: normalizeOptional(input.url),
		text,
	};
	const id = createEvidenceDocumentId(base);
	return {
		id,
		ref: `evidence-cache:${id}`,
		...base,
		capturedAt,
		createdBy: normalizeOptional(input.createdBy),
		metadata: input.metadata ?? {},
	};
}

function createEvidenceDocumentId(input: {
	sourceType: EvidenceDocumentSourceType;
	query?: string;
	title?: string;
	url?: string;
	text: string;
}): string {
	const hash = createHash('sha256')
		.update(
			[
				input.sourceType,
				input.query ?? '',
				input.title ?? '',
				input.url ?? '',
				input.text,
			].join('\n'),
		)
		.digest('hex');
	return `evd_${hash.slice(0, 16)}`;
}

function normalizeEvidenceText(text: string): string {
	const normalized = redactSecrets(text.replace(/\s+/g, ' ').trim());
	return truncateEvidenceText(normalized, MAX_EVIDENCE_TEXT_LENGTH);
}

function truncateEvidenceText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	const truncated = text.slice(0, maxLength);
	const lastPlaceholderStart = truncated.lastIndexOf('[REDACTED:');
	const lastPlaceholderEnd = truncated.lastIndexOf(']');
	if (lastPlaceholderStart > lastPlaceholderEnd) {
		return truncated.slice(0, lastPlaceholderStart).trimEnd();
	}
	return truncated;
}

function normalizeOptional(value: string | undefined): string | undefined {
	const normalized = value?.replace(/\s+/g, ' ').trim();
	return normalized ? redactSecrets(normalized) : undefined;
}
