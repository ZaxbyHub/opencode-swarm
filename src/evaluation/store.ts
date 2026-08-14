import { mkdir, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
	type ImmutableArtifactConflict,
	readOptionalFile as readOptional,
	writeImmutableArtifact,
} from '../evidence/immutable-store.js';
import { withEvidenceLock } from '../evidence/lock.js';
import { atomicWriteFile } from '../evidence/task-file.js';
import { assertProjectRoot } from '../utils/project-boundary.js';
import {
	type EvaluationRunV1,
	EvaluationRunV1Schema,
	type EvaluationTaskV1,
	EvaluationTaskV1Schema,
	type GateAuditManifestV1,
	GateAuditManifestV1Schema,
	type GateAuditResultV1,
	GateAuditResultV1Schema,
	type PromotionDecisionV1,
	PromotionDecisionV1Schema,
	type TaskSetSnapshotV1,
	TaskSetSnapshotV1Schema,
	type TestConsumptionClaimV1,
	TestConsumptionClaimV1Schema,
} from './contracts.js';
import {
	canonicalJson,
	computeRunIntegrityHash,
	computeTaskInputContentHash,
	computeTaskLineageInputHash,
	computeTaskSetContentHash,
	resolveContainedExistingPath,
} from './hashing.js';

const AGENT = 'evaluation-store';
const TEST_LEDGER_RELATIVE = path.join('evolution', 'test-consumption.jsonl');
const TASK_SPLIT_REGISTRY_RELATIVE = path.join(
	'evolution',
	'tasks',
	'split-registry.json',
);

type TaskSplitRegistryEntry = {
	lineageHash: string;
	split: EvaluationTaskV1['split'];
	taskIds: string[];
	inputHashes: string[];
};

type TaskSplitRegistry = { v: 1; entries: TaskSplitRegistryEntry[] };

export class EvaluationConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EvaluationConflictError';
	}
}

export class TestAlreadyConsumedError extends Error {
	readonly priorClaim: TestConsumptionClaimV1;

	constructor(priorClaim: TestConsumptionClaimV1) {
		super(
			`held-out test task set ${priorClaim.taskSetHash} was already consumed by run ${priorClaim.runId}`,
		);
		this.name = 'TestAlreadyConsumedError';
		this.priorClaim = priorClaim;
	}
}

function swarmPath(directory: string, ...segments: string[]): string {
	return path.join(directory, '.swarm', ...segments);
}

function serialized(value: unknown): string {
	return `${canonicalJson(value)}\n`;
}

function parseTaskSplitRegistry(
	content: string | undefined,
): TaskSplitRegistry {
	if (content === undefined) return { v: 1, entries: [] };
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new EvaluationConflictError(
			`task split registry is corrupt: ${String(error)}`,
		);
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new EvaluationConflictError('task split registry is corrupt');
	}
	const record = value as Record<string, unknown>;
	if (record.v !== 1 || !Array.isArray(record.entries)) {
		throw new EvaluationConflictError('task split registry is corrupt');
	}
	const entries = record.entries.map((candidate) => {
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			Array.isArray(candidate)
		) {
			throw new EvaluationConflictError('task split registry is corrupt');
		}
		const entry = candidate as Record<string, unknown>;
		if (
			typeof entry.lineageHash !== 'string' ||
			!['train', 'validation', 'test'].includes(String(entry.split)) ||
			!Array.isArray(entry.taskIds) ||
			!entry.taskIds.every((id) => typeof id === 'string') ||
			!Array.isArray(entry.inputHashes) ||
			!entry.inputHashes.every((hash) => typeof hash === 'string')
		) {
			throw new EvaluationConflictError('task split registry is corrupt');
		}
		return {
			lineageHash: entry.lineageHash,
			split: entry.split as EvaluationTaskV1['split'],
			taskIds: [...new Set(entry.taskIds as string[])].sort(),
			inputHashes: [...new Set(entry.inputHashes as string[])].sort(),
		};
	});
	return { v: 1, entries };
}

