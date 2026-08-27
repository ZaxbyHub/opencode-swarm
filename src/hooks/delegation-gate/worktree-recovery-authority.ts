import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSwarmFileSync } from '../../utils/atomic-write';

const STORE_RELATIVE_PATH = path.join(
	'.swarm',
	'worktree-merge-recovery-v2.json',
);
const JOURNAL_RELATIVE_PATH = path.join(
	'.swarm',
	'worktree-merge-recovery-v2-journal.json',
);
const CREDENTIAL_DIRECTORY = path.join('.swarm', 'worktree-recovery-claims');
const AUTHORITY_LOCK_RELATIVE_PATH = path.join(
	'.swarm',
	'locks',
	'worktree-recovery-authority.lock',
);
const AUTHORITY_LOCK_STALE_MS = 10 * 60_000;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_STORE_AUTHORITIES = 512;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 512;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const DEFAULT_MAX_ATTEMPTS = 8;
const HEX_40_RE = /^[0-9a-f]{40}$/i;

export const WORKTREE_RECOVERY_MUTATOR_NAMES = [
	'publish',
	'claim',
	'renew',
	'release',
	'finalize',
	'replay',
] as const;

export type WorktreeRecoveryMutatorName =
	(typeof WORKTREE_RECOVERY_MUTATOR_NAMES)[number];

export type WorktreeRecoveryStrategy = 'merge' | 'rebase' | 'cherry-pick';
export type WorktreeRecoveryStatus =
	| 'preserved'
	| 'claimed'
	| 'released'
	| 'finalized';
export type WorktreeRecoveryJournalState =
	| 'PREPARED'
	| 'COMMITTED'
	| 'ABORTED'
	| 'RELEASED'
	| 'FINALIZED';

export interface WorktreeRecoveryImmutableIdentityInput {
	originalCallID: string;
	parentSessionId: string;
	taskId: string;
	reservationId: string;
	generation: number;
	canonicalBranch: string;
	canonicalPath: string;
	laneBranch: string;
	lanePath: string;
	expectedPrimaryHead: string;
	sourceBaseOid: string;
	sourceHeadOid: string;
	targetHeadOid: string;
	strategy: WorktreeRecoveryStrategy;
	declaredConflictFiles?: string[];
}

export interface WorktreeRecoveryImmutableIdentity
	extends WorktreeRecoveryImmutableIdentityInput {
	createdAt: number;
}

export interface WorktreeRecoveryClaimState {
	claimantCallID: string;
	claimantSessionId: string;
	childSessionId: string;
	claimRevision: number;
	attempt: number;
	leaseExpiresAt: number;
	claimTokenDigest: string;
	claimedAt: number;
}

export interface WorktreeRecoveryAuthorityRecord {
	schemaVersion: 2;
	authorityDigest: string;
	immutable: WorktreeRecoveryImmutableIdentity;
	status: WorktreeRecoveryStatus;
	claim?: WorktreeRecoveryClaimState;
	claimCursor?: {
		lastClaimRevision: number;
		lastAttempt: number;
	};
	finalizedAt?: number;
	settlement?: {
		sourceCommitOrder: string[];
		rewrittenCommitOrder: string[];
	};
}

interface WorktreeRecoveryStore {
	schemaVersion: 2;
	authorities: WorktreeRecoveryAuthorityRecord[];
	index: {
		bySessionTask: Record<string, string[]>;
	};
}

export interface WorktreeRecoveryClaimJournalEntry {
	schemaVersion: 1;
	authorityDigest: string;
	state: WorktreeRecoveryJournalState;
	claimantCallID: string;
	claimantSessionId: string;
	childSessionId?: string;
	claimRevision: number;
	attempt: number;
	leaseExpiresAt: number;
	claimTokenDigest: string;
	preparedAt: number;
	credentialInstalledAt?: number;
	committedAt?: number;
	abortedAt?: number;
	reason?: string;
}

interface WorktreeRecoveryClaimJournal {
	schemaVersion: 1;
	entries: WorktreeRecoveryClaimJournalEntry[];
}

interface WorktreeRecoveryCredential {
	schemaVersion: 1;
	authorityDigest: string;
	claimantCallID: string;
	claimantSessionId: string;
	childSessionId: string;
	claimRevision: number;
	rawToken: string;
	leaseExpiresAt: number;
	createdAt: number;
}

type ScanStatus = 'ok' | 'unsupported-legacy' | 'uncertain';

export type WorktreeRecoveryScanResult =
	| { status: 'ok'; authorities: WorktreeRecoveryAuthorityRecord[] }
	| { status: 'unsupported-legacy'; reason: string }
	| { status: 'uncertain'; reason: string };

export type WorktreeRecoveryLookupResult =
	| { status: 'ok'; authorities: WorktreeRecoveryAuthorityRecord[] }
	| { status: Exclude<ScanStatus, 'ok'>; reason: string };

type BaseMutationFailureCode =
	| 'not_found'
	| 'busy'
	| 'stale_claim'
	| 'retry_cap_exceeded'
	| 'revalidation_required'
	| 'revalidation_failed'
	| 'unsupported_legacy'
	| 'uncertain_store'
	| 'finalized';

type BaseMutationFailure = {
	ok: false;
	code: BaseMutationFailureCode;
	reason: string;
};

export type PublishWorktreeRecoveryAuthorityResult =
	| { ok: true; authority: WorktreeRecoveryAuthorityRecord }
	| BaseMutationFailure;

export type ClaimWorktreeRecoveryAuthorityResult =
	| {
			ok: true;
			authority: WorktreeRecoveryAuthorityRecord;
			rawToken: string;
			credentialPath: string;
	  }
	| BaseMutationFailure;

