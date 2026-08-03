/**
 * Review receipt persistence for opencode-swarm.
 *
 * Persists reviewer and curator review receipts to disk so that future
 * re-reviews and drift verification have durable evidence of prior judgments.
 *
 * Two receipt types:
 *   RejectedReviewReceipt  — full-detail artifact with blocking findings,
 *                             exact evidence refs, scope fingerprint/hash,
 *                             and re-review pass conditions.
 *   ApprovedReviewReceipt  — compact artifact with what was checked, claims
 *                             validated, scope fingerprint, and caveats.
 *
 * Storage: .swarm/review-receipts/<YYYY-MM-DD>-<id>.json (one file per receipt)
 *          .swarm/review-receipts/index.json              (manifest for fast lookup)
 *
 * Staleness: receipts are invalidated when the scope fingerprint changes
 *            materially (any character-level change to the canonical diff/hash).
 *            Consumers MUST check isScopeStale() before trusting an approved receipt.
 *
 * Critic drift verification can consume prior receipts as supporting context
 * but MUST NOT blindly trust them — staleness check is mandatory.
 *
 * Scope-description heterogeneity: receipts in one index may be fingerprinted
 * over different canonical contents (e.g. `reviewer-task-files-v1` hashes the
 * guardrails-observed file scope plus HEAD and current content; auto-review
 * receipts hash a canonical diff). Consumers MUST filter by
 * `scope_fingerprint.scope_description` and compare like-for-like content
 * before treating an approved receipt as fresh via isScopeStale().
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	FindingValidation,
	ReviewFinding,
} from '../agents/agent-output-schema.js';

// ============================================================================
// Types
// ============================================================================

export type ReceiptVerdict = 'rejected' | 'approved';
export type ReviewFindingSeverity =
	| 'critical'
	| 'high'
	| 'medium'
	| 'low'
	| 'info';

/** Raised when reviewed bytes stop matching immediately before a durable commit. */
export class ReviewScopeStaleError extends Error {
	readonly code = 'REVIEW_SCOPE_STALE';

	constructor(message: string) {
		super(message);
		this.name = 'ReviewScopeStaleError';
	}
}

/** Identity of the reviewer/curator that produced the receipt. */
export interface ReviewerIdentity {
	/** Agent name (e.g. 'reviewer', 'critic', 'curator') */
	agent: string;
	/** Optional session ID for traceability */
	session_id?: string;
}

/** A canonical fingerprint/hash of the reviewed scope or diff. */
export interface ScopeFingerprint {
	/** SHA-256 hex digest of the canonical scope content */
	hash: string;
	/** Short description of what was hashed (e.g. 'git-diff', 'file-content', 'spec-md') */
	scope_description: string;
	/** Length of the original content in characters */
	content_length: number;
}

/**
 * A finding recorded in a rejected review.
 *
 * The `blocking_findings` JSON field name is retained for schema-v1
 * compatibility, but `effective_severity` is authoritative when present.
 */
export interface BlockingFinding {
	/** File path (relative) or identifier */
	location: string;
	/** One-line summary of the finding */
	summary: string;
	/** Line number if applicable */
	line?: number;
	/** Reviewer-reported severity. */
	severity: ReviewFindingSeverity;
	/** Structured-finding fields are additive so legacy v1 receipts remain readable. */
	finding_id?: string;
	title?: string;
	body?: string;
	confidence?: number;
	file?: string;
	line_start?: number;
	line_end?: number;
	/** Severity after confidence, anchoring, and validation policy is applied. */
	effective_severity?: ReviewFindingSeverity;
	validator_disposition?: FindingValidation['disposition'];
	validator_confidence?: number;
	validator_evidence?: string;
	anchor_status?: 'anchored' | 'unanchored' | 'truncated' | 'rejected';
	anchor_reason?: string;
}

/**
 * Rejected review receipt.
 * Full-detail artifact. Persisted for re-review reference.
 */