/** Evaluation-store wording for the shared writer's conflict outcomes. */
function evaluationConflictError(conflict: ImmutableArtifactConflict): Error {
	return conflict.kind === 'corrupt'
		? new EvaluationConflictError(
				`existing evaluation artifact is corrupt: ${conflict.filePath}: ${String(conflict.cause)}`,
			)
		: new EvaluationConflictError(
				`immutable evaluation artifact conflicts with existing content: ${conflict.filePath}`,
			);
}

/**
 * Evaluation-store binding of the shared immutable-artifact writer
 * (`src/evidence/immutable-store.ts`), which the consensus report store shares.
 * Fixes this store's lock actor, canonical serializer, and conflict error type
 * so every call site below stays a plain write-once request.
 */
function writeImmutable<T>(options: {
	directory: string;
	relativeLockPath: string;
	filePath: string;
	taskId: string;
	value: T;
	parse: (value: unknown) => T;
	isEquivalent?: (existing: T, desired: T) => boolean;
}): Promise<T> {
	return writeImmutableArtifact({
		...options,
		agent: AGENT,
		serialize: serialized,
		conflictError: evaluationConflictError,
	});
}

function validateTaskInputs(directory: string, task: EvaluationTaskV1): void {
	resolveContainedExistingPath(directory, task.instructionPath);
	const environmentRoot = resolveContainedExistingPath(
		directory,
		task.environment.path,
	);
	if (task.scorer.kind === 'project') {
		const executable = task.scorer.argv[0];
		if (!executable) throw new Error('project scorer requires an executable');
		const scorerPath = resolveContainedExistingPath(directory, executable);
		const relative = path.relative(environmentRoot, scorerPath);
		if (
			!relative ||
			relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			throw new Error(
				'project scorer executable must be inside the admitted task environment',
			);
		}
	}
}

