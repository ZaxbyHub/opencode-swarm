import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_CORPUS_CASES = 256;
export const MAX_HELDOUT_MANIFEST_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 4 * 1024 * 1024;

export interface HeldoutRecallCorpusCase {
	id?: string;
	language: string;
	expected_symbols: string[];
	expected_edges: Array<string | { from: string; to: string }>;
	known_misses: string[];
	spurious_edges: Array<string | { from: string; to: string }>;
	paraphrase: string;
	source_path?: string;
	content_hash?: string;
	analyzer_id?: string;
}

export interface HeldoutRecallCorpusManifest {
	corpus_id: string;
	split: 'heldout';
	version?: string;
	thresholds?: Record<string, number>;
	cases: HeldoutRecallCorpusCase[];
}

export interface LoadedHeldoutRecallScenario extends HeldoutRecallCorpusCase {
	id: string;
	source_text: string;
	source_hash: string;
	source_provenance: 'direct-source';
}

/**
 * Validate the data contract only. Filesystem membership, safe paths, byte
 * caps, and source hashes are intentionally enforced by the loader below.
 */
export function validateHeldoutRecallCorpusManifest(
	value: unknown,
): asserts value is HeldoutRecallCorpusManifest {
	if (!value || typeof value !== 'object')
		throw new Error('held-out corpus manifest must be an object');
	const manifest = value as Record<string, unknown>;
	if (typeof manifest.corpus_id !== 'string' || !manifest.corpus_id.trim())
		throw new Error('held-out corpus manifest requires corpus_id');
	if (manifest.split !== 'heldout')
		throw new Error('held-out corpus manifest requires heldout split');
	if (
		manifest.version !== undefined &&
		(typeof manifest.version !== 'string' || !manifest.version.trim())
	)
		throw new Error('held-out corpus manifest has invalid version');
	if (manifest.thresholds !== undefined) {
		if (
			!manifest.thresholds ||
			typeof manifest.thresholds !== 'object' ||
			Array.isArray(manifest.thresholds) ||
			Object.keys(manifest.thresholds as object).length === 0
		)
			throw new Error('held-out corpus manifest has invalid thresholds');
		for (const [name, threshold] of Object.entries(
			manifest.thresholds as Record<string, unknown>,
		)) {
			if (
				!name.trim() ||
				typeof threshold !== 'number' ||
				!Number.isFinite(threshold)
			)
				throw new Error('held-out corpus manifest has invalid thresholds');
		}
	}
	if (
		!Array.isArray(manifest.cases) ||
		manifest.cases.length === 0 ||
		manifest.cases.length > MAX_CORPUS_CASES
	)
		throw new Error('held-out corpus manifest has invalid cases');
	const sourcePaths = new Set<string>();
	const caseIds = new Set<string>();
	for (const [index, entry] of manifest.cases.entries()) {
		if (!entry || typeof entry !== 'object')
			throw new Error(`held-out corpus case ${index} must be an object`);
		const item = entry as Record<string, unknown>;
		for (const key of ['language', 'paraphrase'] as const) {
			if (typeof item[key] !== 'string' || !item[key].trim())
				throw new Error(`held-out corpus case ${index} has invalid ${key}`);
		}
		for (const key of ['expected_symbols', 'known_misses'] as const) {
			if (
				!Array.isArray(item[key]) ||
				item[key].length === 0 ||
				item[key].some(
					(element) => typeof element !== 'string' || !element.trim(),
				)
			)
				throw new Error(`held-out corpus case ${index} has invalid ${key}`);
		}
		for (const key of ['expected_edges', 'spurious_edges'] as const) {
			if (
				!Array.isArray(item[key]) ||
				item[key].length === 0 ||
				item[key].some((edge) => !isValidEdge(edge))
			)
				throw new Error(`held-out corpus case ${index} has invalid ${key}`);
		}
		for (const key of ['id', 'analyzer_id'] as const) {
			if (
				item[key] !== undefined &&
				(typeof item[key] !== 'string' || !item[key].trim())
			)
				throw new Error(`held-out corpus case ${index} has invalid ${key}`);
		}
		const scenarioId =
			typeof item.id === 'string' ? item.id : `${item.language}-${index + 1}`;
		if (caseIds.has(scenarioId))
			throw new Error(`held-out corpus case ${index} duplicates id`);
		caseIds.add(scenarioId);
		if (
			item.source_path !== undefined &&
			(typeof item.source_path !== 'string' || !item.source_path.trim())
		)
			throw new Error(`held-out corpus case ${index} has invalid source_path`);
		if (
			item.content_hash !== undefined &&
			(typeof item.content_hash !== 'string' ||
				!/^[a-f0-9]{64}$/i.test(item.content_hash))
		)
			throw new Error(`held-out corpus case ${index} has invalid content_hash`);
		if (typeof item.source_path === 'string') {
			if (sourcePaths.has(item.source_path))
				throw new Error(`held-out corpus case ${index} duplicates source_path`);
			sourcePaths.add(item.source_path);
		}
	}
}