export interface RejectedReviewReceipt {
	schema_version: 1;
	id: string;
	receipt_type: 'rejected';
	verdict: 'rejected';
	/** Reviewer/curator that produced this receipt */
	reviewer: ReviewerIdentity;
	/** ISO 8601 timestamp */
	reviewed_at: string;
	/** Fingerprint of the reviewed scope */
	scope_fingerprint: ScopeFingerprint;
	/**
	 * Rejected findings retained under the schema-v1 field name.
	 * Consumers must use effective severity when deciding which can block.
	 */
	blocking_findings: BlockingFinding[];
	/** Exact evidence references (file paths, line numbers, etc.) */
	evidence_references: string[];
	/** Conditions that must be met for a re-review to pass */
	pass_conditions: string[];
	/** Optional free-text summary */
	summary?: string;
	/** Original machine-readable reviewer payload, when one was available. */
	structured_findings?: ReviewFinding[];
	review_overall_confidence?: number;
	/** Independent validator output, when validation was requested. */
	finding_validations?: FindingValidation[];
}

/**
 * Approved review receipt.
 * Compact artifact. Supporting evidence, not durable proof.
 */
export interface ApprovedReviewReceipt {
	schema_version: 1;
	id: string;
	receipt_type: 'approved';
	verdict: 'approved';
	/** Reviewer/curator that produced this receipt */
	reviewer: ReviewerIdentity;
	/** ISO 8601 timestamp */
	reviewed_at: string;
	/** Fingerprint of the reviewed scope */
	scope_fingerprint: ScopeFingerprint;
	/** What aspects were checked (e.g. ['security', 'correctness', 'test coverage']) */
	checked_aspects: string[];
	/** Claims that were validated during review */
	validated_claims: string[];
	/** Residual risk or caveats */
	caveats?: string[];
	/** Original machine-readable reviewer payload, when one was available. */
	structured_findings?: ReviewFinding[];
	review_overall_confidence?: number;
	/** Independent validator output, when validation was requested. */
	finding_validations?: FindingValidation[];
}

export type ReviewReceipt = RejectedReviewReceipt | ApprovedReviewReceipt;

/** Index entry for fast lookup without reading every receipt file. */
export interface ReceiptIndexEntry {
	id: string;
	verdict: ReceiptVerdict;
	reviewed_at: string;
	scope_hash: string;
	agent: string;
	filename: string;
}

/** Receipt index manifest stored in .swarm/review-receipts/index.json */
export interface ReceiptIndex {
	schema_version: 1;
	entries: ReceiptIndexEntry[];
}

// ============================================================================
// Path Helpers
// ============================================================================

/** Returns the .swarm/review-receipts/ directory path. */
export function resolveReceiptsDir(directory: string): string {
	return path.join(directory, '.swarm', 'review-receipts');
}

/** Returns the index file path. */
export function resolveReceiptIndexPath(directory: string): string {
	return path.join(resolveReceiptsDir(directory), 'index.json');
}

interface DirectoryIdentity {
	path: string;
	dev: bigint;
	ino: bigint;
}

interface ReceiptPersistenceContext {
	project: DirectoryIdentity;
	swarm: DirectoryIdentity;
	receipts: DirectoryIdentity;
}

export const _internals: {
	openSync: typeof fs.openSync;
	lstatBigIntSync: (path: fs.PathLike) => fs.BigIntStats;
	fstatBigIntSync: (fd: number) => fs.BigIntStats;
} = {
	openSync: fs.openSync,
	lstatBigIntSync: (path) => fs.lstatSync(path, { bigint: true }),
	fstatBigIntSync: (fd) => fs.fstatSync(fd, { bigint: true }),
};

function pathsEqual(left: string, right: string): boolean {
	const normalizedLeft = path.normalize(left);
	const normalizedRight = path.normalize(right);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

function captureCanonicalDirectory(
	directory: string,
	label: string,
	expected?: DirectoryIdentity,
): DirectoryIdentity {
	const resolved = path.resolve(directory);
	const stat = _internals.lstatBigIntSync(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`${label} must be a real directory`);
	}
	if (stat.dev === 0n && stat.ino === 0n) {
		throw new Error(`${label} has no stable filesystem identity`);
	}
	const canonical = fs.realpathSync(resolved);
	if (!pathsEqual(canonical, resolved)) {
		throw new Error(`${label} must not traverse a symlink or junction`);
	}
	if (
		expected &&
		(!pathsEqual(expected.path, resolved) ||
			expected.dev !== stat.dev ||
			expected.ino !== stat.ino)
	) {
		throw new Error(`${label} changed during review receipt persistence`);
	}
	return { path: resolved, dev: stat.dev, ino: stat.ino };
}

