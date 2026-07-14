import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withEvidenceLock } from '../evidence/lock.js';
import { EvaluationRunV1Schema, GateAuditResultV1Schema } from './contracts.js';
import { getProtectedEvaluationRunIds } from './store.js';

export type EvaluationArtifactNamespace = 'evaluation-run' | 'gate-audit';

export type EvaluationArtifactRef = {
	namespace: EvaluationArtifactNamespace;
	id: string;
};

export type EvaluationRetentionFailure = {
	artifact: EvaluationArtifactRef;
	error: string;
};

export type EvaluationRetentionResult = {
	inventory: EvaluationArtifactRef[];
	selected: EvaluationArtifactRef[];
	archived: EvaluationArtifactRef[];
	corrupt: EvaluationArtifactRef[];
	protected: EvaluationArtifactRef[];
	failed: EvaluationRetentionFailure[];
};

/** Compatibility shape retained for existing direct gate-audit callers. */
export type GateAuditRetentionResult = {
	selected: string[];
	archived: string[];
	corrupt: string[];
	protected: string[];
	failed: string[];
};

type Candidate = {
	artifact: EvaluationArtifactRef;
	createdAt: string;
	target: string;
	kind: 'file' | 'directory';
};

function artifactKey(artifact: EvaluationArtifactRef): string {
	return `${artifact.namespace}/${artifact.id}`;
}

function validId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value);
}

async function evaluationRunCandidates(directory: string): Promise<{
	candidates: Candidate[];
	corrupt: EvaluationArtifactRef[];
}> {
	const root = path.join(directory, '.swarm', 'evolution', 'runs');
	let entries: import('node:fs').Dirent[] = [];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { candidates: [], corrupt: [] };
		}
		throw error;
	}
	const candidates: Candidate[] = [];
	const corrupt: EvaluationArtifactRef[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
		const id = entry.name.slice(0, -'.json'.length);
		if (!validId(id)) continue;
		const artifact = { namespace: 'evaluation-run' as const, id };
		const target = path.join(root, entry.name);
		try {
			const run = EvaluationRunV1Schema.parse(
				JSON.parse(await fs.readFile(target, 'utf8')),
			);
			if (run.runId !== id) throw new Error('run id/path mismatch');
			candidates.push({
				artifact,
				createdAt: run.createdAt,
				target,
				kind: 'file',
			});
		} catch {
			corrupt.push(artifact);
		}
	}
	return { candidates, corrupt };
}

async function gateAuditCandidates(directory: string): Promise<{
	candidates: Candidate[];
	corrupt: EvaluationArtifactRef[];
}> {
	const root = path.join(directory, '.swarm', 'evidence', 'gate-audit');
	let entries: import('node:fs').Dirent[] = [];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { candidates: [], corrupt: [] };
		}
		throw error;
	}
	const candidates: Candidate[] = [];
	const corrupt: EvaluationArtifactRef[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || !validId(entry.name)) continue;
		const artifact = { namespace: 'gate-audit' as const, id: entry.name };
		const target = path.join(root, entry.name);
		try {
			const result = GateAuditResultV1Schema.parse(
				JSON.parse(
					await fs.readFile(path.join(target, 'results.json'), 'utf8'),
				),
			);
			if (result.runId !== entry.name) throw new Error('run id/path mismatch');
			candidates.push({
				artifact,
				createdAt: result.createdAt,
				target,
				kind: 'directory',
			});
		} catch {
			corrupt.push(artifact);
		}
	}
	return { candidates, corrupt };
}

async function retentionCandidates(directory: string): Promise<{
	candidates: Candidate[];
	corrupt: EvaluationArtifactRef[];
}> {
	const [runs, audits] = await Promise.all([
		evaluationRunCandidates(directory),
		gateAuditCandidates(directory),
	]);
	return {
		candidates: [...runs.candidates, ...audits.candidates].sort((a, b) =>
			artifactKey(a.artifact).localeCompare(artifactKey(b.artifact)),
		),
		corrupt: [...runs.corrupt, ...audits.corrupt].sort((a, b) =>
			artifactKey(a).localeCompare(artifactKey(b)),
		),
	};
}

async function protectedArtifacts(directory: string): Promise<Set<string>> {
	const ids = await getProtectedEvaluationRunIds(directory);
	return new Set([...ids].map((id) => `evaluation-run/${id}`));
}

async function removeCandidate(candidate: Candidate): Promise<void> {
	if (candidate.kind === 'directory') {
		await fs.rm(candidate.target, { recursive: true, force: true });
		return;
	}
	await fs.unlink(candidate.target);
}

