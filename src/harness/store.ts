import { randomUUID } from 'node:crypto';
import {
	closeSync,
	existsSync,
	constants as FS_CONSTANTS,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	opendirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import {
	computeWriteApprovalHash,
	consumeWriteApprovalFact,
	findWriteApprovalFact,
	type WriteApprovalRequest,
} from '../security/write-authority.js';
import { atomicWriteSwarmFile } from '../utils/atomic-write.js';
import { assertProjectRoot } from '../utils/project-boundary.js';
import {
	type BlueprintPatchV1,
	type HarnessBlueprintV1,
	type PromptArtifactV1,
	parseBlueprintPatch,
	parseHarnessBlueprint,
	parseHarnessCandidateManifest,
	parsePromptArtifact,
} from './contracts.js';
import { canonicalJson, sha256 } from './hash.js';
import { applyBlueprintPatch } from './patch.js';

const MAX_ORPHAN_ARTIFACTS = 16;
const MAX_ORPHAN_BYTES = 8 * 1024 * 1024;
const MAX_ORPHAN_SCAN = 128;
const MAX_CANDIDATE_ARTIFACT_BYTES = 8 * 1024 * 1024;

import type { HarnessSourceCandidateV1 } from './source-candidate.js';

const STORE_VERSION = 1 as const;
const LEDGER_SEGMENT_MAX_BYTES = 256 * 1024;
const LEDGER_RECORD_MAX_BYTES = 16 * 1024;
const DEFAULT_MAX_REPLAY_RECORDS = 10_000;
const LOCK_RETRY = { retries: 5, minTimeout: 10, maxTimeout: 100 } as const;
const ROOT_RELATIVE_PATH = path.join('evolution', 'harness');
const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const RECOVERY_CANDIDATE_ID = 'system.recovered-tail';
const COMPACTED_CANDIDATE_ID = 'system.compacted-head';
const LEDGER_GENERATION_DIR_RE = /^generation-[a-f0-9]{32}$/;

type LockRelease = () => Promise<void>;

type FileIdentity = {
	dev: number;
	ino: number;
	size: number;
};

type TornTailRecoveryInfo = {
	segmentPath: string;
	segmentName: string;
	retainedBytes: number;
	discardedBytes: number;
	discardedHash: string;
};

type LedgerScanResult = {
	records: HarnessLedgerRecordV1[];
	truncated: boolean;
	quarantinePath: string | null;
	totalSegments: number;
	tornTail: TornTailRecoveryInfo | null;
};

type RetainedCandidateBinding = {
	candidateId: string;
	manifestHash: string;
};

type LedgerGenerationPointerV1 = {
	v: 1;
	generationDir: string;
};

export interface StoredHarnessCandidateV1 {
	v: 1;
	candidate: HarnessSourceCandidateV1;
	promptArtifacts?: PromptArtifactV1[];
	baseBlueprint?: HarnessBlueprintV1;
	targetBlueprint?: HarnessBlueprintV1;
	blueprintPatch?: BlueprintPatchV1;
	recordedAt: string;
}

export interface HarnessVersionV1 {
	v: 1;
	versionId: string;
	candidateId: string;
	manifestHash: string;
	allowedPathDigest: string;
	generation: number;
	sourceKind: 'activation' | 'rollback';
	parentVersionId: string | null;
	restoredFromVersionId: string | null;
	approvalFactId: string;
	blueprint?: HarnessBlueprintV1;
	recordedAt: string;
}

export interface HarnessCurrentProjectionV1 {
	v: 1;
	currentVersionId: string | null;
	currentCandidateId: string | null;
	currentManifestHash: string | null;
	currentHash: string;
	generation: number;
	versionIds: string[];
	updatedAt: string;
	ledgerHeadSegment: string | null;
	ledgerHeadSeq: number;
	ledgerHeadHash: string;
}

export interface HarnessLedgerRecordV1 {
	v: 1;
	seq: number;
	timestamp: string;
	kind:
		| 'candidate_recorded'
		| 'activated'
		| 'rolled_back'
		| 'recovered_tail'
		| 'compacted';
	candidateId: string;
	versionId: string | null;
	parentVersionId: string | null;
	restoredFromVersionId: string | null;
	approvalFactId: string | null;
	payloadHash: string;
	generation: number;
	currentHashBefore: string;
	currentHashAfter: string;
	nextCurrentVersionId: string | null;
	nextCurrentCandidateId: string | null;
	nextCurrentManifestHash: string | null;
	nextVersionIds: string[];
	nextUpdatedAt: string;
	ledgerSegment: string;
	prunedVersionIds: string[];
	recoverySegment: string | null;
	recoveredBytes: number | null;
	retainedCandidates: RetainedCandidateBinding[];
	compactedRecords: number | null;
	hashBefore: string;
	hashAfter: string;
}

export type RecordHarnessCandidateResult =
	| {
			status: 'recorded';
			candidate: StoredHarnessCandidateV1;
			retentionReconciled: boolean;
			retentionFailures: string[];
	  }
	| { status: 'conflict'; reason: string };

export type ActivateHarnessCandidateResult =
	| {
			status: 'activated';
			version: HarnessVersionV1;
			current: HarnessCurrentProjectionV1;
			projectionReconciled: boolean;
			prunedArtifactsReconciled: boolean;
			prunedArtifactFailures: string[];
			retentionReconciled: boolean;
			retentionFailures: string[];
	  }
	| { status: 'candidate_not_found'; reason: string }
	| { status: 'candidate_not_activatable'; reason: string }
	| { status: 'consumer_mismatch'; reason: string }
	| { status: 'approval_required'; reason: string }
	| {
			status: 'retention_conflict';
			reason: string;
			maxVersions: number;
			requiredVersionIds: string[];
	  }
	| { status: 'stale_current'; reason: string };

export type RollbackHarnessVersionResult =
	| {
			status: 'rolled_back';
			version: HarnessVersionV1;
			current: HarnessCurrentProjectionV1;
			projectionReconciled: boolean;
			prunedArtifactsReconciled: boolean;
			prunedArtifactFailures: string[];
			retentionReconciled: boolean;
			retentionFailures: string[];
	  }
	| { status: 'version_not_found'; reason: string }
	| { status: 'consumer_mismatch'; reason: string }
	| { status: 'approval_required'; reason: string }
	| {
			status: 'retention_conflict';
			reason: string;
			maxVersions: number;
			requiredVersionIds: string[];
	  }
	| { status: 'stale_current'; reason: string };

export type SaveHarnessVersionResult =
	| { status: 'saved'; version: HarnessVersionV1 }
	| { status: 'conflict'; reason: string };

export interface HarnessHistoryResult {
	records: HarnessLedgerRecordV1[];
	truncated: boolean;
	quarantinePath: string | null;
	totalRecordCount: number;
	limit: number;
	totalSegments: number;
}

export type HarnessLedgerAuditResult =
	| {
			outcome: 'ok';
			records: HarnessLedgerRecordV1[];
			truncated: boolean;
			quarantinePath: string | null;
			totalSegments: number;
	  }
	| {
			outcome: 'scope_exceeded';
			maxSegments: number;
			totalSegments: number;
			replayBoundExceeded?: true;
			maxReplayRecords?: number;
	  };

export class HarnessStoreIntegrityError extends Error {
	readonly code = 'HARNESS_STORE_INTEGRITY';
	constructor(
		readonly artifactPath: string,
		message: string,
	) {
		super(`${message}: ${artifactPath}`);
		this.name = 'HarnessStoreIntegrityError';
	}
}

const stableJson = canonicalJson;

export class HarnessReplayBoundExceededError extends Error {
	readonly code = 'HARNESS_REPLAY_BOUND_EXCEEDED';
	constructor(readonly maxReplayRecords: number) {
		super(`harness ledger exceeds replay bound ${maxReplayRecords}`);
		this.name = 'HarnessReplayBoundExceededError';
	}
}

type RetainedVersionSelectionResult =
	| { status: 'ok'; versionIds: string[] }
	| {
			status: 'retention_conflict';
			reason: string;
			maxVersions: number;
			requiredVersionIds: string[];
	  };

type RequiredSeedVersionIdsResult =
	| { status: 'ok'; requiredVersionIds: string[] }
	| { status: 'overflow'; requiredVersionIds: string[] };

function resolveReplayBound(maxReplayRecords?: number): number {
	return maxReplayRecords ?? DEFAULT_MAX_REPLAY_RECORDS;
}

function throwReplayBoundExceeded(maxReplayRecords?: number): never {
	throw new HarnessReplayBoundExceededError(
		resolveReplayBound(maxReplayRecords),
	);
}

function rootDir(directory: string): string {
	return path.join(directory, '.swarm', ROOT_RELATIVE_PATH);
}

function candidatesDir(directory: string): string {
	return path.join(rootDir(directory), 'candidates');
}

function versionsDir(directory: string): string {
	return path.join(rootDir(directory), 'versions');
}

function ledgerDir(directory: string): string {
	return path.join(rootDir(directory), 'ledger');
}

function ledgerPointerPath(directory: string): string {
	return path.join(ledgerDir(directory), 'active-generation.json');
}

function currentPath(directory: string): string {
	return path.join(rootDir(directory), 'current.json');
}

function candidatePath(directory: string, candidateId: string): string {
	if (!ARTIFACT_ID_RE.test(candidateId))
		throw new Error('invalid harness candidate id');
	return path.join(candidatesDir(directory), candidateId, 'record.json');
}

function candidateDir(directory: string, candidateId: string): string {
	if (!ARTIFACT_ID_RE.test(candidateId))
		throw new Error('invalid harness candidate id');
	return path.join(candidatesDir(directory), candidateId);
}

function candidatePromptDir(directory: string, candidateId: string): string {
	if (!ARTIFACT_ID_RE.test(candidateId))
		throw new Error('invalid harness candidate id');
	return path.join(candidatesDir(directory), candidateId, 'prompts');
}

function candidatePromptPath(
	directory: string,
	candidateId: string,
	promptHash: string,
): string {
	return path.join(
		candidatePromptDir(directory, candidateId),
		`${promptHash}.json`,
	);
}

function versionPath(directory: string, versionId: string): string {
	if (!ARTIFACT_ID_RE.test(versionId))
		throw new Error('invalid harness version id');
	return path.join(versionsDir(directory), `${versionId}.json`);
}

function parseLedgerGenerationPointer(
	value: unknown,
	artifactPath: string,
): LedgerGenerationPointerV1 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness ledger generation pointer',
		);
	}
	const record = value as Record<string, unknown>;
	if (
		record.v !== 1 ||
		typeof record.generationDir !== 'string' ||
		!LEDGER_GENERATION_DIR_RE.test(record.generationDir) ||
		Object.keys(record).some((key) => !['v', 'generationDir'].includes(key))
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness ledger generation pointer',
		);
	}
	return record as LedgerGenerationPointerV1;
}

function activeLedgerDir(directory: string): string {
	const pointerValue = readJsonFile<Record<string, unknown>>(
		ledgerPointerPath(directory),
	);
	if (!pointerValue) return ledgerDir(directory);
	const pointer = parseLedgerGenerationPointer(
		pointerValue,
		ledgerPointerPath(directory),
	);
	const target = path.join(ledgerDir(directory), pointer.generationDir);
	if (!existsSync(target)) {
		throw new HarnessStoreIntegrityError(
			target,
			'harness active ledger generation is missing',
		);
	}
	return target;
}

function hasLedgerGenerationPointer(directory: string): boolean {
	return existsSync(ledgerPointerPath(directory));
}

function ensureStoreDirectories(directory: string): void {
	mkdirSync(candidatesDir(directory), { recursive: true });
	mkdirSync(versionsDir(directory), { recursive: true });
	mkdirSync(ledgerDir(directory), { recursive: true });
}

function computeCurrentHash(input: {
	currentVersionId: string | null;
	currentCandidateId: string | null;
	currentManifestHash: string | null;
	generation: number;
	versionIds: string[];
}): string {
	return sha256(
		stableJson({
			currentVersionId: input.currentVersionId,
			currentCandidateId: input.currentCandidateId,
			currentManifestHash: input.currentManifestHash,
			generation: input.generation,
			versionIds: input.versionIds,
		}),
	);
}

function buildCurrentProjection(
	currentVersionId: string | null,
	currentCandidateId: string | null,
	currentManifestHash: string | null,
	generation: number,
	versionIds: string[],
	updatedAt: string,
	ledgerHeadSegment: string | null = null,
	ledgerHeadSeq = 0,
	ledgerHeadHash = sha256('null'),
): HarnessCurrentProjectionV1 {
	return {
		v: STORE_VERSION,
		currentVersionId,
		currentCandidateId,
		currentManifestHash,
		currentHash: computeCurrentHash({
			currentVersionId,
			currentCandidateId,
			currentManifestHash,
			generation,
			versionIds,
		}),
		generation,
		versionIds,
		updatedAt,
		ledgerHeadSegment,
		ledgerHeadSeq,
		ledgerHeadHash,
	};
}

function readJsonFile<T>(filePath: string): T | null {
	if (!existsSync(filePath)) return null;
	try {
		if (statSync(filePath).size > MAX_CANDIDATE_ARTIFACT_BYTES) {
			throw new Error('artifact exceeds byte bound');
		}
		return JSON.parse(readFileSync(filePath, 'utf8')) as T;
	} catch {
		throw new HarnessStoreIntegrityError(filePath, 'malformed harness JSON');
	}
}