function ensureContainedDirectory(
	parent: DirectoryIdentity,
	childName: string,
	label: string,
): DirectoryIdentity {
	captureCanonicalDirectory(parent.path, path.basename(parent.path), parent);
	const child = path.join(parent.path, childName);
	try {
		fs.mkdirSync(child);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const identity = captureCanonicalDirectory(child, label);
	if (!pathsEqual(path.dirname(identity.path), parent.path)) {
		throw new Error(`${label} escapes its expected parent`);
	}
	captureCanonicalDirectory(parent.path, path.basename(parent.path), parent);
	return identity;
}

function ensureCanonicalProjectRoot(directory: string): DirectoryIdentity {
	const resolved = path.resolve(directory);
	const missingComponents: string[] = [];
	let existing = resolved;
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) {
			throw new Error('project root has no existing canonical ancestor');
		}
		missingComponents.push(path.basename(existing));
		existing = parent;
	}
	let current = captureCanonicalDirectory(existing, 'project root ancestor');
	for (const component of missingComponents.reverse()) {
		current = ensureContainedDirectory(current, component, 'project root');
	}
	if (!pathsEqual(current.path, resolved)) {
		throw new Error('project root could not be resolved canonically');
	}
	return current;
}

function prepareReceiptPersistence(
	directory: string,
): ReceiptPersistenceContext {
	const project = ensureCanonicalProjectRoot(directory);
	const swarm = ensureContainedDirectory(project, '.swarm', '.swarm directory');
	const receipts = ensureContainedDirectory(
		swarm,
		'review-receipts',
		'review receipts directory',
	);
	return { project, swarm, receipts };
}

function captureExistingReceiptContext(
	directory: string,
): ReceiptPersistenceContext {
	const project = captureCanonicalDirectory(
		path.resolve(directory),
		'project root',
	);
	const swarm = captureCanonicalDirectory(
		path.join(project.path, '.swarm'),
		'.swarm directory',
	);
	if (!pathsEqual(path.dirname(swarm.path), project.path)) {
		throw new Error('.swarm directory escapes its expected parent');
	}
	captureCanonicalDirectory(project.path, 'project root', project);

	const receipts = captureCanonicalDirectory(
		path.join(swarm.path, 'review-receipts'),
		'review receipts directory',
	);
	if (!pathsEqual(path.dirname(receipts.path), swarm.path)) {
		throw new Error('review receipts directory escapes its expected parent');
	}
	captureCanonicalDirectory(swarm.path, '.swarm directory', swarm);
	captureCanonicalDirectory(project.path, 'project root', project);
	return { project, swarm, receipts };
}

function assertReceiptContextCurrent(context: ReceiptPersistenceContext): void {
	captureCanonicalDirectory(
		context.project.path,
		'project root',
		context.project,
	);
	captureCanonicalDirectory(
		context.swarm.path,
		'.swarm directory',
		context.swarm,
	);
	captureCanonicalDirectory(
		context.receipts.path,
		'review receipts directory',
		context.receipts,
	);
}

function assertDirectReceiptFile(
	context: ReceiptPersistenceContext,
	filePath: string,
	mustExist: boolean,
): string {
	assertReceiptContextCurrent(context);
	const resolved = path.resolve(filePath);
	if (!pathsEqual(path.dirname(resolved), context.receipts.path)) {
		throw new Error('review receipt file escapes its expected directory');
	}
	try {
		const stat = _internals.lstatBigIntSync(resolved);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error('review receipt path must be a real file');
		}
	} catch (error) {
		if (!mustExist && (error as NodeJS.ErrnoException).code === 'ENOENT') {
			return resolved;
		}
		throw error;
	}
	return resolved;
}