export const _retentionInternals: {
	protectedArtifacts: typeof protectedArtifacts;
	removeCandidate: typeof removeCandidate;
} = {
	protectedArtifacts,
	removeCandidate,
};

/**
 * Apply one age/count policy to generic evaluation runs and gate-audit detail.
 * Namespaced references prevent unrelated run IDs from protecting one another.
 */
export async function archiveEvaluationArtifacts(args: {
	directory: string;
	maxAgeDays: number;
	maxBundles?: number;
	dryRun?: boolean;
	now?: Date;
}): Promise<EvaluationRetentionResult> {
	return withEvidenceLock(
		args.directory,
		path.join('evolution', 'retention-index'),
		'evaluation-retention',
		'archive',
		async () => {
			const inventory = await retentionCandidates(args.directory);
			let protectedKeys = await _retentionInternals.protectedArtifacts(
				args.directory,
			);
			const protectedRefs = inventory.candidates
				.filter((candidate) =>
					protectedKeys.has(artifactKey(candidate.artifact)),
				)
				.map((candidate) => candidate.artifact);
			const eligible = inventory.candidates.filter(
				(candidate) => !protectedKeys.has(artifactKey(candidate.artifact)),
			);
			const now = args.now ?? new Date();
			const cutoff = new Date(
				now.getTime() - args.maxAgeDays * 86_400_000,
			).toISOString();
			const selectedKeys = new Set(
				eligible
					.filter((candidate) => candidate.createdAt < cutoff)
					.map((candidate) => artifactKey(candidate.artifact)),
			);
			const remaining = eligible
				.filter(
					(candidate) => !selectedKeys.has(artifactKey(candidate.artifact)),
				)
				.sort((a, b) =>
					a.createdAt === b.createdAt
						? artifactKey(a.artifact).localeCompare(artifactKey(b.artifact))
						: a.createdAt.localeCompare(b.createdAt),
				);
			if (args.maxBundles !== undefined && remaining.length > args.maxBundles) {
				for (const candidate of remaining.slice(
					0,
					remaining.length - args.maxBundles,
				)) {
					selectedKeys.add(artifactKey(candidate.artifact));
				}
			}
			const selectedCandidates = eligible
				.filter((candidate) =>
					selectedKeys.has(artifactKey(candidate.artifact)),
				)
				.sort((a, b) =>
					artifactKey(a.artifact).localeCompare(artifactKey(b.artifact)),
				);
			const archived: EvaluationArtifactRef[] = [];
			const failed: EvaluationRetentionFailure[] = [];
			if (!args.dryRun) {
				for (const candidate of selectedCandidates) {
					// Re-read lineage immediately before deletion. A concurrent decision or
					// held-out claim that became durable after inventory wins preservation.
					protectedKeys = await _retentionInternals.protectedArtifacts(
						args.directory,
					);
					if (protectedKeys.has(artifactKey(candidate.artifact))) {
						protectedRefs.push(candidate.artifact);
						continue;
					}
					try {
						await _retentionInternals.removeCandidate(candidate);
						archived.push(candidate.artifact);
					} catch (error) {
						failed.push({
							artifact: candidate.artifact,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
			return {
				inventory: inventory.candidates.map((candidate) => candidate.artifact),
				selected: selectedCandidates.map((candidate) => candidate.artifact),
				archived,
				corrupt: inventory.corrupt,
				protected: [
					...new Map(
						protectedRefs.map((artifact) => [artifactKey(artifact), artifact]),
					).values(),
				].sort((a, b) => artifactKey(a).localeCompare(artifactKey(b))),
				failed,
			};
		},
	);
}

export async function archiveGateAuditResults(args: {
	directory: string;
	maxAgeDays: number;
	maxBundles?: number;
	dryRun?: boolean;
	now?: Date;
}): Promise<GateAuditRetentionResult> {
	const result = await archiveEvaluationArtifacts(args);
	const gateIds = (artifacts: EvaluationArtifactRef[]) =>
		artifacts
			.filter((artifact) => artifact.namespace === 'gate-audit')
			.map((artifact) => artifact.id);
	return {
		selected: gateIds(result.selected),
		archived: gateIds(result.archived),
		corrupt: gateIds(result.corrupt),
		protected: gateIds(result.protected),
		failed: result.failed
			.filter((failure) => failure.artifact.namespace === 'gate-audit')
			.map((failure) => failure.artifact.id),
	};
}