function parseStoredCurrentProjection(
	value: unknown,
	artifactPath: string,
): HarnessCurrentProjectionV1 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness current projection',
		);
	}
	const record = value as Record<string, unknown>;
	const keys = [
		'v',
		'currentVersionId',
		'currentCandidateId',
		'currentManifestHash',
		'currentHash',
		'generation',
		'versionIds',
		'updatedAt',
		'ledgerHeadSegment',
		'ledgerHeadSeq',
		'ledgerHeadHash',
	];
	const isIdOrNull = (entry: unknown) =>
		entry === null || (typeof entry === 'string' && ARTIFACT_ID_RE.test(entry));
	const isHashOrNull = (entry: unknown) =>
		entry === null ||
		(typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry));
	if (
		Object.keys(record).some((key) => !keys.includes(key)) ||
		Object.keys(record).length !== keys.length ||
		record.v !== 1 ||
		!isIdOrNull(record.currentVersionId) ||
		!isIdOrNull(record.currentCandidateId) ||
		!isHashOrNull(record.currentManifestHash) ||
		typeof record.currentHash !== 'string' ||
		!/^[a-f0-9]{64}$/.test(record.currentHash) ||
		!Number.isSafeInteger(record.generation) ||
		(record.generation as number) < 0 ||
		!Array.isArray(record.versionIds) ||
		record.versionIds.some(
			(id) => typeof id !== 'string' || !ARTIFACT_ID_RE.test(id),
		) ||
		new Set(record.versionIds).size !== record.versionIds.length ||
		typeof record.updatedAt !== 'string' ||
		(record.ledgerHeadSegment !== null &&
			(typeof record.ledgerHeadSegment !== 'string' ||
				!/^\d{6}\.jsonl$/.test(record.ledgerHeadSegment))) ||
		!Number.isSafeInteger(record.ledgerHeadSeq) ||
		(record.ledgerHeadSeq as number) < 0 ||
		typeof record.ledgerHeadHash !== 'string' ||
		!/^[a-f0-9]{64}$/.test(record.ledgerHeadHash)
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness current projection',
		);
	}
	const parsed = record as unknown as HarnessCurrentProjectionV1;
	if (
		(parsed.currentVersionId === null) !==
			(parsed.currentCandidateId === null ||
				parsed.currentManifestHash === null) ||
		(parsed.currentVersionId !== null &&
			(parsed.currentCandidateId === null ||
				parsed.currentManifestHash === null))
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness current projection linkage',
		);
	}
	if (
		(parsed.ledgerHeadSeq === 0 &&
			(parsed.ledgerHeadSegment !== null ||
				parsed.ledgerHeadHash !== sha256('null'))) ||
		(parsed.ledgerHeadSeq > 0 && parsed.ledgerHeadSegment === null)
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness current projection head pointer',
		);
	}
	if (
		computeCurrentHash({
			currentVersionId: parsed.currentVersionId,
			currentCandidateId: parsed.currentCandidateId,
			currentManifestHash: parsed.currentManifestHash,
			generation: parsed.generation,
			versionIds: parsed.versionIds,
		}) !== parsed.currentHash
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness current projection hash',
		);
	}
	return parsed;
}

function readStoredCurrentProjection(
	directory: string,
): HarnessCurrentProjectionV1 | null {
	try {
		const value = readJsonFile<Record<string, unknown>>(currentPath(directory));
		if (!value) return null;
		return parseStoredCurrentProjection(value, currentPath(directory));
	} catch {
		return null;
	}
}

function readStoredPromptArtifact(
	directory: string,
	candidateId: string,
	promptHash: string,
): PromptArtifactV1 | null {
	const value = readJsonFile<Record<string, unknown>>(
		candidatePromptPath(directory, candidateId, promptHash),
	);
	if (!value) return null;
	try {
		const artifact = parsePromptArtifact(value);
		if (
			artifact.candidateId !== candidateId ||
			artifact.sha256 !== promptHash
		) {
			throw new Error('candidate prompt artifact identity mismatch');
		}
		return artifact;
	} catch {
		throw new HarnessStoreIntegrityError(
			candidatePromptPath(directory, candidateId, promptHash),
			'invalid harness prompt artifact',
		);
	}
}

function readStoredCandidate(
	directory: string,
	candidateId: string,
): StoredHarnessCandidateV1 | null {
	const filePath = candidatePath(directory, candidateId);
	const value = readJsonFile<Record<string, unknown>>(filePath);
	if (!value) return null;
	try {
		if (value.v !== 1 || typeof value.recordedAt !== 'string')
			throw new Error('bad envelope');
		if (
			Object.keys(value).some(
				(key) =>
					![
						'v',
						'candidate',
						'promptArtifacts',
						'recordedAt',
						'baseBlueprint',
						'targetBlueprint',
						'blueprintPatch',
					].includes(key),
			)
		)
			throw new Error('unknown envelope field');
		const rawCandidate = value.candidate as { patch?: unknown };
		if (
			rawCandidate?.patch !== undefined &&
			typeof rawCandidate.patch !== 'string'
		)
			throw new Error('patch must be a string');
		const { patch: _patch, ...manifestValue } = rawCandidate;
		const candidate = parseHarnessCandidateManifest(manifestValue);
		const promptArtifacts =
			candidate.promptArtifactHashes.length === 0
				? []
				: candidate.promptArtifactHashes.map((promptHash) => {
						const artifact = readStoredPromptArtifact(
							directory,
							candidate.candidateId,
							promptHash,
						);
						if (artifact) return artifact;
						throw new HarnessStoreIntegrityError(
							candidatePromptPath(directory, candidate.candidateId, promptHash),
							'missing harness prompt artifact declared by candidate manifest',
						);
					});
		const record: StoredHarnessCandidateV1 = {
			v: 1,
			candidate: {
				...candidate,
				...(rawCandidate?.patch !== undefined
					? { patch: String(rawCandidate.patch) }
					: {}),
			},
			...(promptArtifacts.length > 0 ? { promptArtifacts } : {}),
			recordedAt: value.recordedAt,
			...(value.baseBlueprint
				? { baseBlueprint: parseHarnessBlueprint(value.baseBlueprint) }
				: {}),
			...(value.targetBlueprint
				? { targetBlueprint: parseHarnessBlueprint(value.targetBlueprint) }
				: {}),
			...(value.blueprintPatch
				? { blueprintPatch: parseBlueprintPatch(value.blueprintPatch) }
				: {}),
		};
		assertCandidateCoherence(record, filePath);
		return record;
	} catch {
		throw new HarnessStoreIntegrityError(
			filePath,
			'invalid harness candidate record',
		);
	}
}

function assertCandidateCoherence(
	record: StoredHarnessCandidateV1,
	artifactPath: string,
): void {
	if (
		record.candidate.patch !== undefined &&
		sha256(record.candidate.patch) !== record.candidate.patchSha256
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'candidate source patch hash mismatch',
		);
	}
	const blueprintParts = [
		record.baseBlueprint,
		record.targetBlueprint,
		record.blueprintPatch,
	].filter((value) => value !== undefined).length;
	if (blueprintParts !== 0 && blueprintParts !== 3) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'candidate blueprint base, patch, and target must be supplied together',
		);
	}
	if (record.baseBlueprint && record.targetBlueprint && record.blueprintPatch) {
		let applied: HarnessBlueprintV1;
		try {
			applied = applyBlueprintPatch(
				record.baseBlueprint,
				record.blueprintPatch,
			);
		} catch {
			throw new HarnessStoreIntegrityError(
				artifactPath,
				'candidate blueprint patch is incoherent',
			);
		}
		if (applied.contentHash !== record.targetBlueprint.contentHash) {
			throw new HarnessStoreIntegrityError(
				artifactPath,
				'candidate target blueprint hash mismatch',
			);
		}
	}
	const promptArtifacts = record.promptArtifacts ?? [];
	if (promptArtifacts.length !== record.candidate.promptArtifactHashes.length) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'candidate prompt artifact set does not match the manifest declaration',
		);
	}
	const declaredPromptHashes = [
		...record.candidate.promptArtifactHashes,
	].sort();
	const actualPromptHashes = promptArtifacts
		.map((artifact) => {
			if (artifact.candidateId !== record.candidate.candidateId) {
				throw new HarnessStoreIntegrityError(
					artifactPath,
					'candidate prompt artifact belongs to a different candidate',
				);
			}
			return artifact.sha256;
		})
		.sort();
	if (stableJson(declaredPromptHashes) !== stableJson(actualPromptHashes)) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'candidate prompt artifact hashes do not match the manifest declaration',
		);
	}
	if (record.targetBlueprint) {
		const candidateBindings = record.targetBlueprint.agents
			.map((agent) => agent.prompt)
			.filter((prompt) => prompt.ref.startsWith('candidate:'));
		for (const binding of candidateBindings) {
			const [kind, candidateId, promptHash] = binding.ref.split(':');
			if (kind !== 'candidate') {
				throw new HarnessStoreIntegrityError(
					artifactPath,
					'invalid candidate prompt binding kind',
				);
			}
			if (
				candidateId !== record.candidate.candidateId ||
				!record.candidate.promptArtifactHashes.includes(promptHash!)
			) {
				throw new HarnessStoreIntegrityError(
					artifactPath,
					'candidate blueprint prompt binding is not backed by a declared prompt artifact',
				);
			}
			const artifact = promptArtifacts.find(
				(item) =>
					item.promptId === binding.promptId && item.sha256 === binding.sha256,
			);
			if (!artifact) {
				throw new HarnessStoreIntegrityError(
					artifactPath,
					'candidate blueprint prompt binding is missing its prompt artifact',
				);
			}
		}
	}
}

function readStoredVersion(filePath: string): HarnessVersionV1 | null {
	const value = readJsonFile<HarnessVersionV1>(filePath);
	if (!value) return null;
	if (
		Object.keys(value).some(
			(key) =>
				![
					'v',
					'versionId',
					'candidateId',
					'manifestHash',
					'allowedPathDigest',
					'generation',
					'sourceKind',
					'parentVersionId',
					'restoredFromVersionId',
					'approvalFactId',
					'blueprint',
					'recordedAt',
				].includes(key),
		) ||
		value.v !== 1 ||
		typeof value.versionId !== 'string' ||
		typeof value.candidateId !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.manifestHash) ||
		!/^[a-f0-9]{64}$/.test(value.allowedPathDigest) ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 1 ||
		!['activation', 'rollback'].includes(value.sourceKind) ||
		(value.parentVersionId !== null &&
			typeof value.parentVersionId !== 'string') ||
		(value.restoredFromVersionId !== null &&
			typeof value.restoredFromVersionId !== 'string') ||
		typeof value.approvalFactId !== 'string' ||
		typeof value.recordedAt !== 'string'
	) {
		throw new HarnessStoreIntegrityError(
			filePath,
			'invalid harness version record',
		);
	}
	try {
		if (
			value.parentVersionId === value.versionId ||
			value.restoredFromVersionId === value.versionId ||
			(value.sourceKind === 'activation' &&
				value.restoredFromVersionId !== null) ||
			(value.sourceKind === 'rollback' &&
				(value.parentVersionId === null ||
					value.restoredFromVersionId === null))
		) {
			throw new Error('invalid harness version source linkage');
		}
		return {
			...value,
			...(value.blueprint
				? { blueprint: parseHarnessBlueprint(value.blueprint) }
				: {}),
		};
	} catch {
		throw new HarnessStoreIntegrityError(
			filePath,
			'invalid harness version blueprint',
		);
	}
}

function serializeVersionRecord(version: HarnessVersionV1): string {
	return `${JSON.stringify(version, null, 2)}\n`;
}

async function saveHarnessVersionUnderLock(
	directory: string,
	version: HarnessVersionV1,
): Promise<SaveHarnessVersionResult> {
	const target = versionPath(directory, version.versionId);
	const existing = readStoredVersion(target);
	if (existing) {
		if (stableJson(existing) !== stableJson(version)) {
			return {
				status: 'conflict',
				reason: 'version id already exists with different content',
			};
		}
		return { status: 'saved', version: existing };
	}
	const serialized = serializeVersionRecord(version);
	if (Buffer.byteLength(serialized, 'utf8') > MAX_CANDIDATE_ARTIFACT_BYTES) {
		throw new HarnessStoreIntegrityError(
			target,
			'version artifact exceeds byte bound',
		);
	}
	mkdirSync(path.dirname(target), { recursive: true });
	await atomicWriteSwarmFile(target, serialized);
	return {
		status: 'saved',
		version,
	};
}

function normalizeAllowedPaths(paths: readonly string[]): string[] {
	return [...new Set(paths.map((entry) => entry.replace(/\\/g, '/').trim()))]
		.filter((entry) => entry.length > 0)
		.sort();
}

function computeAllowedPathDigest(paths: readonly string[]): string {
	return computeWriteApprovalHash({
		allowedPaths: normalizeAllowedPaths(paths),
	});
}

function serializeCandidateRecord(candidate: StoredHarnessCandidateV1): string {
	const serializable = {
		v: candidate.v,
		candidate: candidate.candidate,
		recordedAt: candidate.recordedAt,
		...(candidate.baseBlueprint
			? { baseBlueprint: candidate.baseBlueprint }
			: {}),
		...(candidate.targetBlueprint
			? { targetBlueprint: candidate.targetBlueprint }
			: {}),
		...(candidate.blueprintPatch
			? { blueprintPatch: candidate.blueprintPatch }
			: {}),
	};
	return `${JSON.stringify(serializable, null, 2)}\n`;
}

async function writePromptArtifacts(
	directory: string,
	candidate: StoredHarnessCandidateV1,
): Promise<void> {
	const promptArtifacts = candidate.promptArtifacts ?? [];
	if (promptArtifacts.length === 0) return;
	mkdirSync(candidatePromptDir(directory, candidate.candidate.candidateId), {
		recursive: true,
	});
	for (const artifact of promptArtifacts) {
		await atomicWriteSwarmFile(
			candidatePromptPath(
				directory,
				candidate.candidate.candidateId,
				artifact.sha256,
			),
			`${JSON.stringify(artifact, null, 2)}\n`,
		);
	}
}

function segmentName(index: number): string {
	return `${String(index).padStart(6, '0')}.jsonl`;
}

function parseSegmentIndex(name: string): number {
	if (!/^\d{6}\.jsonl$/.test(name)) {
		throw new HarnessStoreIntegrityError(
			name,
			'invalid harness ledger segment name',
		);
	}
	return Number.parseInt(name.slice(0, 6), 10);
}

function buildEmptyCurrentProjection(): HarnessCurrentProjectionV1 {
	return buildCurrentProjection(
		null,
		null,
		null,
		0,
		[],
		'1970-01-01T00:00:00.000Z',
	);
}

function buildCurrentProjectionFromRecord(
	record: HarnessLedgerRecordV1,
): HarnessCurrentProjectionV1 {
	return buildCurrentProjection(
		record.nextCurrentVersionId,
		record.nextCurrentCandidateId,
		record.nextCurrentManifestHash,
		record.generation,
		record.nextVersionIds,
		record.nextUpdatedAt,
		record.ledgerSegment,
		record.seq,
		record.hashAfter,
	);
}

function isCompactionRecord(
	record: HarnessLedgerRecordV1,
): record is HarnessLedgerRecordV1 & {
	kind: 'compacted';
	retainedCandidates: RetainedCandidateBinding[];
	compactedRecords: number;
} {
	return record.kind === 'compacted';
}

function listSegmentPaths(directory: string): string[] {
	const activeDir = activeLedgerDir(directory);
	if (!existsSync(activeDir)) return [];
	const segments = readDirFiles(activeDir)
		.filter((name) => /^\d{6}\.jsonl$/.test(name))
		.sort();
	for (let index = 0; index < segments.length; index++) {
		if (segments[index] !== segmentName(index + 1)) {
			throw new HarnessStoreIntegrityError(
				activeDir,
				`harness ledger segment gap before ${segments[index]}`,
			);
		}
	}
	return segments.map((name) => path.join(activeDir, name));
}