export type MutateWorktreeRecoveryClaimResult =
	| { ok: true; authority: WorktreeRecoveryAuthorityRecord }
	| BaseMutationFailure;

export interface ClaimWorktreeRecoveryAuthorityRequest {
	authorityDigest: string;
	claimantCallID: string;
	claimantSessionId: string;
	now?: number;
	leaseMs: number;
	maxAttempts?: number;
	createChildSession: () => string | Promise<string>;
	revalidateExpiredClaim?: (args: {
		authority: WorktreeRecoveryAuthorityRecord;
		previousClaim: WorktreeRecoveryClaimState;
	}) =>
		| { ok: true }
		| { ok: false; reason: string }
		| Promise<{ ok: true } | { ok: false; reason: string }>;
}

interface ExactClaimMutationRequest {
	authorityDigest: string;
	claimantCallID: string;
	claimRevision: number;
	rawToken: string;
	now?: number;
}

export interface FinalizeWorktreeRecoveryAuthorityRequest
	extends ExactClaimMutationRequest {
	settlement?: {
		sourceCommitOrder: string[];
		rewrittenCommitOrder: string[];
	};
}

export interface ReplayPreparedClaimOptions {
	onAbortPreparedClaim?: (entry: WorktreeRecoveryClaimJournalEntry) => void;
}

export interface ReplayPreparedClaimOutcome {
	authorityDigest: string;
	outcome:
		| 'aborted_prepared_claim'
		| 'removed_uncommitted_credential'
		| 'committed_claim_stable'
		| 'released_orphaned_committed_claim'
		| 'repaired_terminal_claim'
		| 'uncertain_committed_without_authority'
		| 'noop';
}

function nowMs(input?: number): number {
	return input ?? Date.now();
}

function sha256(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

function storePath(directory: string): string {
	return path.join(directory, STORE_RELATIVE_PATH);
}

function journalPath(directory: string): string {
	return path.join(directory, JOURNAL_RELATIVE_PATH);
}

function credentialPath(directory: string, authorityDigest: string): string {
	return path.join(directory, CREDENTIAL_DIRECTORY, `${authorityDigest}.json`);
}

function acquireAuthorityLock(directory: string): (() => void) | undefined {
	const lockPath = path.join(directory, AUTHORITY_LOCK_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const attempt = (): number | undefined => {
		try {
			return fs.openSync(lockPath, 'wx');
		} catch {
			return undefined;
		}
	};
	let descriptor = attempt();
	if (descriptor === undefined) {
		try {
			if (
				Date.now() - fs.statSync(lockPath).mtimeMs >
				AUTHORITY_LOCK_STALE_MS
			) {
				fs.unlinkSync(lockPath);
				descriptor = attempt();
			}
		} catch {
			return undefined;
		}
	}
	if (descriptor === undefined) return undefined;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			fs.closeSync(descriptor);
		} finally {
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// A missing lock is already released; other failures remain bounded.
			}
		}
	};
}

function taskKey(parentSessionId: string, taskId: string): string {
	return `${parentSessionId}::${taskId}`;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([left], [right]) => left.localeCompare(right),
		);
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function digestAuthorityIdentity(
	input: WorktreeRecoveryImmutableIdentityInput,
): string {
	return sha256(
		stableStringify({
			originalCallID: input.originalCallID,
			parentSessionId: input.parentSessionId,
			taskId: input.taskId,
			reservationId: input.reservationId,
			generation: input.generation,
			canonicalBranch: input.canonicalBranch,
			canonicalPath: input.canonicalPath,
			laneBranch: input.laneBranch,
			lanePath: input.lanePath,
			expectedPrimaryHead: input.expectedPrimaryHead,
			sourceBaseOid: input.sourceBaseOid,
			sourceHeadOid: input.sourceHeadOid,
			targetHeadOid: input.targetHeadOid,
			strategy: input.strategy,
			declaredConflictFiles: input.declaredConflictFiles ?? [],
		}),
	);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function isHex40(value: unknown): value is string {
	return typeof value === 'string' && HEX_40_RE.test(value);
}

function isOidArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 4096 && value.every(isHex40);
}

function isSettlementEvidence(
	value: unknown,
): value is NonNullable<WorktreeRecoveryAuthorityRecord['settlement']> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		isOidArray(candidate.sourceCommitOrder) &&
		isOidArray(candidate.rewrittenCommitOrder) &&
		candidate.sourceCommitOrder.length === candidate.rewrittenCommitOrder.length
	);
}

function isStrategy(value: unknown): value is WorktreeRecoveryStrategy {
	return value === 'merge' || value === 'rebase' || value === 'cherry-pick';
}

function isImmutableIdentity(
	value: unknown,
): value is WorktreeRecoveryImmutableIdentity {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		nonEmpty(candidate.originalCallID) &&
		nonEmpty(candidate.parentSessionId) &&
		nonEmpty(candidate.taskId) &&
		nonEmpty(candidate.reservationId) &&
		typeof candidate.generation === 'number' &&
		Number.isInteger(candidate.generation) &&
		candidate.generation > 0 &&
		nonEmpty(candidate.canonicalBranch) &&
		nonEmpty(candidate.canonicalPath) &&
		nonEmpty(candidate.laneBranch) &&
		nonEmpty(candidate.lanePath) &&
		isHex40(candidate.expectedPrimaryHead) &&
		isHex40(candidate.sourceBaseOid) &&
		isHex40(candidate.sourceHeadOid) &&
		isHex40(candidate.targetHeadOid) &&
		isStrategy(candidate.strategy) &&
		(candidate.declaredConflictFiles === undefined ||
			(Array.isArray(candidate.declaredConflictFiles) &&
				candidate.declaredConflictFiles.every((item) => nonEmpty(item)))) &&
		typeof candidate.createdAt === 'number' &&
		Number.isFinite(candidate.createdAt) &&
		candidate.createdAt >= 0
	);
}