function isValidEdge(value: unknown): boolean {
	if (typeof value === 'string') return Boolean(value.trim());
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const edge = value as Record<string, unknown>;
	return (
		typeof edge.from === 'string' &&
		Boolean(edge.from.trim()) &&
		typeof edge.to === 'string' &&
		Boolean(edge.to.trim())
	);
}

/**
 * Hash source text after canonicalizing all supported line endings. This keeps
 * corpus identity stable when a checked-out fixture is rewritten as CRLF or
 * lone-CR text by a platform or editor.
 */
function computeCanonicalSourceHash(source: Buffer): string {
	return createHash('sha256')
		.update(source.toString('utf8').replace(/\r\n?|\n/g, '\n'))
		.digest('hex');
}

/**
 * Bounded filesystem boundary for held-out corpora. It does not recurse, and
 * every optional source file must remain inside the supplied corpus root.
 */
export async function loadHeldoutRecallEvaluationCorpus(
	corpusDirectory: string,
): Promise<HeldoutRecallCorpusManifest> {
	return (await loadHeldoutRecallEvaluationScenarios(corpusDirectory)).manifest;
}

/**
 * Bounded direct-source scenarios for production retrieval evaluation. This
 * loader validates corpus membership and content hashes; it never scores or
 * manufactures analyzer results.
 */
export async function loadHeldoutRecallEvaluationScenarios(
	corpusDirectory: string,
): Promise<{
	manifest: HeldoutRecallCorpusManifest;
	scenarios: LoadedHeldoutRecallScenario[];
}> {
	const root = await fs.realpath(path.resolve(corpusDirectory));
	const manifestPath = await fs.realpath(path.join(root, 'manifest.json'));
	const manifestRelative = path.relative(root, manifestPath);
	if (manifestRelative.startsWith('..') || path.isAbsolute(manifestRelative))
		throw new Error('held-out corpus manifest path escapes corpus root');
	const stat = await fs.stat(manifestPath);
	if (!stat.isFile())
		throw new Error('held-out corpus manifest must be a regular file');
	if (stat.size > MAX_HELDOUT_MANIFEST_BYTES)
		throw new Error('held-out corpus manifest exceeds byte limit');
	const manifest = JSON.parse(
		await fs.readFile(manifestPath, 'utf8'),
	) as unknown;
	validateHeldoutRecallCorpusManifest(manifest);
	let totalSourceBytes = 0;
	const scenarios: LoadedHeldoutRecallScenario[] = [];
	for (const [index, entry] of manifest.cases.entries()) {
		if (!entry.source_path || !entry.content_hash)
			throw new Error(
				'held-out corpus source cases require source_path and content_hash',
			);
		const sourceCandidate = path.resolve(root, entry.source_path);
		const candidateRelative = path.relative(root, sourceCandidate);
		if (
			candidateRelative.startsWith('..') ||
			path.isAbsolute(candidateRelative)
		)
			throw new Error('held-out corpus source path escapes corpus root');
		const sourcePath = await fs.realpath(sourceCandidate);
		const relative = path.relative(root, sourcePath);
		if (relative.startsWith('..') || path.isAbsolute(relative))
			throw new Error('held-out corpus source path escapes corpus root');
		const sourceStat = await fs.stat(sourcePath);
		if (!sourceStat.isFile())
			throw new Error('held-out corpus source must be a regular file');
		if (sourceStat.size > MAX_SOURCE_BYTES)
			throw new Error('held-out corpus source exceeds byte limit');
		totalSourceBytes += sourceStat.size;
		if (totalSourceBytes > MAX_TOTAL_SOURCE_BYTES)
			throw new Error('held-out corpus sources exceed aggregate byte limit');
		const source = await fs.readFile(sourcePath);
		const sourceHash = computeCanonicalSourceHash(source);
		if (entry.content_hash && sourceHash !== entry.content_hash.toLowerCase())
			throw new Error(
				`held-out corpus source hash mismatch: ${entry.source_path}`,
			);
		scenarios.push({
			...entry,
			id: entry.id ?? `${entry.language}-${index + 1}`,
			source_text: source.toString('utf8'),
			source_hash: sourceHash,
			source_provenance: 'direct-source',
		});
	}
	return { manifest, scenarios };
}