function countLedgerSegments(
	directory: string,
	maxSegments?: number,
): { count: number; exceeded: boolean } {
	const activeDir = activeLedgerDir(directory);
	const entries = readDirFiles(
		activeDir,
		maxSegments === undefined ? MAX_ORPHAN_SCAN : maxSegments + 1,
	)
		.filter((name) => /^\d{6}\.jsonl$/.test(name))
		.sort();
	if (maxSegments !== undefined && entries.length > maxSegments) {
		return { count: entries.length, exceeded: true };
	}
	for (let index = 0; index < entries.length; index++) {
		if (entries[index] !== segmentName(index + 1)) {
			throw new HarnessStoreIntegrityError(
				activeDir,
				`harness ledger segment gap before ${entries[index]}`,
			);
		}
	}
	return { count: entries.length, exceeded: false };
}

function readDirFiles(
	directory: string,
	maxEntries = MAX_ORPHAN_SCAN,
): string[] {
	let handle: ReturnType<typeof opendirSync> | undefined;
	let result: string[] | undefined;
	let failure: unknown;
	try {
		handle = opendirSync(directory);
		const names: string[] = [];
		while (names.length <= maxEntries) {
			const entry = handle.readSync();
			if (!entry) break;
			names.push(entry.name);
		}
		if (names.length > maxEntries) {
			throw new HarnessStoreIntegrityError(
				directory,
				`directory scan exceeds bound ${maxEntries}`,
			);
		}
		result = names;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') result = [];
		else failure = error;
	} finally {
		try {
			handle?.closeSync();
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED' &&
				failure === undefined
			)
				failure = error;
		}
	}
	if (failure !== undefined) throw failure;
	return result ?? [];
}

function readFileIdentity(filePath: string): FileIdentity {
	const stat = statSync(filePath);
	if (!stat.isFile()) {
		throw new HarnessStoreIntegrityError(
			filePath,
			'harness ledger segment must be a regular file',
		);
	}
	return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function verifySegmentShape(filePath: string, identity: FileIdentity): void {
	if (identity.size > LEDGER_SEGMENT_MAX_BYTES) {
		throw new HarnessStoreIntegrityError(
			filePath,
			`harness ledger segment exceeds ${LEDGER_SEGMENT_MAX_BYTES} bytes`,
		);
	}
}

function fsyncParentDirectoryStrict(parent: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(parent, 'r');
		fsyncSync(fd);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (
			process.platform === 'win32' &&
			(code === 'EISDIR' || code === 'EPERM' || code === 'EACCES')
		) {
			return;
		}
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function pruneOrphanArtifacts(directory: string): void {
	const files = readDirFiles(directory, MAX_ORPHAN_ARTIFACTS + 1).sort();
	let retainedBytes = 0;
	let retainedCount = 0;
	for (const name of files.reverse()) {
		const target = path.join(directory, name);
		let bytes = MAX_ORPHAN_BYTES + 1;
		let isDirectory = false;
		try {
			const stat = statSync(target);
			bytes = stat.size;
			isDirectory = stat.isDirectory();
		} catch {
			// Treat unreadable artifacts as over budget and remove them.
		}
		if (
			retainedCount < MAX_ORPHAN_ARTIFACTS &&
			retainedBytes + bytes <= MAX_ORPHAN_BYTES
		) {
			retainedCount++;
			retainedBytes += bytes;
			continue;
		}
		try {
			if (isDirectory) rmSync(target, { recursive: true, force: true });
			else unlinkSync(target);
		} catch {
			// Best-effort cleanup; the mutation remains fail-closed.
		}
	}
}

function quarantineOrphanVersionsByIdSet(
	directory: string,
	committedVersionIds: ReadonlySet<string>,
): void {
	const versionFiles = readDirFiles(versionsDir(directory));
	for (const name of versionFiles) {
		if (!name.endsWith('.json')) continue;
		const versionId = name.slice(0, -'.json'.length);
		if (committedVersionIds.has(versionId)) continue;
		const quarantineDir = path.join(rootDir(directory), 'orphaned-versions');
		mkdirSync(quarantineDir, { recursive: true });
		try {
			renameSync(
				path.join(versionsDir(directory), name),
				path.join(quarantineDir, `${name}.${Date.now()}.orphan`),
			);
			pruneOrphanArtifacts(quarantineDir);
		} catch {
			throw new HarnessStoreIntegrityError(
				path.join(versionsDir(directory), name),
				'failed to quarantine uncommitted harness version',
			);
		}
	}
}

function nextSegmentPath(directory: string): string {
	const segments = listSegmentPaths(directory);
	if (segments.length === 0)
		return path.join(activeLedgerDir(directory), segmentName(1));
	const last = path.basename(segments[segments.length - 1]!);
	const parsed = Number.parseInt(last.slice(0, 6), 10);
	return path.join(activeLedgerDir(directory), segmentName(parsed + 1));
}

function appendLedgerBuffer(
	target: string,
	buffer: Buffer,
	mode: 'append' | 'create',
): void {
	const expectedBefore = existsSync(target) ? readFileIdentity(target) : null;
	const flags =
		mode === 'create'
			? FS_CONSTANTS.O_APPEND |
				FS_CONSTANTS.O_CREAT |
				FS_CONSTANTS.O_EXCL |
				FS_CONSTANTS.O_WRONLY
			: FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_WRONLY;
	const fd = openSync(target, flags, 0o600);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile()) {
			throw new HarnessStoreIntegrityError(
				target,
				'harness ledger segment must be a regular file',
			);
		}
		const openedIdentity: FileIdentity = {
			dev: opened.dev,
			ino: opened.ino,
			size: opened.size,
		};
		if (expectedBefore) {
			if (!sameFileIdentity(expectedBefore, openedIdentity)) {
				throw new HarnessStoreIntegrityError(
					target,
					'harness ledger segment identity changed before append',
				);
			}
			if (expectedBefore.size !== openedIdentity.size) {
				throw new HarnessStoreIntegrityError(
					target,
					'harness ledger segment size changed before append',
				);
			}
		} else if (mode === 'append' && openedIdentity.size !== 0) {
			throw new HarnessStoreIntegrityError(
				target,
				'harness ledger segment appeared during append',
			);
		}
		verifySegmentShape(target, openedIdentity);
		let written = 0;
		while (written < buffer.byteLength) {
			written += writeSync(fd, buffer, written, buffer.byteLength - written);
		}
		fsyncSync(fd);
		const after = readFileIdentity(target);
		if (!sameFileIdentity(openedIdentity, after)) {
			throw new HarnessStoreIntegrityError(
				target,
				'harness ledger segment identity changed after append',
			);
		}
		if (after.size !== openedIdentity.size + buffer.byteLength) {
			throw new HarnessStoreIntegrityError(
				target,
				'harness ledger segment size mismatch after append',
			);
		}
		verifySegmentShape(target, after);
		if (mode === 'create') {
			fsyncParentDirectoryStrict(path.dirname(target));
		}
	} finally {
		closeSync(fd);
	}
}

function appendLedgerLine(
	directory: string,
	line: string,
	expectedSegmentName?: string,
): void {
	const bytes = Buffer.byteLength(line, 'utf8');
	if (bytes > LEDGER_RECORD_MAX_BYTES) {
		throw new Error(
			`harness ledger record exceeds ${LEDGER_RECORD_MAX_BYTES} bytes`,
		);
	}
	const buffer = Buffer.from(line, 'utf8');
	if (expectedSegmentName) {
		const target = path.join(activeLedgerDir(directory), expectedSegmentName);
		appendLedgerBuffer(
			target,
			buffer,
			existsSync(target) ? 'append' : 'create',
		);
		return;
	}
	const target = listSegmentPaths(directory).at(-1);
	if (!target) {
		appendLedgerBuffer(
			path.join(activeLedgerDir(directory), segmentName(1)),
			buffer,
			'create',
		);
		return;
	}
	const identity = readFileIdentity(target);
	verifySegmentShape(target, identity);
	if (identity.size + bytes <= LEDGER_SEGMENT_MAX_BYTES) {
		appendLedgerBuffer(target, buffer, 'append');
		return;
	}
	appendLedgerBuffer(nextSegmentPath(directory), buffer, 'create');
}

function appendLedgerRecordWithCommitRecovery(
	directory: string,
	record: HarnessLedgerRecordV1,
	maxReplayRecords?: number,
): void {
	try {
		_storeInternals.appendLedgerLine(
			directory,
			`${JSON.stringify(record)}\n`,
			record.ledgerSegment,
		);
	} catch (error) {
		try {
			const committed = readVerifiedLedgerRecords(
				directory,
				maxReplayRecords,
			).records.some((item) => item.hashAfter === record.hashAfter);
			if (committed) return;
		} catch (verificationError) {
			if (verificationError instanceof HarnessReplayBoundExceededError) {
				throw verificationError;
			}
			// Preserve the original append error when commitment cannot be proven.
		}
		throw error;
	}
}

function computeLedgerRecordHash(
	record: Omit<HarnessLedgerRecordV1, 'hashAfter'>,
): string {
	return sha256(stableJson(record));
}

function parseLedgerRecord(
	value: unknown,
	artifactPath: string,
): HarnessLedgerRecordV1 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness ledger record',
		);
	}
	const rawRecord = value as Record<string, unknown>;
	const record: Record<string, unknown> = {
		retainedCandidates: [],
		compactedRecords: null,
		...rawRecord,
	};
	const keys = [
		'v',
		'seq',
		'timestamp',
		'kind',
		'candidateId',
		'versionId',
		'parentVersionId',
		'restoredFromVersionId',
		'approvalFactId',
		'payloadHash',
		'generation',
		'currentHashBefore',
		'currentHashAfter',
		'nextCurrentVersionId',
		'nextCurrentCandidateId',
		'nextCurrentManifestHash',
		'nextVersionIds',
		'nextUpdatedAt',
		'ledgerSegment',
		'prunedVersionIds',
		'recoverySegment',
		'recoveredBytes',
		'retainedCandidates',
		'compactedRecords',
		'hashBefore',
		'hashAfter',
	];
	const isIdOrNull = (entry: unknown) =>
		entry === null || (typeof entry === 'string' && ARTIFACT_ID_RE.test(entry));
	const isHash = (entry: unknown) =>
		typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry);
	const isHashOrNull = (entry: unknown) =>
		entry === null ||
		(typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry));
	if (
		Object.keys(record).some((key) => !keys.includes(key)) ||
		record.v !== 1 ||
		!Number.isSafeInteger(record.seq) ||
		(record.seq as number) < 1 ||
		typeof record.timestamp !== 'string' ||
		![
			'candidate_recorded',
			'activated',
			'rolled_back',
			'recovered_tail',
			'compacted',
		].includes(String(record.kind)) ||
		typeof record.candidateId !== 'string' ||
		!ARTIFACT_ID_RE.test(record.candidateId) ||
		!isIdOrNull(record.versionId) ||
		!isIdOrNull(record.parentVersionId) ||
		!isIdOrNull(record.restoredFromVersionId) ||
		!isIdOrNull(record.approvalFactId) ||
		!isHash(record.payloadHash) ||
		!Number.isSafeInteger(record.generation) ||
		(record.generation as number) < 0 ||
		!isHash(record.currentHashBefore) ||
		!isHash(record.currentHashAfter) ||
		!isIdOrNull(record.nextCurrentVersionId) ||
		!isIdOrNull(record.nextCurrentCandidateId) ||
		!isHashOrNull(record.nextCurrentManifestHash) ||
		!Array.isArray(record.nextVersionIds) ||
		record.nextVersionIds.some(
			(id) => typeof id !== 'string' || !ARTIFACT_ID_RE.test(id),
		) ||
		new Set(record.nextVersionIds).size !== record.nextVersionIds.length ||
		typeof record.nextUpdatedAt !== 'string' ||
		typeof record.ledgerSegment !== 'string' ||
		!/^\d{6}\.jsonl$/.test(record.ledgerSegment) ||
		!isHash(record.hashBefore) ||
		!isHash(record.hashAfter) ||
		!Array.isArray(record.prunedVersionIds) ||
		record.prunedVersionIds.some(
			(id) => typeof id !== 'string' || !ARTIFACT_ID_RE.test(id),
		) ||
		new Set(record.prunedVersionIds).size !== record.prunedVersionIds.length ||
		(record.recoverySegment !== null &&
			typeof record.recoverySegment !== 'string') ||
		(record.recoveredBytes !== null &&
			(!Number.isSafeInteger(record.recoveredBytes) ||
				(record.recoveredBytes as number) < 1)) ||
		!Array.isArray(record.retainedCandidates) ||
		record.retainedCandidates.some(
			(entry) =>
				!entry ||
				typeof entry !== 'object' ||
				Array.isArray(entry) ||
				typeof (entry as { candidateId?: unknown }).candidateId !== 'string' ||
				!ARTIFACT_ID_RE.test((entry as { candidateId: string }).candidateId) ||
				typeof (entry as { manifestHash?: unknown }).manifestHash !==
					'string' ||
				!/^[a-f0-9]{64}$/.test(
					(entry as { manifestHash: string }).manifestHash,
				),
		) ||
		new Set(
			(record.retainedCandidates as RetainedCandidateBinding[]).map(
				(entry) => entry.candidateId,
			),
		).size !== record.retainedCandidates.length ||
		(record.compactedRecords !== null &&
			(!Number.isSafeInteger(record.compactedRecords) ||
				(record.compactedRecords as number) < 1))
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness ledger record',
		);
	}
	const parsed = record as unknown as HarnessLedgerRecordV1;
	if (
		(parsed.nextCurrentVersionId === null) !==
			(parsed.nextCurrentCandidateId === null ||
				parsed.nextCurrentManifestHash === null) ||
		(parsed.nextCurrentVersionId !== null &&
			(parsed.nextCurrentCandidateId === null ||
				parsed.nextCurrentManifestHash === null))
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness ledger next-current linkage',
		);
	}
	const candidateOnly = parsed.kind === 'candidate_recorded';
	const recoveryOnly = parsed.kind === 'recovered_tail';
	const compactedOnly = parsed.kind === 'compacted';
	const emptyCurrent = buildEmptyCurrentProjection();
	if (
		(candidateOnly &&
			(parsed.versionId !== null ||
				parsed.parentVersionId !== null ||
				parsed.restoredFromVersionId !== null ||
				parsed.approvalFactId !== null ||
				parsed.prunedVersionIds.length !== 0 ||
				parsed.recoverySegment !== null ||
				parsed.recoveredBytes !== null ||
				parsed.retainedCandidates.length !== 0 ||
				parsed.compactedRecords !== null ||
				parsed.currentHashBefore !== parsed.currentHashAfter)) ||
		(recoveryOnly &&
			(parsed.versionId !== null ||
				parsed.parentVersionId !== null ||
				parsed.restoredFromVersionId !== null ||
				parsed.approvalFactId !== null ||
				parsed.prunedVersionIds.length !== 0 ||
				parsed.recoverySegment === null ||
				parsed.recoveredBytes === null ||
				parsed.retainedCandidates.length !== 0 ||
				parsed.compactedRecords !== null ||
				parsed.candidateId !== RECOVERY_CANDIDATE_ID ||
				parsed.currentHashBefore !== parsed.currentHashAfter)) ||
		(compactedOnly &&
			(parsed.versionId !== null ||
				parsed.parentVersionId !== null ||
				parsed.restoredFromVersionId !== null ||
				parsed.approvalFactId !== null ||
				parsed.prunedVersionIds.length !== 0 ||
				parsed.recoverySegment !== null ||
				parsed.recoveredBytes !== null ||
				parsed.compactedRecords === null ||
				parsed.candidateId !== COMPACTED_CANDIDATE_ID ||
				parsed.currentHashBefore !== emptyCurrent.currentHash ||
				parsed.hashBefore !== emptyCurrent.ledgerHeadHash)) ||
		(!candidateOnly &&
			!recoveryOnly &&
			!compactedOnly &&
			(parsed.versionId === null ||
				parsed.approvalFactId === null ||
				parsed.generation < 1)) ||
		(parsed.versionId !== null &&
			parsed.parentVersionId === parsed.versionId) ||
		(parsed.versionId !== null &&
			parsed.restoredFromVersionId === parsed.versionId) ||
		(parsed.kind === 'activated' && parsed.restoredFromVersionId !== null) ||
		(parsed.kind === 'rolled_back' &&
			(parsed.parentVersionId === null ||
				parsed.restoredFromVersionId === null)) ||
		(!recoveryOnly &&
			(parsed.recoverySegment !== null || parsed.recoveredBytes !== null)) ||
		(!compactedOnly &&
			(parsed.retainedCandidates.length !== 0 ||
				parsed.compactedRecords !== null))
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness ledger event shape',
		);
	}
	if (
		computeCurrentHash({
			currentVersionId: parsed.nextCurrentVersionId,
			currentCandidateId: parsed.nextCurrentCandidateId,
			currentManifestHash: parsed.nextCurrentManifestHash,
			generation: parsed.generation,
			versionIds: parsed.nextVersionIds,
		}) !== parsed.currentHashAfter
	) {
		throw new HarnessStoreIntegrityError(
			artifactPath,
			'invalid harness ledger next-current hash',
		);
	}
	return parsed;
}