function isClaimState(value: unknown): value is WorktreeRecoveryClaimState {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		nonEmpty(candidate.claimantCallID) &&
		nonEmpty(candidate.claimantSessionId) &&
		nonEmpty(candidate.childSessionId) &&
		typeof candidate.claimRevision === 'number' &&
		Number.isInteger(candidate.claimRevision) &&
		candidate.claimRevision > 0 &&
		typeof candidate.attempt === 'number' &&
		Number.isInteger(candidate.attempt) &&
		candidate.attempt > 0 &&
		typeof candidate.leaseExpiresAt === 'number' &&
		Number.isFinite(candidate.leaseExpiresAt) &&
		candidate.leaseExpiresAt >= 0 &&
		nonEmpty(candidate.claimTokenDigest) &&
		typeof candidate.claimedAt === 'number' &&
		Number.isFinite(candidate.claimedAt) &&
		candidate.claimedAt >= 0
	);
}

function isAuthority(value: unknown): value is WorktreeRecoveryAuthorityRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	const claimCursor =
		candidate.claimCursor && typeof candidate.claimCursor === 'object'
			? (candidate.claimCursor as Record<string, unknown>)
			: undefined;
	const validStatus =
		candidate.status === 'preserved' ||
		candidate.status === 'claimed' ||
		candidate.status === 'released' ||
		candidate.status === 'finalized';
	return (
		candidate.schemaVersion === 2 &&
		nonEmpty(candidate.authorityDigest) &&
		isImmutableIdentity(candidate.immutable) &&
		validStatus &&
		(candidate.claim === undefined || isClaimState(candidate.claim)) &&
		(claimCursor === undefined ||
			(typeof claimCursor.lastClaimRevision === 'number' &&
				Number.isInteger(claimCursor.lastClaimRevision) &&
				claimCursor.lastClaimRevision > 0 &&
				typeof claimCursor.lastAttempt === 'number' &&
				Number.isInteger(claimCursor.lastAttempt) &&
				claimCursor.lastAttempt > 0)) &&
		(candidate.status !== 'claimed' || candidate.claim !== undefined) &&
		(candidate.finalizedAt === undefined ||
			(typeof candidate.finalizedAt === 'number' &&
				Number.isFinite(candidate.finalizedAt) &&
				candidate.finalizedAt >= 0)) &&
		(candidate.settlement === undefined ||
			isSettlementEvidence(candidate.settlement))
	);
}

function isJournalEntry(
	value: unknown,
): value is WorktreeRecoveryClaimJournalEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	const validState =
		candidate.state === 'PREPARED' ||
		candidate.state === 'COMMITTED' ||
		candidate.state === 'ABORTED' ||
		candidate.state === 'RELEASED' ||
		candidate.state === 'FINALIZED';
	return (
		candidate.schemaVersion === 1 &&
		nonEmpty(candidate.authorityDigest) &&
		validState &&
		nonEmpty(candidate.claimantCallID) &&
		nonEmpty(candidate.claimantSessionId) &&
		(candidate.childSessionId === undefined ||
			nonEmpty(candidate.childSessionId)) &&
		typeof candidate.claimRevision === 'number' &&
		Number.isInteger(candidate.claimRevision) &&
		candidate.claimRevision > 0 &&
		typeof candidate.attempt === 'number' &&
		Number.isInteger(candidate.attempt) &&
		candidate.attempt > 0 &&
		typeof candidate.leaseExpiresAt === 'number' &&
		Number.isFinite(candidate.leaseExpiresAt) &&
		candidate.leaseExpiresAt >= 0 &&
		nonEmpty(candidate.claimTokenDigest) &&
		typeof candidate.preparedAt === 'number' &&
		Number.isFinite(candidate.preparedAt) &&
		candidate.preparedAt >= 0 &&
		(candidate.credentialInstalledAt === undefined ||
			(typeof candidate.credentialInstalledAt === 'number' &&
				Number.isFinite(candidate.credentialInstalledAt) &&
				candidate.credentialInstalledAt >= 0)) &&
		(candidate.committedAt === undefined ||
			(typeof candidate.committedAt === 'number' &&
				Number.isFinite(candidate.committedAt) &&
				candidate.committedAt >= 0)) &&
		(candidate.abortedAt === undefined ||
			(typeof candidate.abortedAt === 'number' &&
				Number.isFinite(candidate.abortedAt) &&
				candidate.abortedAt >= 0)) &&
		(candidate.reason === undefined || nonEmpty(candidate.reason))
	);
}

function isCredential(value: unknown): value is WorktreeRecoveryCredential {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.schemaVersion === 1 &&
		nonEmpty(candidate.authorityDigest) &&
		nonEmpty(candidate.claimantCallID) &&
		nonEmpty(candidate.claimantSessionId) &&
		nonEmpty(candidate.childSessionId) &&
		typeof candidate.claimRevision === 'number' &&
		Number.isInteger(candidate.claimRevision) &&
		candidate.claimRevision > 0 &&
		nonEmpty(candidate.rawToken) &&
		typeof candidate.leaseExpiresAt === 'number' &&
		Number.isFinite(candidate.leaseExpiresAt) &&
		candidate.leaseExpiresAt >= 0 &&
		typeof candidate.createdAt === 'number' &&
		Number.isFinite(candidate.createdAt) &&
		candidate.createdAt >= 0
	);
}