function sameFileSnapshot(
	left: fs.BigIntStats,
	right: fs.BigIntStats,
): boolean {
	return (
		(left.dev !== 0n || left.ino !== 0n) &&
		(right.dev !== 0n || right.ino !== 0n) &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

/**
 * Read a direct review-receipt file without following redirected ancestors.
 *
 * The directory identities are captured before opening, then revalidated
 * around a descriptor-owned read. Comparing the opened descriptor with the
 * pathname snapshots prevents a project/.swarm/review-receipts swap from
 * redirecting the read outside the project between validation and open.
 */
export function readReviewReceiptText(
	directory: string,
	receiptPath: string,
	maxBytes = 1_048_576,
): string | null {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;

	let descriptor: number | undefined;
	try {
		const context = captureExistingReceiptContext(directory);
		const resolved = assertDirectReceiptFile(context, receiptPath, true);
		if (path.extname(resolved) !== '.json') return null;

		const pathBeforeOpen = _internals.lstatBigIntSync(resolved);
		if (
			!pathBeforeOpen.isFile() ||
			pathBeforeOpen.isSymbolicLink() ||
			pathBeforeOpen.size < 0n ||
			pathBeforeOpen.size > BigInt(maxBytes)
		) {
			return null;
		}
		const canonicalBeforeOpen = fs.realpathSync(resolved);
		if (!pathsEqual(canonicalBeforeOpen, resolved)) return null;

		assertReceiptContextCurrent(context);
		descriptor = _internals.openSync(canonicalBeforeOpen, 'r');
		const openedBeforeRead = _internals.fstatBigIntSync(descriptor);
		assertReceiptContextCurrent(context);
		const pathAfterOpen = _internals.lstatBigIntSync(resolved);
		const canonicalAfterOpen = fs.realpathSync(resolved);
		if (
			!openedBeforeRead.isFile() ||
			openedBeforeRead.size < 0n ||
			openedBeforeRead.size > BigInt(maxBytes) ||
			!sameFileSnapshot(pathBeforeOpen, openedBeforeRead) ||
			!sameFileSnapshot(openedBeforeRead, pathAfterOpen) ||
			!pathsEqual(canonicalBeforeOpen, canonicalAfterOpen)
		) {
			return null;
		}

		// `openedBeforeRead.size` is bounded by the safe-integer `maxBytes`
		// immediately above, so this conversion cannot lose precision.
		const buffer = Buffer.alloc(Number(openedBeforeRead.size));
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = fs.readSync(
				descriptor,
				buffer,
				bytesRead,
				buffer.length - bytesRead,
				bytesRead,
			);
			if (count === 0) break;
			bytesRead += count;
		}

		const openedAfterRead = _internals.fstatBigIntSync(descriptor);
		assertReceiptContextCurrent(context);
		const pathAfterRead = _internals.lstatBigIntSync(resolved);
		const canonicalAfterRead = fs.realpathSync(resolved);
		if (
			bytesRead !== buffer.length ||
			!sameFileSnapshot(openedBeforeRead, openedAfterRead) ||
			!sameFileSnapshot(openedAfterRead, pathAfterRead) ||
			!pathsEqual(canonicalBeforeOpen, canonicalAfterRead)
		) {
			return null;
		}
		return buffer.toString('utf8');
	} catch {
		return null;
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// Best-effort descriptor cleanup.
			}
		}
	}
}

/** Builds a datestamped receipt filename. */
function buildReceiptFilename(id: string, date: Date): string {
	const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
	return `${dateStr}-${id}.json`;
}

// ============================================================================
// Fingerprint
// ============================================================================

/**
 * Compute a SHA-256 scope fingerprint for a given content string.
 * The hash is deterministic: same content → same hash.
 */
export function computeScopeFingerprint(
	content: string,
	scopeDescription: string,
): ScopeFingerprint {
	const hash = crypto
		.createHash('sha256')
		.update(content, 'utf-8')
		.digest('hex');
	return {
		hash,
		scope_description: scopeDescription,
		content_length: content.length,
	};
}

/**
 * Returns true if the current scope content is materially different from
 * the fingerprint recorded in the receipt. Any character-level change to the
 * canonical content (same scopeDescription) invalidates the receipt.
 *
 * If `currentContent` is undefined (scope no longer available), the receipt
 * is treated as stale (conservative: assume the scope has changed).
 */
export function isScopeStale(
	receipt: ReviewReceipt,
	currentContent: string | undefined,
): boolean {
	if (currentContent === undefined) {
		return true; // Cannot verify — treat as stale
	}
	const currentHash = crypto
		.createHash('sha256')
		.update(currentContent, 'utf-8')
		.digest('hex');
	return currentHash !== receipt.scope_fingerprint.hash;
}