function ledgerRecordsToCurrent(
	records: HarnessLedgerRecordV1[],
): HarnessCurrentProjectionV1 {
	let current = buildCurrentProjection(
		null,
		null,
		null,
		0,
		[],
		'1970-01-01T00:00:00.000Z',
	);
	for (const record of records) {
		current = applyLedgerRecordToCurrent(current, record);
	}
	return current;
}

function applyLedgerRecordToCurrent(
	current: HarnessCurrentProjectionV1,
	record: HarnessLedgerRecordV1,
): HarnessCurrentProjectionV1 {
	const versionIds =
		record.kind === 'compacted'
			? record.nextVersionIds
			: [...current.versionIds, record.versionId as string].filter(
					(id) => !record.prunedVersionIds.includes(id),
				);
	const nextVersionIds =
		record.kind === 'candidate_recorded' || record.kind === 'recovered_tail'
			? current.versionIds
			: versionIds;
	return buildCurrentProjection(
		record.nextCurrentVersionId,
		record.nextCurrentCandidateId,
		record.nextCurrentManifestHash,
		record.generation,
		nextVersionIds,
		record.nextUpdatedAt,
		record.ledgerSegment,
		record.seq,
		record.hashAfter,
	);
}

function scanLedgerHistory(
	directory: string,
	maxReplayRecords?: number,
): LedgerScanResult {
	const segments = listSegmentPaths(directory);
	const records: HarnessLedgerRecordV1[] = [];
	const replayBound = resolveReplayBound(maxReplayRecords);
	let truncated = false;
	const quarantinePath: string | null = null;
	let previousHashAfter = sha256('null');
	let replayCurrent = buildEmptyCurrentProjection();
	let tornTail: TornTailRecoveryInfo | null = null;

	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const segment = segments[segmentIndex]!;
		const raw = readFileSync(segment, 'utf8');
		const lines = raw.split('\n');
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (!line.trim()) continue;
			try {
				const location = `${path.basename(segment)}:${index + 1}`;
				const parsed = parseLedgerRecord(JSON.parse(line), location);
				if (parsed.seq !== records.length + 1) {
					throw new HarnessStoreIntegrityError(
						location,
						'harness ledger sequence gap',
					);
				}
				const { hashAfter: _ignored, ...recordWithoutHash } = parsed;
				const expected = computeLedgerRecordHash(recordWithoutHash);
				if (expected !== parsed.hashAfter) {
					throw new Error(
						`harness ledger hash mismatch at ${path.basename(segment)}:${index + 1}`,
					);
				}
				if (parsed.hashBefore !== previousHashAfter) {
					throw new Error(
						`harness ledger chain mismatch at ${path.basename(segment)}:${index + 1}`,
					);
				}
				if (parsed.currentHashBefore !== replayCurrent.currentHash) {
					throw new HarnessStoreIntegrityError(
						location,
						'harness ledger current-state precondition mismatch',
					);
				}
				const currentAfter = applyLedgerRecordToCurrent(replayCurrent, parsed);
				if (parsed.currentHashAfter !== currentAfter.currentHash) {
					throw new HarnessStoreIntegrityError(
						location,
						'harness ledger current-state transition mismatch',
					);
				}
				if (records.length === replayBound) {
					throwReplayBoundExceeded(replayBound);
				}
				records.push(parsed);
				previousHashAfter = parsed.hashAfter;
				replayCurrent = currentAfter;
			} catch (error) {
				const isPhysicalTornTail =
					segmentIndex === segments.length - 1 &&
					index === lines.length - 1 &&
					!raw.endsWith('\n') &&
					error instanceof SyntaxError;
				if (isPhysicalTornTail) {
					truncated = true;
					const retainedBytes = Buffer.byteLength(
						raw.slice(0, Math.max(0, raw.lastIndexOf('\n') + 1)),
						'utf8',
					);
					const discarded = raw.slice(retainedBytes);
					tornTail = {
						segmentPath: segment,
						segmentName: path.basename(segment),
						retainedBytes,
						discardedBytes: Buffer.byteLength(discarded, 'utf8'),
						discardedHash: sha256(discarded),
					};
					break;
				}
				throw error;
			}
		}
	}

	const payloadByCandidate = new Map<string, string>();
	for (const record of records) {
		if (record.kind === 'recovered_tail' || record.kind === 'compacted')
			continue;
		const existing = payloadByCandidate.get(record.candidateId);
		if (existing && existing !== record.payloadHash) {
			throw new HarnessStoreIntegrityError(
				record.candidateId,
				'harness ledger candidate payload changed',
			);
		}
		payloadByCandidate.set(record.candidateId, record.payloadHash);
	}
	for (const [candidateId, payloadHash] of payloadByCandidate) {
		const candidate = readStoredCandidate(directory, candidateId);
		if (!candidate || candidate.candidate.manifestHash !== payloadHash) {
			throw new HarnessStoreIntegrityError(
				candidatePath(directory, candidateId),
				'harness ledger references a missing or mismatched candidate',
			);
		}
	}
	for (const record of records) {
		if (!isCompactionRecord(record)) continue;
		for (const retained of record.retainedCandidates) {
			const candidate = readStoredCandidate(directory, retained.candidateId);
			if (
				!candidate ||
				candidate.candidate.manifestHash !== retained.manifestHash
			) {
				throw new HarnessStoreIntegrityError(
					candidatePath(directory, retained.candidateId),
					'harness compaction snapshot references a missing or mismatched candidate',
				);
			}
		}
	}
	const reachableVersionIds = new Set(replayCurrent.versionIds);
	const pendingVersionIds = [...replayCurrent.versionIds];
	while (pendingVersionIds.length > 0) {
		const versionId = pendingVersionIds.pop()!;
		const version = readStoredVersion(versionPath(directory, versionId));
		const ledgerRecord = records.find(
			(record) => record.versionId === versionId,
		);
		if (
			!version ||
			!ledgerRecord ||
			version.versionId !== versionId ||
			version.candidateId !== ledgerRecord.candidateId ||
			version.manifestHash !== ledgerRecord.payloadHash ||
			version.parentVersionId !== ledgerRecord.parentVersionId ||
			version.restoredFromVersionId !== ledgerRecord.restoredFromVersionId ||
			version.approvalFactId !== ledgerRecord.approvalFactId ||
			(version.sourceKind === 'activation') !==
				(ledgerRecord.kind === 'activated')
		) {
			throw new HarnessStoreIntegrityError(
				versionPath(directory, versionId),
				'harness ledger references a missing surviving version',
			);
		}
		for (const referencedVersionId of referencedVersionIds(version)) {
			if (!reachableVersionIds.has(referencedVersionId)) {
				reachableVersionIds.add(referencedVersionId);
				pendingVersionIds.push(referencedVersionId);
			}
		}
	}

	return {
		records,
		truncated,
		quarantinePath,
		totalSegments: segments.length,
		tornTail,
	};
}

function readVerifiedLedgerRecords(
	directory: string,
	maxReplayRecords?: number,
): LedgerScanResult {
	return scanLedgerHistory(directory, maxReplayRecords);
}

function readSegmentRecords(
	segmentPath: string,
	allowPhysicalTornTail: boolean,
): { records: HarnessLedgerRecordV1[]; truncated: boolean } {
	const raw = readFileSync(segmentPath, 'utf8');
	const lines = raw.split('\n');
	let truncated = false;
	if (!raw.endsWith('\n')) {
		const tail = lines[lines.length - 1];
		if (tail?.trim()) {
			try {
				JSON.parse(tail);
			} catch (error) {
				if (allowPhysicalTornTail && error instanceof SyntaxError) {
					lines.pop();
					truncated = true;
				} else {
					throw error;
				}
			}
		}
	}
	const records: HarnessLedgerRecordV1[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (!line.trim()) continue;
		const location = `${path.basename(segmentPath)}:${index + 1}`;
		const parsed = parseLedgerRecord(JSON.parse(line), location);
		if (parsed.ledgerSegment !== path.basename(segmentPath)) {
			throw new HarnessStoreIntegrityError(
				location,
				'harness ledger segment binding mismatch',
			);
		}
		records.push(parsed);
	}
	return { records, truncated };
}

function currentProjectionMatchesRecord(
	current: HarnessCurrentProjectionV1,
	record: HarnessLedgerRecordV1,
): boolean {
	return (
		current.currentVersionId === record.nextCurrentVersionId &&
		current.currentCandidateId === record.nextCurrentCandidateId &&
		current.currentManifestHash === record.nextCurrentManifestHash &&
		current.currentHash === record.currentHashAfter &&
		current.generation === record.generation &&
		stableJson(current.versionIds) === stableJson(record.nextVersionIds) &&
		current.updatedAt === record.nextUpdatedAt &&
		current.ledgerHeadSegment === record.ledgerSegment &&
		current.ledgerHeadSeq === record.seq &&
		current.ledgerHeadHash === record.hashAfter
	);
}

function assertLedgerRecordArtifacts(
	directory: string,
	record: HarnessLedgerRecordV1,
	accessibleVersionIds: ReadonlySet<string>,
): void {
	if (record.kind === 'compacted') {
		for (const retained of record.retainedCandidates) {
			const candidate = readStoredCandidate(directory, retained.candidateId);
			if (
				!candidate ||
				candidate.candidate.manifestHash !== retained.manifestHash
			) {
				throw new HarnessStoreIntegrityError(
					candidatePath(directory, retained.candidateId),
					'harness compaction snapshot references a missing or mismatched candidate',
				);
			}
		}
	} else if (record.kind !== 'recovered_tail') {
		const candidate = readStoredCandidate(directory, record.candidateId);
		if (!candidate || candidate.candidate.manifestHash !== record.payloadHash) {
			throw new HarnessStoreIntegrityError(
				candidatePath(directory, record.candidateId),
				'harness ledger references a missing or mismatched candidate',
			);
		}
	}
	if (record.versionId && accessibleVersionIds.has(record.versionId)) {
		const version = readStoredVersion(versionPath(directory, record.versionId));
		if (
			!version ||
			version.versionId !== record.versionId ||
			version.candidateId !== record.candidateId ||
			version.manifestHash !== record.payloadHash ||
			version.parentVersionId !== record.parentVersionId ||
			version.restoredFromVersionId !== record.restoredFromVersionId ||
			version.approvalFactId !== record.approvalFactId ||
			(version.sourceKind === 'activation') !== (record.kind === 'activated')
		) {
			throw new HarnessStoreIntegrityError(
				versionPath(directory, record.versionId),
				'harness ledger references a missing surviving version',
			);
		}
	}
}

function verifyLedgerRecordTransition(
	record: HarnessLedgerRecordV1,
	currentBefore: HarnessCurrentProjectionV1,
	previousHashAfter: string,
	expectedSeq: number,
	location: string,
): HarnessCurrentProjectionV1 {
	if (record.seq !== expectedSeq) {
		throw new HarnessStoreIntegrityError(
			location,
			'harness ledger sequence gap',
		);
	}
	const { hashAfter: _ignored, ...recordWithoutHash } = record;
	const expectedHashAfter = computeLedgerRecordHash(recordWithoutHash);
	if (expectedHashAfter !== record.hashAfter) {
		throw new Error(`harness ledger hash mismatch at ${location}`);
	}
	if (record.hashBefore !== previousHashAfter) {
		throw new Error(`harness ledger chain mismatch at ${location}`);
	}
	if (record.currentHashBefore !== currentBefore.currentHash) {
		throw new HarnessStoreIntegrityError(
			location,
			'harness ledger current-state precondition mismatch',
		);
	}
	const currentAfter = applyLedgerRecordToCurrent(currentBefore, record);
	if (record.currentHashAfter !== currentAfter.currentHash) {
		throw new HarnessStoreIntegrityError(
			location,
			'harness ledger current-state transition mismatch',
		);
	}
	return currentAfter;
}