function rebuildIndex(
	authorities: WorktreeRecoveryAuthorityRecord[],
): WorktreeRecoveryStore['index'] {
	const bySessionTask: Record<string, string[]> = {};
	for (const authority of [...authorities].sort(
		(left, right) =>
			right.immutable.generation - left.immutable.generation ||
			right.immutable.createdAt - left.immutable.createdAt,
	)) {
		const key = taskKey(
			authority.immutable.parentSessionId,
			authority.immutable.taskId,
		);
		const digests = bySessionTask[key] ?? [];
		digests.push(authority.authorityDigest);
		bySessionTask[key] = digests;
	}
	return { bySessionTask };
}

function emptyJournal(): WorktreeRecoveryClaimJournal {
	return { schemaVersion: 1, entries: [] };
}

function readBoundedJsonFile<T>(
	filePath: string,
	maxBytes: number,
): { ok: true; value: T } | { ok: false; reason: string } {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > maxBytes) {
			return {
				ok: false,
				reason: `${path.basename(filePath)} exceeds the ${maxBytes}-byte safety bound`,
			};
		}
		const raw = fs.readFileSync(filePath, 'utf8');
		if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
			return {
				ok: false,
				reason: `${path.basename(filePath)} changed beyond the ${maxBytes}-byte safety bound`,
			};
		}
		return { ok: true, value: JSON.parse(raw) as T };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { ok: true, value: undefined as T };
		}
		return {
			ok: false,
			reason: `${path.basename(filePath)} is unreadable or malformed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

function loadStoreStrict(directory: string): WorktreeRecoveryScanResult {
	const loaded = readBoundedJsonFile<unknown>(
		storePath(directory),
		MAX_STORE_BYTES,
	);
	if (!loaded.ok) return { status: 'uncertain', reason: loaded.reason };
	if (loaded.value === undefined) return { status: 'ok', authorities: [] };
	const parsed = loaded.value as Record<string, unknown>;
	if (parsed.schemaVersion === 1) {
		return {
			status: 'unsupported-legacy',
			reason: 'worktree recovery v1 records are unsupported for claim mutation',
		};
	}
	if (parsed.schemaVersion !== 2) {
		return {
			status: 'uncertain',
			reason: `unknown worktree recovery schema version: ${String(parsed.schemaVersion)}`,
		};
	}
	if (!Array.isArray(parsed.authorities)) {
		return {
			status: 'uncertain',
			reason: 'worktree recovery store does not contain an authorities array',
		};
	}
	if (parsed.authorities.length > MAX_STORE_AUTHORITIES) {
		return {
			status: 'uncertain',
			reason: `worktree recovery authority count exceeds the ${MAX_STORE_AUTHORITIES}-record safety bound`,
		};
	}
	for (const authority of parsed.authorities) {
		if (!isAuthority(authority)) {
			return {
				status: 'uncertain',
				reason: 'worktree recovery store contains an invalid authority record',
			};
		}
	}
	return {
		status: 'ok',
		authorities: [...(parsed.authorities as WorktreeRecoveryAuthorityRecord[])],
	};
}

function loadStoreWritable(
	directory: string,
): WorktreeRecoveryStore | BaseMutationFailure {
	const scanned = loadStoreStrict(directory);
	if (scanned.status === 'unsupported-legacy') {
		return {
			ok: false,
			code: 'unsupported_legacy',
			reason: scanned.reason,
		};
	}
	if (scanned.status === 'uncertain') {
		return {
			ok: false,
			code: 'uncertain_store',
			reason: scanned.reason,
		};
	}
	return {
		schemaVersion: 2,
		authorities: scanned.authorities,
		index: rebuildIndex(scanned.authorities),
	};
}

function loadJournal(directory: string): WorktreeRecoveryClaimJournal {
	const loaded = readBoundedJsonFile<unknown>(
		journalPath(directory),
		MAX_JOURNAL_BYTES,
	);
	if (!loaded.ok || loaded.value === undefined) return emptyJournal();
	const parsed = loaded.value as Record<string, unknown>;
	if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
		return emptyJournal();
	}
	const entries: WorktreeRecoveryClaimJournalEntry[] = [];
	for (const entry of parsed.entries) {
		if (isJournalEntry(entry)) entries.push(entry);
	}
	return {
		schemaVersion: 1,
		entries: entries.slice(-MAX_JOURNAL_ENTRIES),
	};
}

function updateStore(
	store: WorktreeRecoveryStore,
	authorities: WorktreeRecoveryAuthorityRecord[],
): WorktreeRecoveryStore {
	store.authorities = authorities;
	store.index = rebuildIndex(authorities);
	return store;
}

function currentClaimMatches(
	authority: WorktreeRecoveryAuthorityRecord,
	request: ExactClaimMutationRequest,
): boolean {
	if (!authority.claim) return false;
	return (
		authority.claim.claimantCallID === request.claimantCallID &&
		authority.claim.claimRevision === request.claimRevision &&
		authority.claim.claimTokenDigest === sha256(request.rawToken)
	);
}

function latestJournalEntriesByAuthority(
	journal: WorktreeRecoveryClaimJournal,
): WorktreeRecoveryClaimJournalEntry[] {
	const latest = new Map<string, WorktreeRecoveryClaimJournalEntry>();
	for (const entry of journal.entries) {
		latest.set(entry.authorityDigest, entry);
	}
	return [...latest.values()];
}

function recordJournalEntry(
	directory: string,
	entry: WorktreeRecoveryClaimJournalEntry,
): WorktreeRecoveryClaimJournal {
	const journal = loadJournal(directory);
	journal.entries.push(entry);
	if (journal.entries.length > MAX_JOURNAL_ENTRIES) {
		journal.entries = journal.entries.slice(-MAX_JOURNAL_ENTRIES);
	}
	_internals.writeClaimJournal(journalPath(directory), journal);
	return journal;
}

function writeCredential(
	directory: string,
	credential: WorktreeRecoveryCredential,
): string {
	const targetPath = credentialPath(directory, credential.authorityDigest);
	_internals.writeCredentialFile(targetPath, credential);
	try {
		fs.chmodSync(targetPath, 0o600);
	} catch {
		// best-effort on platforms/filesystems without chmod semantics
	}
	return targetPath;
}

function readCredential(
	directory: string,
	authorityDigest: string,
): WorktreeRecoveryCredential | undefined {
	const loaded = readBoundedJsonFile<unknown>(
		credentialPath(directory, authorityDigest),
		MAX_CREDENTIAL_BYTES,
	);
	if (!loaded.ok || loaded.value === undefined) return undefined;
	return isCredential(loaded.value) ? loaded.value : undefined;
}

function removeCredentialIfMatch(
	directory: string,
	entry: {
		authorityDigest: string;
		claimRevision: number;
		claimantCallID: string;
	},
): void {
	const credential = readCredential(directory, entry.authorityDigest);
	if (
		credential &&
		credential.claimRevision === entry.claimRevision &&
		credential.claimantCallID === entry.claimantCallID
	) {
		try {
			fs.unlinkSync(credentialPath(directory, entry.authorityDigest));
		} catch {
			// best-effort cleanup only
		}
	}
}

function baseMutationFailure(
	code: BaseMutationFailureCode,
	reason: string,
): BaseMutationFailure {
	return { ok: false, code, reason };
}

function publishWorktreeRecoveryAuthorityUnlocked(
	directory: string,
	input: WorktreeRecoveryImmutableIdentityInput,
): PublishWorktreeRecoveryAuthorityResult {
	const store = loadStoreWritable(directory);
	if ('ok' in store) return store;
	const immutable: WorktreeRecoveryImmutableIdentity = {
		...input,
		createdAt: nowMs(),
	};
	if (!isImmutableIdentity(immutable)) {
		return baseMutationFailure(
			'uncertain_store',
			'invalid immutable recovery authority input',
		);
	}
	const authorityDigest = digestAuthorityIdentity(input);
	const existing = store.authorities.find(
		(authority) => authority.authorityDigest === authorityDigest,
	);
	if (existing) return { ok: true, authority: existing };
	const authority: WorktreeRecoveryAuthorityRecord = {
		schemaVersion: 2,
		authorityDigest,
		immutable,
		status: 'preserved',
	};
	const nextAuthorities = [...store.authorities, authority];
	if (nextAuthorities.length > MAX_STORE_AUTHORITIES) {
		return baseMutationFailure(
			'uncertain_store',
			`worktree recovery authority count exceeds the ${MAX_STORE_AUTHORITIES}-record safety bound`,
		);
	}
	_internals.writeRecoveryStore(
		storePath(directory),
		updateStore(store, nextAuthorities),
		'publish',
	);
	return { ok: true, authority };
}

export function publishWorktreeRecoveryAuthority(
	directory: string,
	input: WorktreeRecoveryImmutableIdentityInput,
): PublishWorktreeRecoveryAuthorityResult {
	const release = acquireAuthorityLock(directory);
	if (!release) {
		return baseMutationFailure(
			'busy',
			'worktree recovery authority store is locked',
		);
	}
	try {
		return publishWorktreeRecoveryAuthorityUnlocked(directory, input);
	} finally {
		release();
	}
}

export function scanWorktreeRecoveryAuthoritiesForRecovery(
	directory: string,
): WorktreeRecoveryScanResult {
	return loadStoreStrict(directory);
}

export function lookupWorktreeRecoveryAuthoritiesByTask(
	directory: string,
	query: { parentSessionId: string; taskId: string },
): WorktreeRecoveryLookupResult {
	const scanned = loadStoreStrict(directory);
	if (scanned.status !== 'ok') return scanned;
	return {
		status: 'ok',
		authorities: scanned.authorities
			.filter(
				(authority) =>
					authority.immutable.parentSessionId === query.parentSessionId &&
					authority.immutable.taskId === query.taskId,
			)
			.sort(
				(left, right) =>
					right.immutable.generation - left.immutable.generation ||
					right.immutable.createdAt - left.immutable.createdAt,
			),
	};
}

async function claimWorktreeRecoveryAuthorityUnlocked(
	directory: string,
	request: ClaimWorktreeRecoveryAuthorityRequest,
): Promise<ClaimWorktreeRecoveryAuthorityResult> {
	const store = loadStoreWritable(directory);
	if ('ok' in store) return store;
	const authorityIndex = store.authorities.findIndex(
		(authority) => authority.authorityDigest === request.authorityDigest,
	);
	if (authorityIndex === -1) {
		return baseMutationFailure(
			'not_found',
			'worktree recovery authority not found',
		);
	}
	const authority = store.authorities[authorityIndex]!;
	if (authority.status === 'finalized') {
		return baseMutationFailure(
			'finalized',
			'finalized worktree recovery authority cannot be claimed again',
		);
	}

	const currentTime = nowMs(request.now);
	const previousClaim = authority.claim;
	if (previousClaim && previousClaim.leaseExpiresAt > currentTime) {
		return baseMutationFailure(
			'busy',
			'worktree recovery authority is already claimed',
		);
	}
	if (previousClaim && previousClaim.leaseExpiresAt <= currentTime) {
		if (!request.revalidateExpiredClaim) {
			return baseMutationFailure(
				'revalidation_required',
				'expired worktree recovery claims require full revalidation before transfer',
			);
		}
		const verdict = await request.revalidateExpiredClaim({
			authority,
			previousClaim,
		});
		if (!verdict.ok) {
			return baseMutationFailure('revalidation_failed', verdict.reason);
		}
	}

	const nextAttempt =
		(previousClaim?.attempt ?? authority.claimCursor?.lastAttempt ?? 0) + 1;
	const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	if (nextAttempt > maxAttempts) {
		return baseMutationFailure(
			'retry_cap_exceeded',
			`worktree recovery claim attempt ${nextAttempt} exceeds the ${maxAttempts}-attempt safety cap`,
		);
	}
	const nextRevision =
		(previousClaim?.claimRevision ??
			authority.claimCursor?.lastClaimRevision ??
			0) + 1;
	const rawToken = _internals.generateRawToken();
	const claimTokenDigest = sha256(rawToken);

	recordJournalEntry(directory, {
		schemaVersion: 1,
		authorityDigest: authority.authorityDigest,
		state: 'PREPARED',
		claimantCallID: request.claimantCallID,
		claimantSessionId: request.claimantSessionId,
		claimRevision: nextRevision,
		attempt: nextAttempt,
		leaseExpiresAt: currentTime + request.leaseMs,
		claimTokenDigest,
		preparedAt: currentTime,
	});

	const childSessionId = await request.createChildSession();
	recordJournalEntry(directory, {
		schemaVersion: 1,
		authorityDigest: authority.authorityDigest,
		state: 'PREPARED',
		claimantCallID: request.claimantCallID,
		claimantSessionId: request.claimantSessionId,
		childSessionId,
		claimRevision: nextRevision,
		attempt: nextAttempt,
		leaseExpiresAt: currentTime + request.leaseMs,
		claimTokenDigest,
		preparedAt: currentTime,
	});

	const credential: WorktreeRecoveryCredential = {
		schemaVersion: 1,
		authorityDigest: authority.authorityDigest,
		claimantCallID: request.claimantCallID,
		claimantSessionId: request.claimantSessionId,
		childSessionId,
		claimRevision: nextRevision,
		rawToken,
		leaseExpiresAt: currentTime + request.leaseMs,
		createdAt: currentTime,
	};
	const writtenCredentialPath = writeCredential(directory, credential);
	recordJournalEntry(directory, {
		schemaVersion: 1,
		authorityDigest: authority.authorityDigest,
		state: 'PREPARED',
		claimantCallID: request.claimantCallID,
		claimantSessionId: request.claimantSessionId,
		childSessionId,
		claimRevision: nextRevision,
		attempt: nextAttempt,
		leaseExpiresAt: currentTime + request.leaseMs,
		claimTokenDigest,
		preparedAt: currentTime,
		credentialInstalledAt: currentTime,
	});

	const claimedAuthority: WorktreeRecoveryAuthorityRecord = {
		...authority,
		status: 'claimed',
		claim: {
			claimantCallID: request.claimantCallID,
			claimantSessionId: request.claimantSessionId,
			childSessionId,
			claimRevision: nextRevision,
			attempt: nextAttempt,
			leaseExpiresAt: currentTime + request.leaseMs,
			claimTokenDigest,
			claimedAt: currentTime,
		},
		claimCursor: {
			lastClaimRevision: nextRevision,
			lastAttempt: nextAttempt,
		},
	};
	const nextAuthorities = [...store.authorities];
	nextAuthorities[authorityIndex] = claimedAuthority;
	_internals.writeRecoveryStore(
		storePath(directory),
		updateStore(store, nextAuthorities),
		'claim-commit',
	);
	recordJournalEntry(directory, {
		schemaVersion: 1,
		authorityDigest: authority.authorityDigest,
		state: 'COMMITTED',
		claimantCallID: request.claimantCallID,
		claimantSessionId: request.claimantSessionId,
		childSessionId,
		claimRevision: nextRevision,
		attempt: nextAttempt,
		leaseExpiresAt: currentTime + request.leaseMs,
		claimTokenDigest,
		preparedAt: currentTime,
		credentialInstalledAt: currentTime,
		committedAt: currentTime,
	});
	return {
		ok: true,
		authority: claimedAuthority,
		rawToken,
		credentialPath: writtenCredentialPath,
	};
}

export async function claimWorktreeRecoveryAuthority(
	directory: string,
	request: ClaimWorktreeRecoveryAuthorityRequest,
): Promise<ClaimWorktreeRecoveryAuthorityResult> {
	const release = acquireAuthorityLock(directory);
	if (!release) {
		return baseMutationFailure(
			'busy',
			'worktree recovery authority store is locked',
		);
	}
	try {
		return await claimWorktreeRecoveryAuthorityUnlocked(directory, request);
	} finally {
		release();
	}
}

function renewWorktreeRecoveryClaimUnlocked(
	directory: string,
	request: ExactClaimMutationRequest & { leaseMs: number },
): MutateWorktreeRecoveryClaimResult {
	const store = loadStoreWritable(directory);
	if ('ok' in store) return store;
	const index = store.authorities.findIndex(
		(authority) => authority.authorityDigest === request.authorityDigest,
	);
	if (index === -1) {
		return baseMutationFailure(
			'not_found',
			'worktree recovery authority not found',
		);
	}
	const authority = store.authorities[index]!;
	if (!currentClaimMatches(authority, request)) {
		return baseMutationFailure(
			'stale_claim',
			'worktree recovery claim is stale or does not match the current claimant',
		);
	}
	const renewed: WorktreeRecoveryAuthorityRecord = {
		...authority,
		claim: {
			...authority.claim!,
			leaseExpiresAt: nowMs(request.now) + request.leaseMs,
		},
	};
	const nextAuthorities = [...store.authorities];
	nextAuthorities[index] = renewed;
	_internals.writeRecoveryStore(
		storePath(directory),
		updateStore(store, nextAuthorities),
		'claim-renew',
	);
	writeCredential(directory, {
		schemaVersion: 1,
		authorityDigest: renewed.authorityDigest,
		claimantCallID: renewed.claim!.claimantCallID,
		claimantSessionId: renewed.claim!.claimantSessionId,
		childSessionId: renewed.claim!.childSessionId,
		claimRevision: renewed.claim!.claimRevision,
		rawToken: request.rawToken,
		leaseExpiresAt: renewed.claim!.leaseExpiresAt,
		createdAt: renewed.claim!.claimedAt,
	});
	return { ok: true, authority: renewed };
}

export function renewWorktreeRecoveryClaim(
	directory: string,
	request: ExactClaimMutationRequest & { leaseMs: number },
): MutateWorktreeRecoveryClaimResult {
	const release = acquireAuthorityLock(directory);
	if (!release) {
		return baseMutationFailure(
			'busy',
			'worktree recovery authority store is locked',
		);
	}
	try {
		return renewWorktreeRecoveryClaimUnlocked(directory, request);
	} finally {
		release();
	}
}

function releaseWorktreeRecoveryClaimUnlocked(
	directory: string,
	request: ExactClaimMutationRequest,
): MutateWorktreeRecoveryClaimResult {
	const store = loadStoreWritable(directory);
	if ('ok' in store) return store;
	const index = store.authorities.findIndex(
		(authority) => authority.authorityDigest === request.authorityDigest,
	);
	if (index === -1) {
		return baseMutationFailure(
			'not_found',
			'worktree recovery authority not found',
		);
	}
	const authority = store.authorities[index]!;
	if (!currentClaimMatches(authority, request)) {
		return baseMutationFailure(
			'stale_claim',
			'worktree recovery claim is stale or does not match the current claimant',
		);
	}
	const released: WorktreeRecoveryAuthorityRecord = {
		...authority,
		status: 'preserved',
		claim: undefined,
		claimCursor: authority.claim
			? {
					lastClaimRevision: authority.claim.claimRevision,
					lastAttempt: authority.claim.attempt,
				}
			: authority.claimCursor,
	};
	const nextAuthorities = [...store.authorities];
	nextAuthorities[index] = released;
	_internals.writeRecoveryStore(
		storePath(directory),
		updateStore(store, nextAuthorities),
		'claim-release',
	);
	recordJournalEntry(directory, {
		schemaVersion: 1,
		authorityDigest: authority.authorityDigest,
		state: 'RELEASED',
		claimantCallID: authority.claim!.claimantCallID,
		claimantSessionId: authority.claim!.claimantSessionId,
		childSessionId: authority.claim!.childSessionId,
		claimRevision: authority.claim!.claimRevision,
		attempt: authority.claim!.attempt,
		leaseExpiresAt: authority.claim!.leaseExpiresAt,
		claimTokenDigest: authority.claim!.claimTokenDigest,
		preparedAt: authority.claim!.claimedAt,
		committedAt: nowMs(request.now),
		reason: 'claim released after preserved settlement',
	});
	removeCredentialIfMatch(directory, request);
	return { ok: true, authority: released };
}

export function releaseWorktreeRecoveryClaim(
	directory: string,
	request: ExactClaimMutationRequest,
): MutateWorktreeRecoveryClaimResult {
	const release = acquireAuthorityLock(directory);
	if (!release) {
		return baseMutationFailure(
			'busy',
			'worktree recovery authority store is locked',
		);
	}
	try {
		return releaseWorktreeRecoveryClaimUnlocked(directory, request);
	} finally {
		release();
	}
}

function finalizeWorktreeRecoveryAuthorityUnlocked(
	directory: string,
	request: FinalizeWorktreeRecoveryAuthorityRequest,
): MutateWorktreeRecoveryClaimResult {
	const store = loadStoreWritable(directory);
	if ('ok' in store) return store;
	const index = store.authorities.findIndex(
		(authority) => authority.authorityDigest === request.authorityDigest,
	);
	if (index === -1) {
		return baseMutationFailure(
			'not_found',
			'worktree recovery authority not found',
		);
	}
	const authority = store.authorities[index]!;
	if (!currentClaimMatches(authority, request)) {
		return baseMutationFailure(
			'stale_claim',
			'worktree recovery claim is stale or does not match the current claimant',
		);
	}
	const finalized: WorktreeRecoveryAuthorityRecord = {
		...authority,
		status: 'finalized',
		claim: undefined,
		claimCursor: authority.claim
			? {
					lastClaimRevision: authority.claim.claimRevision,
					lastAttempt: authority.claim.attempt,
				}
			: authority.claimCursor,
		finalizedAt: nowMs(request.now),
		settlement: request.settlement,
	};
	const nextAuthorities = [...store.authorities];
	nextAuthorities[index] = finalized;
	_internals.writeRecoveryStore(
		storePath(directory),
		updateStore(store, nextAuthorities),
		'claim-finalize',
	);
	recordJournalEntry(directory, {
		schemaVersion: 1,
		authorityDigest: authority.authorityDigest,
		state: 'FINALIZED',
		claimantCallID: authority.claim!.claimantCallID,
		claimantSessionId: authority.claim!.claimantSessionId,
		childSessionId: authority.claim!.childSessionId,
		claimRevision: authority.claim!.claimRevision,
		attempt: authority.claim!.attempt,
		leaseExpiresAt: authority.claim!.leaseExpiresAt,
		claimTokenDigest: authority.claim!.claimTokenDigest,
		preparedAt: authority.claim!.claimedAt,
		committedAt: nowMs(request.now),
		reason: 'claim finalized after landed settlement',
	});
	removeCredentialIfMatch(directory, request);
	return { ok: true, authority: finalized };
}

export function finalizeWorktreeRecoveryAuthority(
	directory: string,
	request: FinalizeWorktreeRecoveryAuthorityRequest,
): MutateWorktreeRecoveryClaimResult {
	const release = acquireAuthorityLock(directory);
	if (!release) {
		return baseMutationFailure(
			'busy',
			'worktree recovery authority store is locked',
		);
	}
	try {
		return finalizeWorktreeRecoveryAuthorityUnlocked(directory, request);
	} finally {
		release();
	}
}

function replayWorktreeRecoveryClaimJournalUnlocked(
	directory: string,
	options?: ReplayPreparedClaimOptions,
): ReplayPreparedClaimOutcome[] {
	const outcomes: ReplayPreparedClaimOutcome[] = [];
	const storeScan = loadStoreStrict(directory);
	const authorities = new Map(
		(storeScan.status === 'ok' ? storeScan.authorities : []).map(
			(authority) => [authority.authorityDigest, authority],
		),
	);
	for (const entry of latestJournalEntriesByAuthority(loadJournal(directory))) {
		if (
			entry.state === 'ABORTED' ||
			entry.state === 'RELEASED' ||
			entry.state === 'FINALIZED'
		) {
			outcomes.push({
				authorityDigest: entry.authorityDigest,
				outcome: 'noop',
			});
			continue;
		}
		if (entry.state === 'COMMITTED') {
			const current = authorities.get(entry.authorityDigest);
			if (
				current &&
				!current.claim &&
				current.claimCursor?.lastClaimRevision === entry.claimRevision &&
				(current.status === 'preserved' || current.status === 'finalized')
			) {
				recordJournalEntry(directory, {
					...entry,
					state: current.status === 'finalized' ? 'FINALIZED' : 'RELEASED',
					reason:
						'repaired terminal claim journal after interrupted settlement',
				});
				removeCredentialIfMatch(directory, entry);
				outcomes.push({
					authorityDigest: entry.authorityDigest,
					outcome: 'repaired_terminal_claim',
				});
				continue;
			}
			if (
				current?.claim &&
				current.claim.claimRevision === entry.claimRevision &&
				current.claim.claimTokenDigest === entry.claimTokenDigest
			) {
				const credential = readCredential(directory, entry.authorityDigest);
				const released = credential
					? releaseWorktreeRecoveryClaimUnlocked(directory, {
							authorityDigest: entry.authorityDigest,
							claimantCallID: entry.claimantCallID,
							claimRevision: entry.claimRevision,
							rawToken: credential.rawToken,
						})
					: undefined;
				outcomes.push({
					authorityDigest: entry.authorityDigest,
					outcome: released?.ok
						? 'released_orphaned_committed_claim'
						: 'uncertain_committed_without_authority',
				});
			} else {
				outcomes.push({
					authorityDigest: entry.authorityDigest,
					outcome: 'uncertain_committed_without_authority',
				});
			}
			continue;
		}

		const current = authorities.get(entry.authorityDigest);
		if (
			current?.claim &&
			current.claim.claimRevision === entry.claimRevision &&
			current.claim.claimTokenDigest === entry.claimTokenDigest
		) {
			recordJournalEntry(directory, {
				...entry,
				state: 'COMMITTED',
				committedAt: nowMs(),
			});
			outcomes.push({
				authorityDigest: entry.authorityDigest,
				outcome: 'committed_claim_stable',
			});
			continue;
		}

		const credential = readCredential(directory, entry.authorityDigest);
		if (
			credential &&
			credential.claimRevision === entry.claimRevision &&
			credential.claimantCallID === entry.claimantCallID
		) {
			removeCredentialIfMatch(directory, entry);
			recordJournalEntry(directory, {
				...entry,
				state: 'ABORTED',
				abortedAt: nowMs(),
				reason: 'removed uncommitted credential during replay',
			});
			options?.onAbortPreparedClaim?.(entry);
			outcomes.push({
				authorityDigest: entry.authorityDigest,
				outcome: 'removed_uncommitted_credential',
			});
			continue;
		}

		recordJournalEntry(directory, {
			...entry,
			state: 'ABORTED',
			abortedAt: nowMs(),
			reason: 'prepared claim never reached credential install or commit',
		});
		options?.onAbortPreparedClaim?.(entry);
		outcomes.push({
			authorityDigest: entry.authorityDigest,
			outcome: 'aborted_prepared_claim',
		});
	}
	return outcomes;
}

export function replayWorktreeRecoveryClaimJournal(
	directory: string,
	options?: ReplayPreparedClaimOptions,
): ReplayPreparedClaimOutcome[] {
	const release = acquireAuthorityLock(directory);
	if (!release) {
		throw new Error('worktree recovery authority store is locked');
	}
	try {
		return replayWorktreeRecoveryClaimJournalUnlocked(directory, options);
	} finally {
		release();
	}
}

export const _internals = {
	generateRawToken: (): string => randomBytes(32).toString('hex'),
	writeRecoveryStore: (
		targetPath: string,
		store: WorktreeRecoveryStore,
		_phase:
			| 'publish'
			| 'claim-commit'
			| 'claim-renew'
			| 'claim-release'
			| 'claim-finalize',
	): void => {
		atomicWriteSwarmFileSync(targetPath, JSON.stringify(store, null, 2));
	},
	writeClaimJournal: (
		targetPath: string,
		journal: WorktreeRecoveryClaimJournal,
	): void => {
		atomicWriteSwarmFileSync(targetPath, JSON.stringify(journal, null, 2));
	},
	writeCredentialFile: (
		targetPath: string,
		credential: WorktreeRecoveryCredential,
	): void => {
		atomicWriteSwarmFileSync(targetPath, JSON.stringify(credential, null, 2));
	},
	getRecoveryStorePath: storePath,
	getClaimJournalPath: journalPath,
	getCredentialPath: credentialPath,
	readClaimJournal(directory: string): WorktreeRecoveryClaimJournal {
		return loadJournal(directory);
	},
	resetForTest(): void {
		// No process-global state; the helper exists for test symmetry.
	},
};