// ============================================================================
// Read/Write
// ============================================================================

// In-process serialization of index updates: prevents two concurrent
// persistReviewReceipt calls from racing on the last-write-wins index update.
// Cross-process races are extremely rare (two distinct OpenCode instances
// writing receipts simultaneously) and are accepted as best-effort.
let _indexLockChain: Promise<void> = Promise.resolve();

async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = _indexLockChain;
	let release!: () => void;
	_indexLockChain = new Promise<void>((r) => {
		release = r;
	});
	try {
		await prev;
		return await fn();
	} finally {
		release();
	}
}

/** Read and parse the receipt index. Returns an empty index if missing. */
async function readReceiptIndex(
	directory: string,
	context?: ReceiptPersistenceContext,
): Promise<ReceiptIndex> {
	const indexPath = context
		? path.join(context.receipts.path, 'index.json')
		: resolveReceiptIndexPath(directory);
	if (context) {
		assertDirectReceiptFile(context, indexPath, false);
	}
	if (!fs.existsSync(indexPath)) {
		return { schema_version: 1, entries: [] };
	}
	try {
		const content = await fs.promises.readFile(indexPath, 'utf-8');
		if (context) {
			assertDirectReceiptFile(context, indexPath, true);
		}
		const parsed = JSON.parse(content) as ReceiptIndex;
		if (parsed.schema_version !== 1 || !Array.isArray(parsed.entries)) {
			return { schema_version: 1, entries: [] };
		}
		return parsed;
	} catch {
		return { schema_version: 1, entries: [] };
	}
}

/** Write the receipt index atomically (tmp → rename). */
async function writeReceiptIndex(
	directory: string,
	index: ReceiptIndex,
	verifyCurrent?: () => Promise<boolean>,
	context = prepareReceiptPersistence(directory),
): Promise<void> {
	const indexPath = path.join(context.receipts.path, 'index.json');
	assertDirectReceiptFile(context, indexPath, false);
	const tmpPath = `${indexPath}.tmp.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2)}`;
	try {
		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify(index, null, 2),
			'utf-8',
		);
		assertDirectReceiptFile(context, tmpPath, true);
		if (verifyCurrent && !(await verifyCurrent())) {
			throw new ReviewScopeStaleError(
				'review receipt scope became stale before index commit',
			);
		}
		// This synchronous containment check and rename form one commit boundary:
		// there is no awaited/user-code gap in which a junction swap can be accepted.
		assertDirectReceiptFile(context, tmpPath, true);
		assertDirectReceiptFile(context, indexPath, false);
		fs.renameSync(tmpPath, indexPath);
	} finally {
		await fs.promises.unlink(tmpPath).catch(() => {});
	}
}

export interface PersistReviewReceiptOptions {
	/**
	 * Rebuild and verify the immutable reviewed scope immediately before each
	 * synchronous atomic rename. A false result aborts without publishing stale
	 * receipt/index state.
	 */
	verifyCurrent?: () => Promise<boolean>;
}

export interface UpdateReviewReceiptValidationsOptions {
	/** Refuse to update a receipt that no longer has the expected immutable identity. */
	expectedIdentity?: {
		id: string;
		scopeHash: string;
		scopeDescription: string;
	};
	/**
	 * Rebuild and verify the exact reviewer generation and scope immediately before
	 * the synchronous atomic rename. A false result discards the temporary update.
	 */
	verifyCurrent?: () => Promise<boolean>;
}

/**
 * Persist a review receipt (rejected or approved) to disk.
 * Creates .swarm/review-receipts/<date>-<id>.json and updates the index.
 * Returns the absolute path of the written receipt file.
 */