function readProjectionAnchor(
	directory: string,
	segmentIndex: number,
): {
	current: HarnessCurrentProjectionV1;
	previousHashAfter: string;
	nextSeq: number;
} {
	if (segmentIndex <= 1) {
		return {
			current: buildEmptyCurrentProjection(),
			previousHashAfter: sha256('null'),
			nextSeq: 1,
		};
	}
	const previousSegmentPath = path.join(
		activeLedgerDir(directory),
		segmentName(segmentIndex - 1),
	);
	if (!existsSync(previousSegmentPath)) {
		throw new HarnessStoreIntegrityError(
			previousSegmentPath,
			'harness ledger segment missing during projection replay',
		);
	}
	const previousRecords = readSegmentRecords(
		previousSegmentPath,
		false,
	).records;
	const previousHead = previousRecords.at(-1);
	if (!previousHead) {
		throw new HarnessStoreIntegrityError(
			previousSegmentPath,
			'harness ledger segment is empty during projection replay',
		);
	}
	return {
		current: buildCurrentProjectionFromRecord(previousHead),
		previousHashAfter: previousHead.hashAfter,
		nextSeq: previousHead.seq + 1,
	};
}

function loadCurrentProjectionFast(
	directory: string,
	maxReplayRecords?: number,
): { current: HarnessCurrentProjectionV1; truncated: boolean } | null {
	const stored = readStoredCurrentProjection(directory);
	if (!stored) return null;
	const replayBound = resolveReplayBound(maxReplayRecords);
	const storedHeadSegmentIndex =
		stored.ledgerHeadSegment === null
			? 0
			: parseSegmentIndex(stored.ledgerHeadSegment);
	const segmentCount = countLedgerSegments(
		directory,
		storedHeadSegmentIndex + replayBound,
	);
	if (segmentCount.exceeded) {
		throwReplayBoundExceeded(replayBound);
	}
	if (stored.ledgerHeadSeq === 0) {
		if (segmentCount.count === 0) return { current: stored, truncated: false };
	} else if (
		!stored.ledgerHeadSegment ||
		segmentCount.count < storedHeadSegmentIndex
	) {
		return null;
	}
	let current =
		storedHeadSegmentIndex === 0 ? stored : buildEmptyCurrentProjection();
	let previousHashAfter =
		storedHeadSegmentIndex === 0 ? stored.ledgerHeadHash : '';
	let expectedSeq = storedHeadSegmentIndex === 0 ? 1 : stored.ledgerHeadSeq + 1;
	let pointerSegmentRecords: HarnessLedgerRecordV1[] | null = null;
	let pointerRecordIndex = -1;
	let truncated = false;
	const verifiedRecords: HarnessLedgerRecordV1[] = [];

	if (storedHeadSegmentIndex > 0) {
		const segmentPath = path.join(
			activeLedgerDir(directory),
			stored.ledgerHeadSegment!,
		);
		if (!existsSync(segmentPath)) return null;
		const parsed = readSegmentRecords(
			segmentPath,
			storedHeadSegmentIndex === segmentCount.count,
		);
		pointerSegmentRecords = parsed.records;
		truncated ||= parsed.truncated;
		pointerRecordIndex = parsed.records.findIndex((record) =>
			currentProjectionMatchesRecord(stored, record),
		);
		if (pointerRecordIndex < 0) return null;
		const anchor = readProjectionAnchor(directory, storedHeadSegmentIndex);
		current = anchor.current;
		previousHashAfter = anchor.previousHashAfter;
		expectedSeq = anchor.nextSeq;
		for (let index = 0; index <= pointerRecordIndex; index++) {
			const record = parsed.records[index]!;
			current = verifyLedgerRecordTransition(
				record,
				current,
				previousHashAfter,
				expectedSeq,
				`${record.ledgerSegment}:${index + 1}`,
			);
			verifiedRecords.push(record);
			previousHashAfter = record.hashAfter;
			expectedSeq++;
		}
	}
	let replayedRecords = 0;
	for (
		let segmentIndex = Math.max(1, storedHeadSegmentIndex || 1);
		segmentIndex <= segmentCount.count;
		segmentIndex++
	) {
		const parsed =
			segmentIndex === storedHeadSegmentIndex && pointerSegmentRecords
				? { records: pointerSegmentRecords, truncated: false }
				: readSegmentRecords(
						path.join(activeLedgerDir(directory), segmentName(segmentIndex)),
						segmentIndex === segmentCount.count,
					);
		truncated ||= parsed.truncated;
		const startIndex =
			segmentIndex === storedHeadSegmentIndex && pointerRecordIndex >= 0
				? pointerRecordIndex + 1
				: 0;
		for (let index = startIndex; index < parsed.records.length; index++) {
			if (replayedRecords === replayBound) {
				throwReplayBoundExceeded(replayBound);
			}
			const record = parsed.records[index]!;
			current = verifyLedgerRecordTransition(
				record,
				current,
				previousHashAfter,
				expectedSeq,
				`${record.ledgerSegment}:${index + 1}`,
			);
			verifiedRecords.push(record);
			previousHashAfter = record.hashAfter;
			expectedSeq++;
			replayedRecords++;
		}
	}
	const accessibleVersionIds = collectAccessibleVersionIds(directory, current);
	for (const record of verifiedRecords) {
		assertLedgerRecordArtifacts(directory, record, accessibleVersionIds);
	}
	return { current, truncated };
}

function collectAccessibleVersionIds(
	directory: string,
	current: HarnessCurrentProjectionV1,
): Set<string> {
	const cache = new Map<string, HarnessVersionV1>();
	const versionIds = new Set<string>();
	for (const versionId of current.versionIds) {
		for (const closureVersionId of collectVersionClosure(
			directory,
			versionId,
			cache,
		)) {
			versionIds.add(closureVersionId);
		}
	}
	return versionIds;
}

function collectAccessibleCandidateIds(
	directory: string,
	accessibleVersionIds: ReadonlySet<string>,
): Set<string> {
	const candidateIds = new Set<string>();
	for (const versionId of accessibleVersionIds) {
		const version = readStoredVersion(versionPath(directory, versionId));
		if (!version) {
			throw new HarnessStoreIntegrityError(
				versionPath(directory, versionId),
				'harness current projection references a missing surviving version',
			);
		}
		candidateIds.add(version.candidateId);
	}
	return candidateIds;
}

function retainedCandidateBindingsFromHistory(
	records: readonly HarnessLedgerRecordV1[],
): Map<string, string> {
	const retained = new Map<string, string>();
	for (const record of records) {
		if (!isCompactionRecord(record)) continue;
		for (const candidate of record.retainedCandidates) {
			retained.set(candidate.candidateId, candidate.manifestHash);
		}
	}
	return retained;
}

function buildHarnessHistoryPage(
	directory: string,
	current: HarnessCurrentProjectionV1,
	limit: number,
	maxReplayRecords?: number,
	initialTruncated = false,
): HarnessHistoryResult {
	const safeLimit = Math.max(1, limit);
	const replayBound = resolveReplayBound(maxReplayRecords);
	if (safeLimit > replayBound) {
		throwReplayBoundExceeded(replayBound);
	}
	if (current.ledgerHeadSeq === 0) {
		return {
			records: [],
			truncated: initialTruncated,
			quarantinePath: null,
			totalRecordCount: 0,
			limit: safeLimit,
			totalSegments: 0,
		};
	}
	if (!current.ledgerHeadSegment) {
		throw new HarnessStoreIntegrityError(
			currentPath(directory),
			'harness current projection is missing its head segment',
		);
	}
	const headSegmentIndex = parseSegmentIndex(current.ledgerHeadSegment);
	const accessibleVersionIds = collectAccessibleVersionIds(directory, current);
	const records: HarnessLedgerRecordV1[] = [];
	let truncated = initialTruncated;
	let expectedSeq = current.ledgerHeadSeq;
	let expectedHashAfter = current.ledgerHeadHash;
	for (
		let segmentIndex = headSegmentIndex;
		segmentIndex >= 1 && records.length < safeLimit;
		segmentIndex--
	) {
		const segmentPath = path.join(
			activeLedgerDir(directory),
			segmentName(segmentIndex),
		);
		if (!existsSync(segmentPath)) {
			throw new HarnessStoreIntegrityError(
				segmentPath,
				'harness ledger segment missing during bounded history read',
			);
		}
		const parsed = readSegmentRecords(
			segmentPath,
			segmentIndex === headSegmentIndex,
		);
		truncated ||= parsed.truncated;
		for (let index = parsed.records.length - 1; index >= 0; index--) {
			if (records.length >= replayBound) {
				throwReplayBoundExceeded(replayBound);
			}
			const record = parsed.records[index]!;
			if (
				record.seq !== expectedSeq ||
				record.hashAfter !== expectedHashAfter
			) {
				throw new HarnessStoreIntegrityError(
					`${record.ledgerSegment}:${index + 1}`,
					'harness bounded history pointer mismatch',
				);
			}
			assertLedgerRecordArtifacts(directory, record, accessibleVersionIds);
			records.push(record);
			expectedSeq--;
			expectedHashAfter = record.hashBefore;
			if (records.length >= safeLimit) break;
		}
	}
	return {
		records,
		truncated,
		quarantinePath: null,
		totalRecordCount: current.ledgerHeadSeq,
		limit: safeLimit,
		totalSegments: headSegmentIndex,
	};
}

function removePrunedVersionArtifacts(
	directory: string,
	versionIds: readonly string[],
): string[] {
	const failures: string[] = [];
	for (const versionId of versionIds) {
		const target = versionPath(directory, versionId);
		try {
			_storeInternals.removeVersionArtifact(target);
		} catch {
			failures.push(versionId);
		}
	}
	return failures;
}

function removeVersionArtifact(filePath: string): void {
	if (existsSync(filePath)) unlinkSync(filePath);
}

function discardUncommittedVersion(directory: string, versionId: string): void {
	const target = versionPath(directory, versionId);
	try {
		_storeInternals.removeVersionArtifact(target);
	} catch {
		throw new HarnessStoreIntegrityError(
			target,
			'failed to discard uncommitted harness version',
		);
	}
}