export async function admitEvaluationTask(
	directory: string,
	input: EvaluationTaskV1,
	inputRoot: string = directory,
): Promise<EvaluationTaskV1> {
	const task = EvaluationTaskV1Schema.parse(input);
	if (
		(await computeTaskInputContentHash(inputRoot, task)) !== task.contentHash
	) {
		throw new Error(
			`task ${task.id} content hash does not match its canonical inputs`,
		);
	}
	validateTaskInputs(inputRoot, task);
	const lineageInputHash = await computeTaskLineageInputHash(inputRoot, task);
	const relative = path.join(
		'evolution',
		'tasks',
		task.split,
		`${task.id}.json`,
	);
	const admissionLock = TASK_SPLIT_REGISTRY_RELATIVE;
	const filePath = swarmPath(directory, relative);
	assertProjectRoot(directory);
	await mkdir(path.dirname(filePath), { recursive: true });
	return withEvidenceLock(
		directory,
		admissionLock,
		AGENT,
		task.id,
		async () => {
			const registryPath = swarmPath(directory, TASK_SPLIT_REGISTRY_RELATIVE);
			const registry = parseTaskSplitRegistry(await readOptional(registryPath));
			const existingTaskEntry = registry.entries.find((entry) =>
				entry.taskIds.includes(task.id),
			);
			if (existingTaskEntry && existingTaskEntry.split !== task.split) {
				throw new EvaluationConflictError(
					`task ${task.id} is already admitted to a different split`,
				);
			}
			const parentEntry = task.derivedFromTaskId
				? registry.entries.find((entry) =>
						entry.taskIds.includes(task.derivedFromTaskId as string),
					)
				: undefined;
			if (task.derivedFromTaskId && !parentEntry) {
				throw new EvaluationConflictError(
					`derived task ${task.id} references an unadmitted parent ${task.derivedFromTaskId}`,
				);
			}
			const lineageEntry =
				parentEntry ??
				registry.entries.find(
					(entry) =>
						entry.lineageHash === lineageInputHash ||
						entry.inputHashes.includes(lineageInputHash),
				);
			if (lineageEntry && lineageEntry.split !== task.split) {
				throw new EvaluationConflictError(
					`task ${task.id} lineage is already admitted to ${lineageEntry.split}; derived and aliased tasks must inherit that split`,
				);
			}
			for (const split of ['train', 'validation', 'test'] as const) {
				if (split === task.split) continue;
				if (
					await readOptional(
						swarmPath(
							directory,
							'evolution',
							'tasks',
							split,
							`${task.id}.json`,
						),
					)
				) {
					throw new EvaluationConflictError(
						`task ${task.id} is already admitted to a different split`,
					);
				}
			}
			const desired = serialized(task);
			const existing = await readOptional(filePath);
			if (existing !== undefined) {
				const parsed = EvaluationTaskV1Schema.parse(JSON.parse(existing));
				if (serialized(parsed) === desired) {
					if (lineageEntry) {
						lineageEntry.taskIds = [
							...new Set([...lineageEntry.taskIds, task.id]),
						].sort();
						lineageEntry.inputHashes = [
							...new Set([...lineageEntry.inputHashes, lineageInputHash]),
						].sort();
					} else {
						registry.entries.push({
							lineageHash: lineageInputHash,
							split: task.split,
							taskIds: [task.id],
							inputHashes: [lineageInputHash],
						});
					}
					registry.entries.sort((left, right) =>
						left.lineageHash.localeCompare(right.lineageHash),
					);
					await atomicWriteFile(registryPath, serialized(registry));
					return parsed;
				}
				if (task.split !== 'train') {
					throw new EvaluationConflictError(
						`${task.split} task ${task.id} is immutable after admission`,
					);
				}
			}
			await atomicWriteFile(filePath, desired);
			if (lineageEntry) {
				lineageEntry.taskIds = [
					...new Set([...lineageEntry.taskIds, task.id]),
				].sort();
				lineageEntry.inputHashes = [
					...new Set([...lineageEntry.inputHashes, lineageInputHash]),
				].sort();
			} else {
				registry.entries.push({
					lineageHash: lineageInputHash,
					split: task.split,
					taskIds: [task.id],
					inputHashes: [lineageInputHash],
				});
			}
			registry.entries.sort((left, right) =>
				left.lineageHash.localeCompare(right.lineageHash),
			);
			await atomicWriteFile(registryPath, serialized(registry));
			return task;
		},
	);
}

export async function saveTaskSetSnapshot(
	directory: string,
	input: TaskSetSnapshotV1,
	inputRoot: string = directory,
): Promise<TaskSetSnapshotV1> {
	const snapshot = TaskSetSnapshotV1Schema.parse(input);
	const ids = snapshot.tasks.map((task) => task.id);
	if (new Set(ids).size !== ids.length)
		throw new Error('task-set contains duplicate task ids');
	if (snapshot.tasks.some((task) => task.split !== snapshot.split)) {
		throw new Error('task-set tasks must all belong to the declared split');
	}
	for (const task of snapshot.tasks) {
		if (
			(await computeTaskInputContentHash(inputRoot, task)) !== task.contentHash
		) {
			throw new Error(`task ${task.id} content hash is invalid`);
		}
	}
	if (computeTaskSetContentHash(snapshot) !== snapshot.contentHash) {
		throw new Error(
			'task-set content hash does not match its canonical inputs',
		);
	}
	const relative = path.join(
		'evolution',
		'task-sets',
		`${snapshot.contentHash}.json`,
	);
	return writeImmutable({
		directory,
		relativeLockPath: relative,
		filePath: swarmPath(directory, relative),
		taskId: snapshot.id,
		value: snapshot,
		parse: (value) => TaskSetSnapshotV1Schema.parse(value),
		isEquivalent: (existing, desired) =>
			existing.contentHash === desired.contentHash,
	});
}