export async function persistReviewReceipt(
	directory: string,
	receipt: ReviewReceipt,
	options: PersistReviewReceiptOptions = {},
): Promise<string> {
	const context = prepareReceiptPersistence(directory);

	const now = new Date(receipt.reviewed_at);
	const filename = buildReceiptFilename(receipt.id, now);
	const receiptPath = path.join(context.receipts.path, filename);
	assertDirectReceiptFile(context, receiptPath, false);

	// Atomic write
	const tmpPath = `${receiptPath}.tmp.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2)}`;
	try {
		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify(receipt, null, 2),
			'utf-8',
		);
		assertDirectReceiptFile(context, tmpPath, true);
		if (options.verifyCurrent && !(await options.verifyCurrent())) {
			throw new ReviewScopeStaleError(
				'review receipt scope became stale before receipt commit',
			);
		}
		assertDirectReceiptFile(context, tmpPath, true);
		assertDirectReceiptFile(context, receiptPath, false);
		fs.renameSync(tmpPath, receiptPath);
	} finally {
		await fs.promises.unlink(tmpPath).catch(() => {});
	}

	// Update index inside an in-process lock to prevent last-write-wins race.
	try {
		await withIndexLock(async () => {
			const index = await readReceiptIndex(directory, context);
			const entry: ReceiptIndexEntry = {
				id: receipt.id,
				verdict: receipt.verdict,
				reviewed_at: receipt.reviewed_at,
				scope_hash: receipt.scope_fingerprint.hash,
				agent: receipt.reviewer.agent,
				filename,
			};
			index.entries.push(entry);
			await writeReceiptIndex(directory, index, options.verifyCurrent, context);
		});
	} catch (error) {
		await removeReviewReceipt(directory, receiptPath, receipt.id).catch(
			() => {},
		);
		throw error;
	}

	return receiptPath;
}

/**
 * Remove a just-persisted receipt after a later persistence step fails.
 *
 * The index entry is committed first so a crash can leave at most an unindexed
 * orphan file, never a dangling index entry that points at missing evidence.
 */