function truncateLedgerSegment(
	segmentPath: string,
	expected: TornTailRecoveryInfo,
): void {
	const before = readFileIdentity(segmentPath);
	if (before.size < expected.retainedBytes + expected.discardedBytes) {
		throw new HarnessStoreIntegrityError(
			segmentPath,
			'harness ledger torn tail shrank before recovery',
		);
	}
	const raw = readFileSync(segmentPath, 'utf8');
	const retainedContent = raw.slice(0, expected.retainedBytes);
	const discarded = raw.slice(expected.retainedBytes);
	if (Buffer.byteLength(discarded, 'utf8') !== expected.discardedBytes) {
		throw new HarnessStoreIntegrityError(
			segmentPath,
			'harness ledger torn tail size changed before recovery',
		);
	}
	if (sha256(discarded) !== expected.discardedHash) {
		throw new HarnessStoreIntegrityError(
			segmentPath,
			'harness ledger torn tail content changed before recovery',
		);
	}
	const fd = openSync(segmentPath, FS_CONSTANTS.O_RDWR);
	try {
		const opened = fstatSync(fd);
		const openedIdentity: FileIdentity = {
			dev: opened.dev,
			ino: opened.ino,
			size: opened.size,
		};
		if (!sameFileIdentity(before, openedIdentity)) {
			throw new HarnessStoreIntegrityError(
				segmentPath,
				'harness ledger segment identity changed before recovery',
			);
		}
		ftruncateSync(fd, expected.retainedBytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const after = readFileIdentity(segmentPath);
	if (!sameFileIdentity(before, after)) {
		throw new HarnessStoreIntegrityError(
			segmentPath,
			'harness ledger segment identity changed after recovery',
		);
	}
	if (after.size !== expected.retainedBytes) {
		throw new HarnessStoreIntegrityError(
			segmentPath,
			'harness ledger torn tail recovery size mismatch',
		);
	}
	const repaired = readFileSync(segmentPath, 'utf8');
	if (repaired !== retainedContent) {
		throw new HarnessStoreIntegrityError(
			segmentPath,
			'harness ledger torn tail recovery content mismatch',
		);
	}
}

function buildTornTailRecoveryRecord(args: {
	current: HarnessCurrentProjectionV1;
	directory: string;
	tornTail: TornTailRecoveryInfo;
}): HarnessLedgerRecordV1 {
	return buildLedgerRecord({
		directory: args.directory,
		current: args.current,
		nextCurrent: args.current,
		kind: 'recovered_tail',
		candidateId: RECOVERY_CANDIDATE_ID,
		versionId: null,
		parentVersionId: null,
		restoredFromVersionId: null,
		approvalFactId: null,
		payloadHash: sha256(
			stableJson({
				segment: args.tornTail.segmentName,
				recoveredBytes: args.tornTail.discardedBytes,
				discardedHash: args.tornTail.discardedHash,
			}),
		),
		prunedVersionIds: [],
		recoverySegment: args.tornTail.segmentName,
		recoveredBytes: args.tornTail.discardedBytes,
	});
}

function repairTornLedgerTailUnderLock(
	directory: string,
	scan: LedgerScanResult,
	maxReplayRecords?: number,
): LedgerScanResult {
	if (!scan.tornTail) return scan;
	truncateLedgerSegment(scan.tornTail.segmentPath, scan.tornTail);
	const current = ledgerRecordsToCurrent(scan.records);
	const recoveryRecord = buildTornTailRecoveryRecord({
		directory,
		current,
		tornTail: scan.tornTail,
	});
	appendLedgerRecordWithCommitRecovery(
		directory,
		recoveryRecord,
		maxReplayRecords,
	);
	return readVerifiedLedgerRecords(directory, maxReplayRecords);
}

function loadCurrentForMutation(
	directory: string,
	maxReplayRecords?: number,
): { current: HarnessCurrentProjectionV1; initialTruncated: boolean } {
	const fast = loadCurrentProjectionFast(directory, maxReplayRecords);
	if (fast && !fast.truncated) {
		return { current: fast.current, initialTruncated: false };
	}
	const repaired = fast?.truncated
		? repairTornLedgerTailUnderLock(
				directory,
				readVerifiedLedgerRecords(directory, maxReplayRecords),
				maxReplayRecords,
			)
		: readVerifiedLedgerRecords(directory, maxReplayRecords);
	return {
		current: ledgerRecordsToCurrent(repaired.records),
		initialTruncated: repaired.truncated,
	};
}

function loadCurrentForRead(
	directory: string,
	maxReplayRecords?: number,
): { current: HarnessCurrentProjectionV1; initialTruncated: boolean } {
	const fast = loadCurrentProjectionFast(directory, maxReplayRecords);
	if (fast) {
		return { current: fast.current, initialTruncated: fast.truncated };
	}
	const scan = readVerifiedLedgerRecords(directory, maxReplayRecords);
	return {
		current: ledgerRecordsToCurrent(scan.records),
		initialTruncated: scan.truncated,
	};
}

function listCommittedRecordsWithinReplayBound(
	directory: string,
	current: HarnessCurrentProjectionV1,
	maxReplayRecords?: number,
	initialTruncated = false,
): HarnessLedgerRecordV1[] {
	const replayBound = resolveReplayBound(maxReplayRecords);
	const history = buildHarnessHistoryPage(
		directory,
		current,
		Math.min(current.ledgerHeadSeq, replayBound),
		replayBound,
		initialTruncated,
	);
	return history.records;
}

function candidateCommittedWithinReplayBound(
	directory: string,
	current: HarnessCurrentProjectionV1,
	candidateId: string,
	maxReplayRecords?: number,
	initialTruncated = false,
): boolean {
	const replayBound = resolveReplayBound(maxReplayRecords);
	const records = listCommittedRecordsWithinReplayBound(
		directory,
		current,
		replayBound,
		initialTruncated,
	);
	if (records.some((record) => record.candidateId === candidateId)) return true;
	const accessibleVersionIds = collectAccessibleVersionIds(directory, current);
	if (
		collectAccessibleCandidateIds(directory, accessibleVersionIds).has(
			candidateId,
		)
	) {
		return true;
	}
	if (retainedCandidateBindingsFromHistory(records).has(candidateId))
		return true;
	if (current.ledgerHeadSeq > replayBound) {
		throwReplayBoundExceeded(replayBound);
	}
	return false;
}

function approvalFactAlreadyCommittedWithinReplayBound(
	directory: string,
	current: HarnessCurrentProjectionV1,
	approvalFactId: string,
	maxReplayRecords?: number,
	initialTruncated = false,
): boolean {
	return listCommittedRecordsWithinReplayBound(
		directory,
		current,
		maxReplayRecords,
		initialTruncated,
	).some((record) => record.approvalFactId === approvalFactId);
}

async function withHarnessLock<T>(
	directory: string,
	work: () => Promise<T>,
): Promise<T> {
	ensureStoreDirectories(directory);
	const release = (await (
		lockfile as unknown as {
			lock: (
				target: string,
				options: {
					retries: typeof LOCK_RETRY;
					stale: number;
					realpath: boolean;
				},
			) => Promise<LockRelease>;
		}
	).lock(rootDir(directory), {
		retries: LOCK_RETRY,
		stale: 5_000,
		realpath: false,
	})) as LockRelease;
	try {
		return await work();
	} finally {
		await release().catch(() => {});
	}
}

async function writeCurrentProjection(
	directory: string,
	current: HarnessCurrentProjectionV1,
): Promise<void> {
	await atomicWriteSwarmFile(
		currentPath(directory),
		`${JSON.stringify(current, null, 2)}\n`,
	);
}

async function writeLedgerGenerationPointer(
	directory: string,
	generationDir: string,
): Promise<void> {
	await atomicWriteSwarmFile(
		ledgerPointerPath(directory),
		`${JSON.stringify({ v: 1, generationDir } satisfies LedgerGenerationPointerV1, null, 2)}\n`,
	);
}

function buildCompactionPayloadHash(args: {
	current: HarnessCurrentProjectionV1;
	retainedCandidates: readonly RetainedCandidateBinding[];
	compactedRecords: number;
}): string {
	return sha256(
		stableJson({
			currentHash: args.current.currentHash,
			generation: args.current.generation,
			versionIds: args.current.versionIds,
			retainedCandidates: args.retainedCandidates,
			compactedRecords: args.compactedRecords,
		}),
	);
}

function buildCompactionRecord(args: {
	directory: string;
	current: HarnessCurrentProjectionV1;
	retainedCandidates: readonly RetainedCandidateBinding[];
	compactedRecords: number;
}): HarnessLedgerRecordV1 {
	return buildLedgerRecord({
		directory: args.directory,
		current: buildEmptyCurrentProjection(),
		nextCurrent: args.current,
		kind: 'compacted',
		candidateId: COMPACTED_CANDIDATE_ID,
		versionId: null,
		parentVersionId: null,
		restoredFromVersionId: null,
		approvalFactId: null,
		payloadHash: buildCompactionPayloadHash(args),
		retainedCandidates: [...args.retainedCandidates],
		compactedRecords: args.compactedRecords,
	});
}

function collectRetainedInactiveCandidates(args: {
	directory: string;
	current: HarnessCurrentProjectionV1;
	records: readonly HarnessLedgerRecordV1[];
	maxInactiveCandidates: number;
}): RetainedCandidateBinding[] {
	const activeCandidateIds = collectAccessibleCandidateIds(
		args.directory,
		collectAccessibleVersionIds(args.directory, args.current),
	);
	const requestedMax = Math.max(0, args.maxInactiveCandidates);
	const retained = new Map<string, string>();
	for (const record of args.records) {
		if (
			record.kind === 'recovered_tail' ||
			record.kind === 'compacted' ||
			activeCandidateIds.has(record.candidateId)
		) {
			continue;
		}
		if (!retained.has(record.candidateId)) {
			retained.set(record.candidateId, record.payloadHash);
		}
		const minimumRetained = retained.size > 0 ? 1 : 0;
		const targetRetained = Math.max(requestedMax, minimumRetained);
		if (retained.size >= targetRetained) break;
	}
	return [...retained.entries()]
		.map(([candidateId, manifestHash]) => ({ candidateId, manifestHash }))
		.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function removeCandidateArtifact(directory: string): void {
	if (existsSync(directory))
		rmSync(directory, { recursive: true, force: true });
}

function removeLedgerArtifact(target: string): void {
	if (!existsSync(target)) return;
	const stat = statSync(target);
	if (stat.isDirectory()) rmSync(target, { recursive: true, force: true });
	else unlinkSync(target);
}

function pruneCandidateArtifacts(args: {
	directory: string;
	retainedCandidateIds: ReadonlySet<string>;
}): string[] {
	const failures: string[] = [];
	for (const name of readDirFiles(candidatesDir(args.directory), 512)) {
		if (!ARTIFACT_ID_RE.test(name) || args.retainedCandidateIds.has(name)) {
			continue;
		}
		try {
			_storeInternals.removeCandidateArtifact(
				candidateDir(args.directory, name),
			);
		} catch {
			failures.push(name);
		}
	}
	return failures;
}

function pruneInactiveLedgerArtifacts(args: {
	directory: string;
	activeGenerationDir: string;
}): string[] {
	const failures: string[] = [];
	for (const name of readDirFiles(ledgerDir(args.directory), 64)) {
		if (
			name === 'active-generation.json' ||
			name === args.activeGenerationDir
		) {
			continue;
		}
		if (!LEDGER_GENERATION_DIR_RE.test(name) && !/^\d{6}\.jsonl$/.test(name)) {
			continue;
		}
		try {
			_storeInternals.removeLedgerArtifact(
				path.join(ledgerDir(args.directory), name),
			);
		} catch {
			failures.push(name);
		}
	}
	return failures;
}

async function compactHarnessLedgerUnderLock(args: {
	directory: string;
	current: HarnessCurrentProjectionV1;
	retainedCandidates: readonly RetainedCandidateBinding[];
	compactedRecords: number;
}): Promise<HarnessCurrentProjectionV1> {
	const generationDir = `generation-${randomUUID().replace(/-/g, '')}`;
	const targetDir = path.join(ledgerDir(args.directory), generationDir);
	mkdirSync(targetDir, { recursive: true });
	const snapshot = buildCompactionRecord(args);
	await atomicWriteSwarmFile(
		path.join(targetDir, segmentName(1)),
		`${JSON.stringify(snapshot)}\n`,
	);
	await writeLedgerGenerationPointer(args.directory, generationDir);
	const compactedCurrent = buildCurrentProjectionFromRecord(snapshot);
	await _storeInternals.writeCurrentProjection(
		args.directory,
		compactedCurrent,
	);
	return compactedCurrent;
}

async function reconcileHarnessPhysicalRetentionUnderLock(args: {
	directory: string;
	current: HarnessCurrentProjectionV1;
	maxReplayRecords?: number;
	maxInactiveCandidates?: number;
	initialTruncated?: boolean;
}): Promise<{
	current: HarnessCurrentProjectionV1;
	reconciled: boolean;
	failures: string[];
}> {
	const replayBound = resolveReplayBound(args.maxReplayRecords);
	const records = listCommittedRecordsWithinReplayBound(
		args.directory,
		args.current,
		replayBound,
		args.initialTruncated ?? false,
	);
	const retainedInactiveCandidates = collectRetainedInactiveCandidates({
		directory: args.directory,
		current: args.current,
		records,
		maxInactiveCandidates: args.maxInactiveCandidates ?? 32,
	});
	const failures: string[] = [];
	let effectiveCurrent = args.current;
	let compacted = false;
	if (
		args.current.ledgerHeadSeq > replayBound ||
		hasLedgerGenerationPointer(args.directory)
	) {
		try {
			effectiveCurrent = await compactHarnessLedgerUnderLock({
				directory: args.directory,
				current: args.current,
				retainedCandidates: retainedInactiveCandidates,
				compactedRecords: args.current.ledgerHeadSeq,
			});
			compacted = true;
		} catch {
			failures.push('ledger_compaction');
		}
	}
	if (compacted) {
		const retainedCandidateIds = new Set<string>([
			...collectAccessibleCandidateIds(
				args.directory,
				collectAccessibleVersionIds(args.directory, effectiveCurrent),
			),
			...retainedInactiveCandidates.map((candidate) => candidate.candidateId),
		]);
		failures.push(
			...pruneCandidateArtifacts({
				directory: args.directory,
				retainedCandidateIds,
			}).map((candidateId) => `candidate:${candidateId}`),
		);
		failures.push(
			...pruneInactiveLedgerArtifacts({
				directory: args.directory,
				activeGenerationDir: path.basename(activeLedgerDir(args.directory)),
			}).map((name) => `ledger:${name}`),
		);
	}
	return {
		current: effectiveCurrent,
		reconciled: failures.length === 0,
		failures,
	};
}

function buildLedgerRecord(args: {
	directory: string;
	current: HarnessCurrentProjectionV1;
	nextCurrent: HarnessCurrentProjectionV1;
	kind: HarnessLedgerRecordV1['kind'];
	candidateId: string;
	versionId: string | null;
	parentVersionId: string | null;
	restoredFromVersionId: string | null;
	approvalFactId: string | null;
	payloadHash: string;
	prunedVersionIds?: string[];
	recoverySegment?: string | null;
	recoveredBytes?: number | null;
	retainedCandidates?: RetainedCandidateBinding[];
	compactedRecords?: number | null;
}): HarnessLedgerRecordV1 {
	const buildBaseRecord = (ledgerSegment: string) =>
		({
			v: STORE_VERSION,
			seq: args.current.ledgerHeadSeq + 1,
			timestamp: new Date().toISOString(),
			kind: args.kind,
			candidateId: args.candidateId,
			versionId: args.versionId,
			parentVersionId: args.parentVersionId,
			restoredFromVersionId: args.restoredFromVersionId,
			approvalFactId: args.approvalFactId,
			payloadHash: args.payloadHash,
			generation: args.nextCurrent.generation,
			currentHashBefore: args.current.currentHash,
			currentHashAfter: args.nextCurrent.currentHash,
			nextCurrentVersionId: args.nextCurrent.currentVersionId,
			nextCurrentCandidateId: args.nextCurrent.currentCandidateId,
			nextCurrentManifestHash: args.nextCurrent.currentManifestHash,
			nextVersionIds: args.nextCurrent.versionIds,
			nextUpdatedAt: args.nextCurrent.updatedAt,
			ledgerSegment,
			prunedVersionIds: args.prunedVersionIds ?? [],
			recoverySegment: args.recoverySegment ?? null,
			recoveredBytes: args.recoveredBytes ?? null,
			retainedCandidates: args.retainedCandidates ?? [],
			compactedRecords: args.compactedRecords ?? null,
			hashBefore: args.current.ledgerHeadHash,
		}) satisfies Omit<HarnessLedgerRecordV1, 'hashAfter'>;
	const placeholder = {
		...buildBaseRecord(segmentName(1)),
		hashAfter: '0'.repeat(64),
	};
	const ledgerSegment = selectAppendSegmentName(
		args.directory,
		args.current,
		Buffer.byteLength(`${JSON.stringify(placeholder)}\n`, 'utf8'),
	);
	const baseRecord = buildBaseRecord(ledgerSegment);
	return {
		...baseRecord,
		hashAfter: computeLedgerRecordHash(baseRecord),
	};
}

function selectAppendSegmentName(
	directory: string,
	current: HarnessCurrentProjectionV1,
	recordBytes: number,
): string {
	if (current.ledgerHeadSeq === 0 || current.ledgerHeadSegment === null) {
		return segmentName(1);
	}
	const activeSegmentPath = path.join(
		activeLedgerDir(directory),
		current.ledgerHeadSegment,
	);
	const identity = readFileIdentity(activeSegmentPath);
	verifySegmentShape(activeSegmentPath, identity);
	if (identity.size + recordBytes <= LEDGER_SEGMENT_MAX_BYTES) {
		return current.ledgerHeadSegment;
	}
	return segmentName(parseSegmentIndex(current.ledgerHeadSegment) + 1);
}

function referencedVersionIds(version: HarnessVersionV1): string[] {
	if (version.sourceKind !== 'rollback') {
		return [];
	}
	return [version.parentVersionId, version.restoredFromVersionId].filter(
		(versionId): versionId is string => versionId !== null,
	);
}

function collectVersionClosure(
	directory: string,
	versionId: string,
	cache: Map<string, HarnessVersionV1>,
	maxVisited = MAX_ORPHAN_SCAN,
): string[] {
	const closure = new Set<string>();
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (cursor: string): void => {
		if (visiting.has(cursor)) {
			throw new HarnessStoreIntegrityError(
				versionPath(directory, cursor),
				'harness version ancestry cycle detected',
			);
		}
		if (visited.has(cursor)) return;
		if (visited.size >= maxVisited) {
			throw new HarnessStoreIntegrityError(
				versionPath(directory, cursor),
				`harness version ancestry exceeds bounded traversal ${maxVisited}`,
			);
		}
		visiting.add(cursor);
		let version = cache.get(cursor);
		if (!version) {
			const loadedVersion = readStoredVersion(versionPath(directory, cursor));
			if (!loadedVersion) {
				throw new HarnessStoreIntegrityError(
					versionPath(directory, cursor),
					'harness version ancestry is missing a committed version',
				);
			}
			version = loadedVersion;
			cache.set(cursor, version);
		}
		visited.add(cursor);
		closure.add(version.versionId);
		for (const referencedVersionId of referencedVersionIds(version)) {
			visit(referencedVersionId);
		}
		visiting.delete(cursor);
	};
	visit(versionId);
	return [...closure];
}

function collectRequiredSeedVersionIds(
	directory: string,
	versionId: string,
	seedVersionIds: readonly string[],
	cache: Map<string, HarnessVersionV1>,
	maxVisited: number,
): RequiredSeedVersionIdsResult {
	const seedVersionIdSet = new Set(seedVersionIds);
	const required = new Set<string>();
	const visited = new Set<string>();
	const visiting = new Set<string>();
	let overflow = false;
	const visit = (cursor: string): void => {
		if (overflow) return;
		if (visiting.has(cursor)) {
			throw new HarnessStoreIntegrityError(
				versionPath(directory, cursor),
				'harness version ancestry cycle detected',
			);
		}
		if (visited.has(cursor)) return;
		if (visited.size >= maxVisited) {
			if (seedVersionIdSet.has(cursor)) {
				required.add(cursor);
			}
			overflow = true;
			return;
		}
		visiting.add(cursor);
		let version = cache.get(cursor);
		if (!version) {
			const loadedVersion = readStoredVersion(versionPath(directory, cursor));
			if (!loadedVersion) {
				throw new HarnessStoreIntegrityError(
					versionPath(directory, cursor),
					'harness retention ancestry is missing a committed version',
				);
			}
			version = loadedVersion;
			cache.set(cursor, version);
		}
		visited.add(cursor);
		if (seedVersionIdSet.has(version.versionId)) {
			required.add(version.versionId);
		}
		for (const referencedVersionId of referencedVersionIds(version)) {
			visit(referencedVersionId);
		}
		visiting.delete(cursor);
	};
	visit(versionId);
	const requiredVersionIds = seedVersionIds.filter((candidateId) =>
		required.has(candidateId),
	);
	return overflow
		? { status: 'overflow', requiredVersionIds }
		: { status: 'ok', requiredVersionIds };
}

function selectRetainedVersionIds(
	directory: string,
	seedVersionIds: string[],
	maxVersions: number,
): RetainedVersionSelectionResult {
	const boundedMaxVersions = Math.max(1, maxVersions);
	if (seedVersionIds.length <= boundedMaxVersions) {
		return { status: 'ok', versionIds: seedVersionIds };
	}
	const cache = new Map<string, HarnessVersionV1>();
	const retained = new Set<string>();
	for (let index = seedVersionIds.length - 1; index >= 0; index--) {
		const required = collectRequiredSeedVersionIds(
			directory,
			seedVersionIds[index]!,
			seedVersionIds,
			cache,
			boundedMaxVersions,
		);
		if (required.status === 'overflow') {
			if (retained.size > 0) continue;
			return {
				status: 'retention_conflict',
				reason:
					'required rollback ancestry exceeds the configured harness retention limit',
				maxVersions: boundedMaxVersions,
				requiredVersionIds: required.requiredVersionIds,
			};
		}
		const requiredVersionIds = required.requiredVersionIds;
		if (retained.size === 0 && requiredVersionIds.length > boundedMaxVersions) {
			return {
				status: 'retention_conflict',
				reason:
					'required rollback ancestry exceeds the configured harness retention limit',
				maxVersions: boundedMaxVersions,
				requiredVersionIds,
			};
		}
		const additions = requiredVersionIds.filter(
			(versionId) => !retained.has(versionId),
		);
		if (retained.size + additions.length <= boundedMaxVersions) {
			for (const versionId of additions) retained.add(versionId);
		}
	}
	return {
		status: 'ok',
		versionIds: seedVersionIds.filter((versionId) => retained.has(versionId)),
	};
}

function currentMatchesExpected(
	current: HarnessCurrentProjectionV1,
	expectedCurrentHash: string | null | undefined,
	expectedCurrentGeneration: number | undefined,
): boolean {
	if (
		expectedCurrentGeneration !== undefined &&
		current.generation !== expectedCurrentGeneration
	) {
		return false;
	}
	if (expectedCurrentHash === null) {
		return current.currentVersionId === null;
	}
	if (expectedCurrentHash === undefined) return true;
	return current.currentHash === expectedCurrentHash;
}

export function buildHarnessActivationApprovalRequest(args: {
	targetSessionId: string;
	candidate: StoredHarnessCandidateV1;
	expectedCurrentHash: string | null;
	expectedCurrentGeneration: number;
	targetContentHash: string;
	allowedPathDigest: string;
}): WriteApprovalRequest {
	return {
		targetSessionId: args.targetSessionId,
		action: 'harness_activate',
		candidateId: args.candidate.candidate.candidateId,
		candidateContentHash: computeWriteApprovalHash({
			operation: 'harness_activate',
			candidateId: args.candidate.candidate.candidateId,
			manifestHash: args.candidate.candidate.manifestHash,
			expectedCurrentHash: args.expectedCurrentHash,
			expectedCurrentGeneration: args.expectedCurrentGeneration,
			targetContentHash: args.targetContentHash,
			allowedPathDigest: args.allowedPathDigest,
		}),
		allowedPathDigest: args.allowedPathDigest,
		generation: args.expectedCurrentGeneration,
	};
}

export function buildHarnessRollbackApprovalRequest(args: {
	targetSessionId: string;
	currentVersionId: string;
	targetVersionId: string;
	expectedCurrentHash: string;
	expectedCurrentGeneration: number;
	targetContentHash: string;
	allowedPathDigest: string;
}): WriteApprovalRequest {
	return {
		targetSessionId: args.targetSessionId,
		action: 'harness_rollback',
		candidateId: args.targetVersionId,
		candidateContentHash: computeWriteApprovalHash({
			operation: 'harness_rollback',
			currentVersionId: args.currentVersionId,
			targetVersionId: args.targetVersionId,
			expectedCurrentHash: args.expectedCurrentHash,
			expectedCurrentGeneration: args.expectedCurrentGeneration,
			targetContentHash: args.targetContentHash,
			allowedPathDigest: args.allowedPathDigest,
		}),
		allowedPathDigest: args.allowedPathDigest,
		generation: args.expectedCurrentGeneration,
	};
}

export async function recordHarnessCandidate(args: {
	directory: string;
	candidate: StoredHarnessCandidateV1;
	maxReplayRecords?: number;
	maxInactiveCandidates?: number;
}): Promise<RecordHarnessCandidateResult> {
	assertProjectRoot(args.directory);
	assertCandidateCoherence(
		args.candidate,
		candidatePath(args.directory, args.candidate.candidate.candidateId),
	);
	return withHarnessLock(args.directory, async () => {
		const { current, initialTruncated } = loadCurrentForMutation(
			args.directory,
			args.maxReplayRecords,
		);
		const target = candidatePath(
			args.directory,
			args.candidate.candidate.candidateId,
		);
		const existing = readStoredCandidate(
			args.directory,
			args.candidate.candidate.candidateId,
		);
		if (existing) {
			if (stableJson(existing) !== stableJson(args.candidate)) {
				return {
					status: 'conflict',
					reason: 'candidate id already exists with different content',
				};
			}
			if (
				candidateCommittedWithinReplayBound(
					args.directory,
					current,
					args.candidate.candidate.candidateId,
					args.maxReplayRecords,
					initialTruncated,
				)
			) {
				const retention = await reconcileHarnessPhysicalRetentionUnderLock({
					directory: args.directory,
					current,
					maxReplayRecords: args.maxReplayRecords,
					maxInactiveCandidates: args.maxInactiveCandidates,
					initialTruncated,
				});
				return {
					status: 'recorded',
					candidate: existing,
					retentionReconciled: retention.reconciled,
					retentionFailures: retention.failures,
				};
			}
		}
		if (!existing) {
			const serialized = serializeCandidateRecord(args.candidate);
			if (
				Buffer.byteLength(serialized, 'utf8') > MAX_CANDIDATE_ARTIFACT_BYTES
			) {
				throw new HarnessStoreIntegrityError(
					target,
					'candidate artifact exceeds byte bound',
				);
			}
			mkdirSync(path.dirname(target), { recursive: true });
			await writePromptArtifacts(args.directory, args.candidate);
			await atomicWriteSwarmFile(target, serialized);
		}
		const record = buildLedgerRecord({
			directory: args.directory,
			current,
			nextCurrent: current,
			kind: 'candidate_recorded',
			candidateId: args.candidate.candidate.candidateId,
			versionId: null,
			parentVersionId: null,
			restoredFromVersionId: null,
			approvalFactId: null,
			payloadHash: args.candidate.candidate.manifestHash,
		});
		try {
			_storeInternals.appendLedgerLine(
				args.directory,
				`${JSON.stringify(record)}\n`,
				record.ledgerSegment,
			);
		} catch (error) {
			try {
				const committed = readVerifiedLedgerRecords(
					args.directory,
					args.maxReplayRecords,
				).records.some((item) => item.hashAfter === record.hashAfter);
				if (committed) {
					const retention = await reconcileHarnessPhysicalRetentionUnderLock({
						directory: args.directory,
						current: buildCurrentProjectionFromRecord(record),
						maxReplayRecords: args.maxReplayRecords,
						maxInactiveCandidates: args.maxInactiveCandidates,
					});
					return {
						status: 'recorded',
						candidate: args.candidate,
						retentionReconciled: retention.reconciled,
						retentionFailures: retention.failures,
					};
				}
			} catch (verificationError) {
				if (verificationError instanceof HarnessReplayBoundExceededError) {
					throw verificationError;
				}
				// Fall through to quarantine when commitment cannot be proven exactly.
			}
			const quarantineDir = path.join(
				rootDir(args.directory),
				'orphaned-candidates',
			);
			mkdirSync(quarantineDir, { recursive: true });
			try {
				renameSync(
					path.dirname(target),
					path.join(
						quarantineDir,
						`${args.candidate.candidate.candidateId}.${Date.now()}.orphan`,
					),
				);
				pruneOrphanArtifacts(quarantineDir);
			} catch {
				throw new HarnessStoreIntegrityError(
					target,
					'failed to quarantine uncommitted candidate',
				);
			}
			throw error;
		}
		try {
			await _storeInternals.writeCurrentProjection(
				args.directory,
				buildCurrentProjectionFromRecord(record),
			);
		} catch {
			// Candidate records are committed by the ledger append. current.json can
			// be reconciled later from the exact ledger head.
		}
		const retention = await reconcileHarnessPhysicalRetentionUnderLock({
			directory: args.directory,
			current: buildCurrentProjectionFromRecord(record),
			maxReplayRecords: args.maxReplayRecords,
			maxInactiveCandidates: args.maxInactiveCandidates,
		});
		return {
			status: 'recorded',
			candidate: args.candidate,
			retentionReconciled: retention.reconciled,
			retentionFailures: retention.failures,
		};
	});
}

export async function saveHarnessVersion(args: {
	directory: string;
	version: HarnessVersionV1;
}): Promise<SaveHarnessVersionResult> {
	assertProjectRoot(args.directory);
	return withHarnessLock(args.directory, async () =>
		saveHarnessVersionUnderLock(args.directory, args.version),
	);
}

export async function loadHarnessCurrent(
	directory: string,
	maxReplayRecords?: number,
): Promise<HarnessCurrentProjectionV1> {
	assertProjectRoot(directory);
	const fast = loadCurrentProjectionFast(directory, maxReplayRecords);
	if (fast) return fast.current;
	return ledgerRecordsToCurrent(
		readVerifiedLedgerRecords(directory, maxReplayRecords).records,
	);
}

/** Explicitly reconcile the derived projection; read paths never mutate state. */
export async function reconcileHarnessCurrent(
	directory: string,
	maxReplayRecords?: number,
): Promise<HarnessCurrentProjectionV1> {
	assertProjectRoot(directory);
	return withHarnessLock(directory, async () => {
		const derived = ledgerRecordsToCurrent(
			readVerifiedLedgerRecords(directory, maxReplayRecords).records,
		);
		await _storeInternals.writeCurrentProjection(directory, derived);
		return derived;
	});
}

export async function loadHarnessCandidate(
	directory: string,
	candidateId: string,
	maxReplayRecords?: number,
): Promise<StoredHarnessCandidateV1 | null> {
	assertProjectRoot(directory);
	const { current, initialTruncated } = loadCurrentForRead(
		directory,
		maxReplayRecords,
	);
	if (
		!candidateCommittedWithinReplayBound(
			directory,
			current,
			candidateId,
			maxReplayRecords,
			initialTruncated,
		)
	) {
		return null;
	}
	return readStoredCandidate(directory, candidateId);
}

export function loadHarnessPromptArtifact(
	directory: string,
	candidateId: string,
	promptHash: string,
): PromptArtifactV1 | null {
	assertProjectRoot(directory);
	const candidate = readStoredCandidate(directory, candidateId);
	if (!candidate) return null;
	if (!candidate.candidate.promptArtifactHashes.includes(promptHash)) {
		return null;
	}
	return readStoredPromptArtifact(directory, candidateId, promptHash);
}

export async function loadHarnessVersion(
	directory: string,
	versionId: string,
): Promise<HarnessVersionV1 | null> {
	assertProjectRoot(directory);
	return readStoredVersion(versionPath(directory, versionId));
}

export async function listHarnessHistory(
	directory: string,
	options?:
		| number
		| {
				maxReplayRecords?: number;
				limit?: number;
		  },
): Promise<HarnessHistoryResult> {
	assertProjectRoot(directory);
	const maxReplayRecords =
		typeof options === 'number' ? options : options?.maxReplayRecords;
	const limit =
		typeof options === 'number'
			? (maxReplayRecords ?? 100)
			: (options?.limit ?? 100);
	const fast = loadCurrentProjectionFast(directory, maxReplayRecords);
	if (fast) {
		return buildHarnessHistoryPage(
			directory,
			fast.current,
			limit,
			maxReplayRecords,
			fast.truncated,
		);
	}
	const scan = readVerifiedLedgerRecords(directory, maxReplayRecords);
	return buildHarnessHistoryPage(
		directory,
		ledgerRecordsToCurrent(scan.records),
		limit,
		maxReplayRecords,
		scan.truncated,
	);
}

export async function auditHarnessLedger(
	directory: string,
	options: {
		maxReplayRecords?: number;
		maxSegments: number;
	},
): Promise<HarnessLedgerAuditResult> {
	assertProjectRoot(directory);
	const segments = countLedgerSegments(directory, options.maxSegments);
	if (segments.exceeded) {
		return {
			outcome: 'scope_exceeded',
			maxSegments: options.maxSegments,
			totalSegments: segments.count,
		};
	}
	try {
		const scan = readVerifiedLedgerRecords(directory, options.maxReplayRecords);
		return {
			outcome: 'ok',
			records: scan.records,
			truncated: scan.truncated,
			quarantinePath: scan.quarantinePath,
			totalSegments: scan.totalSegments,
		};
	} catch (error) {
		if (error instanceof HarnessReplayBoundExceededError) {
			return {
				outcome: 'scope_exceeded',
				maxSegments: options.maxSegments,
				totalSegments: segments.count,
				replayBoundExceeded: true,
				maxReplayRecords: error.maxReplayRecords,
			};
		}
		throw error;
	}
}

export async function recoverHarnessCorruptTail(
	directory: string,
	maxReplayRecords?: number,
): Promise<HarnessHistoryResult> {
	assertProjectRoot(directory);
	return withHarnessLock(directory, async () => {
		const repaired = repairTornLedgerTailUnderLock(
			directory,
			readVerifiedLedgerRecords(directory, maxReplayRecords),
			maxReplayRecords,
		);
		const current = ledgerRecordsToCurrent(repaired.records);
		await _storeInternals.writeCurrentProjection(directory, current);
		const retention = await reconcileHarnessPhysicalRetentionUnderLock({
			directory,
			current,
			maxReplayRecords,
			initialTruncated: repaired.truncated,
		});
		return buildHarnessHistoryPage(
			directory,
			retention.current,
			Math.min(100, maxReplayRecords ?? 100),
			maxReplayRecords,
			repaired.truncated,
		);
	});
}

export async function activateHarnessCandidate(args: {
	directory: string;
	candidateId: string;
	consumerSessionId: string;
	targetSessionId?: string;
	expectedCurrentHash: string | null;
	expectedCurrentGeneration: number;
	targetContentHash: string;
	allowedPathDigest: string;
	maxVersions?: number;
	maxReplayRecords?: number;
	maxInactiveCandidates?: number;
}): Promise<ActivateHarnessCandidateResult> {
	assertProjectRoot(args.directory);
	return withHarnessLock(args.directory, async () => {
		const { current, initialTruncated } = loadCurrentForMutation(
			args.directory,
			args.maxReplayRecords,
		);
		const stored = readStoredCandidate(args.directory, args.candidateId);
		if (!stored) {
			return {
				status: 'candidate_not_found',
				reason: `candidate ${args.candidateId} not found`,
			};
		}
		if (!stored.targetBlueprint) {
			return {
				status: 'candidate_not_activatable',
				reason: 'candidate has no validated target harness blueprint',
			};
		}
		if (
			!candidateCommittedWithinReplayBound(
				args.directory,
				current,
				args.candidateId,
				args.maxReplayRecords,
				initialTruncated,
			)
		) {
			return {
				status: 'candidate_not_found',
				reason: `candidate ${args.candidateId} is not committed`,
			};
		}
		quarantineOrphanVersionsByIdSet(
			args.directory,
			collectAccessibleVersionIds(args.directory, current),
		);
		const expectedAllowedPathDigest = computeAllowedPathDigest(
			stored.candidate.approvedPaths,
		);
		if (
			!currentMatchesExpected(
				current,
				args.expectedCurrentHash,
				args.expectedCurrentGeneration,
			)
		) {
			return {
				status: 'stale_current',
				reason: 'current harness state changed before activation',
			};
		}
		if (
			args.targetContentHash !== stored.candidate.manifestHash ||
			args.allowedPathDigest !== expectedAllowedPathDigest
		) {
			return {
				status: 'approval_required',
				reason:
					'activation approval binding no longer matches the stored candidate content or paths',
			};
		}
		const targetSessionId = args.targetSessionId ?? args.consumerSessionId;
		if (targetSessionId !== args.consumerSessionId) {
			return {
				status: 'consumer_mismatch',
				reason: `approval targets ${targetSessionId}, not ${args.consumerSessionId}`,
			};
		}
		const request = buildHarnessActivationApprovalRequest({
			targetSessionId,
			candidate: stored,
			expectedCurrentHash: args.expectedCurrentHash,
			expectedCurrentGeneration: args.expectedCurrentGeneration,
			targetContentHash: args.targetContentHash,
			allowedPathDigest: args.allowedPathDigest,
		});
		const activeFact = await findWriteApprovalFact({
			directory: args.directory,
			request,
		});
		if (!activeFact) {
			return {
				status: 'approval_required',
				reason: 'harness activation requires an exact human write approval',
			};
		}
		if (
			approvalFactAlreadyCommittedWithinReplayBound(
				args.directory,
				current,
				activeFact.id,
				args.maxReplayRecords,
				initialTruncated,
			)
		) {
			return {
				status: 'approval_required',
				reason:
					'activation approval fact is already committed in harness history',
			};
		}
		const fact = await consumeWriteApprovalFact({
			directory: args.directory,
			request,
			consumerSessionId: args.consumerSessionId,
			expectedFactId: activeFact.id,
		});
		if (!fact) {
			return {
				status: 'approval_required',
				reason: 'harness activation requires an exact human write approval',
			};
		}
		const version: HarnessVersionV1 = {
			v: STORE_VERSION,
			versionId: randomUUID(),
			candidateId: stored.candidate.candidateId,
			manifestHash: stored.candidate.manifestHash,
			allowedPathDigest: args.allowedPathDigest,
			generation: current.generation + 1,
			sourceKind: 'activation',
			parentVersionId: current.currentVersionId,
			restoredFromVersionId: null,
			approvalFactId: fact.id,
			blueprint: stored.targetBlueprint,
			recordedAt: new Date().toISOString(),
		};
		const savedVersion = await saveHarnessVersionUnderLock(
			args.directory,
			version,
		);
		if (savedVersion.status !== 'saved') {
			throw new HarnessStoreIntegrityError(
				versionPath(args.directory, version.versionId),
				savedVersion.reason,
			);
		}
		const nextVersionIds = [...current.versionIds, version.versionId];
		const survivingVersionIds = selectRetainedVersionIds(
			args.directory,
			nextVersionIds,
			args.maxVersions ?? 100,
		);
		if (survivingVersionIds.status !== 'ok') {
			discardUncommittedVersion(args.directory, version.versionId);
			return survivingVersionIds;
		}
		const prunedVersionIds = nextVersionIds.filter(
			(id) => !survivingVersionIds.versionIds.includes(id),
		);
		const nextCurrent = buildCurrentProjection(
			version.versionId,
			version.candidateId,
			version.manifestHash,
			version.generation,
			survivingVersionIds.versionIds,
			version.recordedAt,
		);
		const record = buildLedgerRecord({
			directory: args.directory,
			current,
			nextCurrent,
			kind: 'activated',
			candidateId: version.candidateId,
			versionId: version.versionId,
			parentVersionId: version.parentVersionId,
			restoredFromVersionId: version.restoredFromVersionId,
			approvalFactId: fact.id,
			payloadHash: version.manifestHash,
			prunedVersionIds,
		});
		appendLedgerRecordWithCommitRecovery(
			args.directory,
			record,
			args.maxReplayRecords,
		);
		const committedCurrent = buildCurrentProjectionFromRecord(record);
		let projectionReconciled = true;
		try {
			await _storeInternals.writeCurrentProjection(
				args.directory,
				committedCurrent,
			);
		} catch {
			// The fsynced ledger record is the commit point. current.json is a
			// derived projection and can be repaired explicitly from verified replay.
			projectionReconciled = false;
		}
		const prunedArtifactFailures = removePrunedVersionArtifacts(
			args.directory,
			prunedVersionIds,
		);
		const retention = await reconcileHarnessPhysicalRetentionUnderLock({
			directory: args.directory,
			current: committedCurrent,
			maxReplayRecords: args.maxReplayRecords,
			maxInactiveCandidates: args.maxInactiveCandidates,
		});
		return {
			status: 'activated',
			version,
			current: retention.current,
			projectionReconciled,
			prunedArtifactsReconciled: prunedArtifactFailures.length === 0,
			prunedArtifactFailures,
			retentionReconciled: retention.reconciled,
			retentionFailures: retention.failures,
		};
	});
}

export async function rollbackHarnessVersion(args: {
	directory: string;
	targetVersionId: string;
	consumerSessionId: string;
	targetSessionId?: string;
	expectedCurrentHash: string;
	expectedCurrentGeneration: number;
	targetContentHash: string;
	allowedPathDigest: string;
	maxVersions?: number;
	maxReplayRecords?: number;
	maxInactiveCandidates?: number;
}): Promise<RollbackHarnessVersionResult> {
	assertProjectRoot(args.directory);
	return withHarnessLock(args.directory, async () => {
		const { current, initialTruncated } = loadCurrentForMutation(
			args.directory,
			args.maxReplayRecords,
		);
		const accessibleVersionIds = collectAccessibleVersionIds(
			args.directory,
			current,
		);
		quarantineOrphanVersionsByIdSet(args.directory, accessibleVersionIds);
		if (
			!currentMatchesExpected(
				current,
				args.expectedCurrentHash,
				args.expectedCurrentGeneration,
			)
		) {
			return {
				status: 'stale_current',
				reason: 'current harness state changed before rollback',
			};
		}
		if (!current.currentVersionId) {
			return {
				status: 'version_not_found',
				reason: 'no current harness version is active',
			};
		}
		const targetVersion = readStoredVersion(
			versionPath(args.directory, args.targetVersionId),
		);
		if (!targetVersion) {
			return {
				status: 'version_not_found',
				reason: `target version ${args.targetVersionId} not found`,
			};
		}
		if (!accessibleVersionIds.has(args.targetVersionId)) {
			return {
				status: 'version_not_found',
				reason: `target version ${args.targetVersionId} is not committed`,
			};
		}
		if (
			args.targetContentHash !== targetVersion.manifestHash ||
			args.allowedPathDigest !== targetVersion.allowedPathDigest
		) {
			return {
				status: 'approval_required',
				reason:
					'rollback approval binding no longer matches the stored target version content or paths',
			};
		}
		const targetSessionId = args.targetSessionId ?? args.consumerSessionId;
		if (targetSessionId !== args.consumerSessionId) {
			return {
				status: 'consumer_mismatch',
				reason: `approval targets ${targetSessionId}, not ${args.consumerSessionId}`,
			};
		}
		const request = buildHarnessRollbackApprovalRequest({
			targetSessionId,
			currentVersionId: current.currentVersionId,
			targetVersionId: targetVersion.versionId,
			expectedCurrentHash: args.expectedCurrentHash,
			expectedCurrentGeneration: args.expectedCurrentGeneration,
			targetContentHash: args.targetContentHash,
			allowedPathDigest: args.allowedPathDigest,
		});
		const activeFact = await findWriteApprovalFact({
			directory: args.directory,
			request,
		});
		if (!activeFact) {
			return {
				status: 'approval_required',
				reason: 'harness rollback requires an exact human write approval',
			};
		}
		if (
			approvalFactAlreadyCommittedWithinReplayBound(
				args.directory,
				current,
				activeFact.id,
				args.maxReplayRecords,
				initialTruncated,
			)
		) {
			return {
				status: 'approval_required',
				reason:
					'rollback approval fact is already committed in harness history',
			};
		}
		const fact = await consumeWriteApprovalFact({
			directory: args.directory,
			request,
			consumerSessionId: args.consumerSessionId,
			expectedFactId: activeFact.id,
		});
		if (!fact) {
			return {
				status: 'approval_required',
				reason: 'harness rollback requires an exact human write approval',
			};
		}
		const version: HarnessVersionV1 = {
			v: STORE_VERSION,
			versionId: randomUUID(),
			candidateId: targetVersion.candidateId,
			manifestHash: targetVersion.manifestHash,
			allowedPathDigest: args.allowedPathDigest,
			generation: current.generation + 1,
			sourceKind: 'rollback',
			parentVersionId: current.currentVersionId,
			restoredFromVersionId: targetVersion.versionId,
			approvalFactId: fact.id,
			blueprint: targetVersion.blueprint,
			recordedAt: new Date().toISOString(),
		};
		const savedVersion = await saveHarnessVersionUnderLock(
			args.directory,
			version,
		);
		if (savedVersion.status !== 'saved') {
			throw new HarnessStoreIntegrityError(
				versionPath(args.directory, version.versionId),
				savedVersion.reason,
			);
		}
		const nextVersionIds = [...current.versionIds, version.versionId];
		const survivingVersionIds = selectRetainedVersionIds(
			args.directory,
			nextVersionIds,
			args.maxVersions ?? 100,
		);
		if (survivingVersionIds.status !== 'ok') {
			discardUncommittedVersion(args.directory, version.versionId);
			return survivingVersionIds;
		}
		const prunedVersionIds = nextVersionIds.filter(
			(id) => !survivingVersionIds.versionIds.includes(id),
		);
		const nextCurrent = buildCurrentProjection(
			version.versionId,
			version.candidateId,
			version.manifestHash,
			version.generation,
			survivingVersionIds.versionIds,
			version.recordedAt,
		);
		const record = buildLedgerRecord({
			directory: args.directory,
			current,
			nextCurrent,
			kind: 'rolled_back',
			candidateId: version.candidateId,
			versionId: version.versionId,
			parentVersionId: version.parentVersionId,
			restoredFromVersionId: version.restoredFromVersionId,
			approvalFactId: fact.id,
			payloadHash: version.manifestHash,
			prunedVersionIds,
		});
		appendLedgerRecordWithCommitRecovery(
			args.directory,
			record,
			args.maxReplayRecords,
		);
		const committedCurrent = buildCurrentProjectionFromRecord(record);
		let projectionReconciled = true;
		try {
			await _storeInternals.writeCurrentProjection(
				args.directory,
				committedCurrent,
			);
		} catch {
			projectionReconciled = false;
		}
		const prunedArtifactFailures = removePrunedVersionArtifacts(
			args.directory,
			prunedVersionIds,
		);
		const retention = await reconcileHarnessPhysicalRetentionUnderLock({
			directory: args.directory,
			current: committedCurrent,
			maxReplayRecords: args.maxReplayRecords,
			maxInactiveCandidates: args.maxInactiveCandidates,
		});
		return {
			status: 'rolled_back',
			version,
			current: retention.current,
			projectionReconciled,
			prunedArtifactsReconciled: prunedArtifactFailures.length === 0,
			prunedArtifactFailures,
			retentionReconciled: retention.reconciled,
			retentionFailures: retention.failures,
		};
	});
}

export const _storeInternals: {
	appendLedgerLine: typeof appendLedgerLine;
	writeCurrentProjection: typeof writeCurrentProjection;
	removeVersionArtifact: typeof removeVersionArtifact;
	removeCandidateArtifact: typeof removeCandidateArtifact;
	removeLedgerArtifact: typeof removeLedgerArtifact;
} = {
	appendLedgerLine,
	writeCurrentProjection,
	removeVersionArtifact,
	removeCandidateArtifact,
	removeLedgerArtifact,
};