export async function saveEvaluationRun(
	directory: string,
	input: EvaluationRunV1,
): Promise<EvaluationRunV1> {
	const run = EvaluationRunV1Schema.parse(input);
	if (computeRunIntegrityHash(run) !== run.integrityHash) {
		throw new Error(`run ${run.runId} integrity hash is invalid`);
	}
	const relative = path.join('evolution', 'runs', `${run.runId}.json`);
	return writeImmutable({
		directory,
		relativeLockPath: relative,
		filePath: swarmPath(directory, relative),
		taskId: run.runId,
		value: run,
		parse: (value) => EvaluationRunV1Schema.parse(value),
	});
}

export async function readEvaluationRun(
	directory: string,
	runId: string,
): Promise<EvaluationRunV1 | undefined> {
	const content = await readOptional(
		swarmPath(directory, 'evolution', 'runs', `${runId}.json`),
	);
	return content === undefined
		? undefined
		: EvaluationRunV1Schema.parse(JSON.parse(content));
}

export async function savePromotionDecision(
	directory: string,
	input: PromotionDecisionV1,
): Promise<PromotionDecisionV1> {
	const decision = PromotionDecisionV1Schema.parse(input);
	const relative = path.join(
		'evolution',
		'decisions',
		`${decision.decisionId}.json`,
	);
	return writeImmutable({
		directory,
		relativeLockPath: relative,
		filePath: swarmPath(directory, relative),
		taskId: decision.runId,
		value: decision,
		parse: (value) => PromotionDecisionV1Schema.parse(value),
		isEquivalent: (existing, desired) => {
			const { decidedAt: _existingTimestamp, ...existingCore } = existing;
			const { decidedAt: _desiredTimestamp, ...desiredCore } = desired;
			return canonicalJson(existingCore) === canonicalJson(desiredCore);
		},
	});
}

export async function saveGateAuditResult(
	directory: string,
	input: GateAuditResultV1,
): Promise<GateAuditResultV1> {
	const result = GateAuditResultV1Schema.parse(input);
	const relative = path.join(
		'evidence',
		'gate-audit',
		result.runId,
		'results.json',
	);
	return writeImmutable({
		directory,
		relativeLockPath: relative,
		filePath: swarmPath(directory, relative),
		taskId: result.runId,
		value: result,
		parse: (value) => GateAuditResultV1Schema.parse(value),
	});
}

export async function saveGateAuditManifest(
	directory: string,
	input: GateAuditManifestV1,
): Promise<GateAuditManifestV1> {
	const manifest = GateAuditManifestV1Schema.parse(input);
	const relative = path.join(
		'evolution',
		'gate-audit-manifests',
		`${manifest.id}.json`,
	);
	return writeImmutable({
		directory,
		relativeLockPath: relative,
		filePath: swarmPath(directory, relative),
		taskId: manifest.id,
		value: manifest,
		parse: (value) => GateAuditManifestV1Schema.parse(value),
	});
}

export async function readGateAuditManifest(
	directory: string,
	runId: string,
): Promise<GateAuditManifestV1 | undefined> {
	const content = await readOptional(
		swarmPath(directory, 'evolution', 'gate-audit-manifests', `${runId}.json`),
	);
	return content === undefined
		? undefined
		: GateAuditManifestV1Schema.parse(JSON.parse(content));
}

export async function readGateAuditResult(
	directory: string,
	runId: string,
): Promise<GateAuditResultV1 | undefined> {
	const content = await readOptional(
		swarmPath(directory, 'evidence', 'gate-audit', runId, 'results.json'),
	);
	return content === undefined
		? undefined
		: GateAuditResultV1Schema.parse(JSON.parse(content));
}

export type GateAuditReadSummary = {
	results: GateAuditResultV1[];
	corruptRunIds: string[];
};