export async function removeReviewReceipt(
	directory: string,
	receiptPath: string,
	receiptId: string,
): Promise<void> {
	const context = prepareReceiptPersistence(directory);
	const safeReceiptPath = assertDirectReceiptFile(context, receiptPath, false);
	await withIndexLock(async () => {
		const index = await readReceiptIndex(directory, context);
		const entries = index.entries.filter(
			(entry) =>
				entry.id !== receiptId ||
				!pathsEqual(
					path.join(context.receipts.path, entry.filename),
					safeReceiptPath,
				),
		);
		if (entries.length !== index.entries.length) {
			await writeReceiptIndex(
				directory,
				{ schema_version: 1, entries },
				undefined,
				context,
			);
		}
		assertDirectReceiptFile(context, safeReceiptPath, false);
		try {
			fs.unlinkSync(safeReceiptPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	});
}

/**
 * Atomically attach independent finding-validation results to an existing
 * receipt. The receipt identity and index entry remain unchanged.
 */
export async function updateReviewReceiptValidations(
	receiptPath: string,
	validations: FindingValidation[],
	options: UpdateReviewReceiptValidationsOptions = {},
): Promise<void> {
	const receiptsDir = path.resolve(path.dirname(receiptPath));
	const resolvedPath = path.resolve(receiptPath);
	if (
		path.dirname(resolvedPath) !== receiptsDir ||
		path.basename(receiptsDir) !== 'review-receipts' ||
		path.basename(path.dirname(receiptsDir)) !== '.swarm' ||
		!path.basename(resolvedPath).endsWith('.json')
	) {
		throw new Error('invalid review receipt path');
	}
	const directory = path.dirname(path.dirname(receiptsDir));
	const context = prepareReceiptPersistence(directory);
	assertDirectReceiptFile(context, resolvedPath, true);
	const raw = await fs.promises.readFile(resolvedPath, 'utf-8');
	assertDirectReceiptFile(context, resolvedPath, true);
	const receipt = JSON.parse(raw) as ReviewReceipt;
	if (receipt.schema_version !== 1 || !receipt.id) {
		throw new Error('invalid review receipt');
	}
	if (
		options.expectedIdentity &&
		(receipt.id !== options.expectedIdentity.id ||
			receipt.scope_fingerprint.hash !== options.expectedIdentity.scopeHash ||
			receipt.scope_fingerprint.scope_description !==
				options.expectedIdentity.scopeDescription)
	) {
		throw new Error('review receipt identity changed before validation update');
	}
	receipt.finding_validations = validations;
	if (receipt.receipt_type === 'rejected') {
		const byId = new Map(
			validations.map((validation) => [validation.finding_id, validation]),
		);
		for (const finding of receipt.blocking_findings) {
			if (!finding.finding_id) continue;
			const validation = byId.get(finding.finding_id);
			if (!validation) continue;
			finding.validator_disposition = validation.disposition;
			finding.validator_confidence = validation.confidence;
			finding.validator_evidence = validation.evidence;
		}
	}
	const tmpPath = `${resolvedPath}.tmp.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2)}`;
	await fs.promises.writeFile(
		tmpPath,
		JSON.stringify(receipt, null, 2),
		'utf-8',
	);
	try {
		assertDirectReceiptFile(context, tmpPath, true);
		if (options.verifyCurrent && !(await options.verifyCurrent())) {
			throw new ReviewScopeStaleError(
				'review receipt scope became stale before validation commit',
			);
		}
		assertDirectReceiptFile(context, tmpPath, true);
		assertDirectReceiptFile(context, resolvedPath, true);
		fs.renameSync(tmpPath, resolvedPath);
	} catch (error) {
		await fs.promises.unlink(tmpPath).catch(() => {});
		throw error;
	}
}

/**
 * Parse a receipt from hardened, containment-checked text.
 *
 * Index entries are sourced from the editable `index.json` manifest, so the
 * `filename` field is untrusted: a poisoned entry like `../../outside/secret`
 * would otherwise escape the receipts directory when joined. Route every index
 * read through {@link readReviewReceiptText}, which asserts the resolved path
 * remains directly inside the receipts directory (no traversal, symlink,
 * junction, or open-time ancestor swap) before reading. Returns null on any
 * containment failure or unreadable content, matching the prior fail-soft
 * contract of these readers.
 */
function parseReceiptFromIndexEntry(
	directory: string,
	filename: string,
): ReviewReceipt | null {
	const receiptPath = path.join(resolveReceiptsDir(directory), filename);
	const content = readReviewReceiptText(directory, receiptPath);
	if (content === null) return null;
	try {
		return JSON.parse(content) as ReviewReceipt;
	} catch {
		return null;
	}
}

/**
 * Read a single receipt by ID. Returns null if not found or unreadable.
 */
export async function readReceiptById(
	directory: string,
	receiptId: string,
): Promise<ReviewReceipt | null> {
	const index = await readReceiptIndex(directory);
	const entry = index.entries.find((e) => e.id === receiptId);
	if (!entry) return null;
	return parseReceiptFromIndexEntry(directory, entry.filename);
}

/**
 * Read all receipts for a given scope hash (latest first).
 * Useful for drift verification to find prior reviews of the same scope.
 */
export async function readReceiptsByScopeHash(
	directory: string,
	scopeHash: string,
): Promise<ReviewReceipt[]> {
	const index = await readReceiptIndex(directory);
	const matching = index.entries
		.filter((e) => e.scope_hash === scopeHash)
		.sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at)); // newest first

	const receipts: ReviewReceipt[] = [];
	for (const entry of matching) {
		const receipt = parseReceiptFromIndexEntry(directory, entry.filename);
		if (receipt) receipts.push(receipt);
	}
	return receipts;
}

/**
 * Read all receipts from the index (all verdicts, latest first).
 * Useful for drift verification context.
 */
export async function readAllReceipts(
	directory: string,
): Promise<ReviewReceipt[]> {
	const index = await readReceiptIndex(directory);
	const sorted = [...index.entries].sort((a, b) =>
		b.reviewed_at.localeCompare(a.reviewed_at),
	);

	const receipts: ReviewReceipt[] = [];
	for (const entry of sorted) {
		const receipt = parseReceiptFromIndexEntry(directory, entry.filename);
		if (receipt) receipts.push(receipt);
	}
	return receipts;
}

// ============================================================================
// Factory Helpers
// ============================================================================

/**
 * Build a RejectedReviewReceipt.
 * `scopeContent` is hashed to produce the fingerprint.
 */
export function buildRejectedReceipt(opts: {
	agent: string;
	sessionId?: string;
	scopeContent: string;
	scopeDescription: string;
	blockingFindings: BlockingFinding[];
	evidenceReferences: string[];
	passConditions: string[];
	summary?: string;
	structuredFindings?: ReviewFinding[];
	reviewOverallConfidence?: number;
	findingValidations?: FindingValidation[];
}): RejectedReviewReceipt {
	return {
		schema_version: 1,
		id: crypto.randomUUID(),
		receipt_type: 'rejected',
		verdict: 'rejected',
		reviewer: { agent: opts.agent, session_id: opts.sessionId },
		reviewed_at: new Date().toISOString(),
		scope_fingerprint: computeScopeFingerprint(
			opts.scopeContent,
			opts.scopeDescription,
		),
		blocking_findings: opts.blockingFindings,
		evidence_references: opts.evidenceReferences,
		pass_conditions: opts.passConditions,
		summary: opts.summary,
		structured_findings: opts.structuredFindings,
		review_overall_confidence: opts.reviewOverallConfidence,
		finding_validations: opts.findingValidations,
	};
}

/**
 * Build an ApprovedReviewReceipt.
 * `scopeContent` is hashed to produce the fingerprint.
 */
export function buildApprovedReceipt(opts: {
	agent: string;
	sessionId?: string;
	scopeContent: string;
	scopeDescription: string;
	checkedAspects: string[];
	validatedClaims: string[];
	caveats?: string[];
	structuredFindings?: ReviewFinding[];
	reviewOverallConfidence?: number;
	findingValidations?: FindingValidation[];
}): ApprovedReviewReceipt {
	return {
		schema_version: 1,
		id: crypto.randomUUID(),
		receipt_type: 'approved',
		verdict: 'approved',
		reviewer: { agent: opts.agent, session_id: opts.sessionId },
		reviewed_at: new Date().toISOString(),
		scope_fingerprint: computeScopeFingerprint(
			opts.scopeContent,
			opts.scopeDescription,
		),
		checked_aspects: opts.checkedAspects,
		validated_claims: opts.validatedClaims,
		caveats: opts.caveats,
		structured_findings: opts.structuredFindings,
		review_overall_confidence: opts.reviewOverallConfidence,
		finding_validations: opts.findingValidations,
	};
}

// ============================================================================
// Drift Verification Support
// ============================================================================

/**
 * Build a structured context summary of prior receipts for critic drift
 * verification. Returns a compact string that can be injected into context.
 *
 * Approved receipts that are scope-stale are flagged explicitly so the critic
 * knows they are supporting evidence only, not proof of current state.
 *
 * @param receipts - Array of prior receipts (from readAllReceipts or readReceiptsByScopeHash)
 * @param currentScopeContent - Optional current scope content for staleness check
 * @param maxChars - Maximum output length (default 1000)
 */
export function buildReceiptContextForDrift(
	receipts: ReviewReceipt[],
	currentScopeContent?: string,
	maxChars = 1000,
): string {
	if (receipts.length === 0) return '';

	const lines: string[] = ['## Prior Review Receipts (supporting context)'];

	for (const receipt of receipts) {
		const stale =
			receipt.verdict === 'approved'
				? isScopeStale(receipt, currentScopeContent)
				: false;

		const staleTag = stale ? ' [SCOPE-STALE — treat as context only]' : '';

		if (receipt.verdict === 'rejected') {
			const r = receipt as RejectedReviewReceipt;
			const blockingCount = r.blocking_findings.filter((finding) => {
				const severity = finding.effective_severity ?? finding.severity;
				return severity === 'critical' || severity === 'high';
			}).length;
			const nonBlockingCount = r.blocking_findings.length - blockingCount;
			lines.push(
				`- REJECTED by ${r.reviewer.agent} at ${r.reviewed_at.slice(0, 10)}: ` +
					`${blockingCount} blocking finding(s). ` +
					(nonBlockingCount > 0
						? `${nonBlockingCount} non-blocking finding(s) retained. `
						: '') +
					`Pass conditions: ${r.pass_conditions.slice(0, 2).join('; ')}.`,
			);
		} else {
			const a = receipt as ApprovedReviewReceipt;
			lines.push(
				`- APPROVED by ${a.reviewer.agent} at ${a.reviewed_at.slice(0, 10)}${staleTag}: ` +
					`checked [${a.checked_aspects.join(', ')}]. ` +
					(a.caveats && a.caveats.length > 0
						? `Caveats: ${a.caveats[0]}.`
						: 'No caveats recorded.'),
			);
		}
	}

	lines.push(
		'Note: Approved receipts are supporting evidence only. Stale receipts must not be blindly trusted.',
	);

	return lines.join('\n').slice(0, maxChars);
}