/** Enumerate only validated immediate gate-audit children; never recurse. */
export async function listGateAuditResults(
	directory: string,
): Promise<GateAuditReadSummary> {
	const root = swarmPath(directory, 'evidence', 'gate-audit');
	let entries: import('node:fs').Dirent[] = [];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { results: [], corruptRunIds: [] };
		}
		throw error;
	}
	const results: GateAuditResultV1[] = [];
	const corruptRunIds: string[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (
			!entry.isDirectory() ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(entry.name)
		) {
			continue;
		}
		try {
			const parsed = GateAuditResultV1Schema.parse(
				JSON.parse(
					await readFile(path.join(root, entry.name, 'results.json'), 'utf8'),
				),
			);
			if (parsed.runId !== entry.name) throw new Error('run id/path mismatch');
			results.push(parsed);
		} catch {
			corruptRunIds.push(entry.name);
		}
	}
	return { results, corruptRunIds };
}

function parseTestLedger(content: string): TestConsumptionClaimV1[] {
	return content
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line, index) => {
			try {
				return TestConsumptionClaimV1Schema.parse(JSON.parse(line));
			} catch (error) {
				throw new EvaluationConflictError(
					`test-consumption ledger is corrupt at line ${index + 1}: ${String(error)}`,
				);
			}
		});
}

export async function claimHeldOutTest(
	directory: string,
	input: TestConsumptionClaimV1,
): Promise<TestConsumptionClaimV1> {
	const claim = TestConsumptionClaimV1Schema.parse(input);
	const filePath = swarmPath(directory, TEST_LEDGER_RELATIVE);
	assertProjectRoot(directory);
	await mkdir(path.dirname(filePath), { recursive: true });
	return withEvidenceLock(
		directory,
		TEST_LEDGER_RELATIVE,
		AGENT,
		claim.runId,
		async () => {
			const content = (await readOptional(filePath)) ?? '';
			const claims = parseTestLedger(content);
			const identicalRun = claims.find((entry) => entry.runId === claim.runId);
			if (identicalRun) {
				if (
					identicalRun.taskSetHash === claim.taskSetHash &&
					identicalRun.baselineHash === claim.baselineHash &&
					identicalRun.candidateHash === claim.candidateHash
				) {
					return identicalRun;
				}
				throw new EvaluationConflictError(
					`run ${claim.runId} conflicts with its prior held-out test claim`,
				);
			}
			const prior = claims.find(
				(entry) => entry.taskSetHash === claim.taskSetHash,
			);
			if (prior) throw new TestAlreadyConsumedError(prior);
			await atomicWriteFile(
				filePath,
				`${content.replace(/\s*$/, '')}${content.trim() ? '\n' : ''}${serialized(claim)}`,
			);
			return claim;
		},
	);
}

/** Run ids that retention must preserve to keep promotion and test lineage valid. */
export async function getProtectedEvaluationRunIds(
	directory: string,
): Promise<Set<string>> {
	const protectedIds = new Set<string>();
	const ledger = await readOptional(swarmPath(directory, TEST_LEDGER_RELATIVE));
	for (const claim of parseTestLedger(ledger ?? ''))
		protectedIds.add(claim.runId);
	const decisionsDirectory = swarmPath(directory, 'evolution', 'decisions');
	let files: string[] = [];
	try {
		files = await readdir(decisionsDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	for (const filename of files
		.filter((value) => value.endsWith('.json'))
		.sort()) {
		const decision = PromotionDecisionV1Schema.parse(
			JSON.parse(
				await readFile(path.join(decisionsDirectory, filename), 'utf8'),
			),
		);
		protectedIds.add(decision.runId);
		protectedIds.add(decision.lineage.baselineRunId);
		if (decision.lineage.historicalBestRunId !== 'unavailable') {
			protectedIds.add(decision.lineage.historicalBestRunId);
		}
	}
	return protectedIds;
}
