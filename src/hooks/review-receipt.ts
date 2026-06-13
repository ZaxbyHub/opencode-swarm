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
 * over different canonical contents (e.g. 'reviewer-task-prompt' hashes the
 * delegation prompt; 'auto-review-*-diff' hashes the reviewed diff). A prompt
 * fingerprint does NOT change when the worktree changes, so consumers MUST
 * filter by `scope_fingerprint.scope_description` (or compare like-for-like
 * content) before treating an approved receipt as fresh via isScopeStale().
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export type ReceiptVerdict = 'rejected' | 'approved';

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

/** A blocking finding recorded in a rejected review. */
export interface BlockingFinding {
	/** File path (relative) or identifier */
	location: string;
	/** One-line summary of the finding */
	summary: string;
	/** Line number if applicable */
	line?: number;
	/** Severity: 'critical' | 'high' | 'medium' */
	severity: 'critical' | 'high' | 'medium';
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
	/** Blocking findings that caused rejection */
	blocking_findings: BlockingFinding[];
	/** Exact evidence references (file paths, line numbers, etc.) */
	evidence_references: string[];
	/** Conditions that must be met for a re-review to pass */
	pass_conditions: string[];
	/** Optional free-text summary */
	summary?: string;
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

/** Read and parse the receipt index. Returns an empty index if missing. */
async function readReceiptIndex(directory: string): Promise<ReceiptIndex> {
	const indexPath = resolveReceiptIndexPath(directory);
	if (!fs.existsSync(indexPath)) {
		return { schema_version: 1, entries: [] };
	}
	try {
		const content = await fs.promises.readFile(indexPath, 'utf-8');
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
): Promise<void> {
	const indexPath = resolveReceiptIndexPath(directory);
	const dir = path.dirname(indexPath);
	await fs.promises.mkdir(dir, { recursive: true });
	const tmpPath = `${indexPath}.tmp.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2)}`;
	await fs.promises.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf-8');
	fs.renameSync(tmpPath, indexPath);
}

/**
 * Persist a review receipt (rejected or approved) to disk.
 * Creates .swarm/review-receipts/<date>-<id>.json and updates the index.
 * Returns the absolute path of the written receipt file.
 */
export async function persistReviewReceipt(
	directory: string,
	receipt: ReviewReceipt,
): Promise<string> {
	const receiptsDir = resolveReceiptsDir(directory);
	await fs.promises.mkdir(receiptsDir, { recursive: true });

	const now = new Date(receipt.reviewed_at);
	const filename = buildReceiptFilename(receipt.id, now);
	const receiptPath = path.join(receiptsDir, filename);

	// Atomic write
	const tmpPath = `${receiptPath}.tmp.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2)}`;
	await fs.promises.writeFile(
		tmpPath,
		JSON.stringify(receipt, null, 2),
		'utf-8',
	);
	fs.renameSync(tmpPath, receiptPath);

	// Update index
	const index = await readReceiptIndex(directory);
	const entry: ReceiptIndexEntry = {
		id: receipt.id,
		verdict: receipt.verdict,
		reviewed_at: receipt.reviewed_at,
		scope_hash: receipt.scope_fingerprint.hash,
		agent: receipt.reviewer.agent,
		filename,
	};
	index.entries.push(entry);
	await writeReceiptIndex(directory, index);

	return receiptPath;
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

	const receiptPath = path.join(resolveReceiptsDir(directory), entry.filename);
	try {
		const content = await fs.promises.readFile(receiptPath, 'utf-8');
		return JSON.parse(content) as ReviewReceipt;
	} catch {
		return null;
	}
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
		const receiptPath = path.join(
			resolveReceiptsDir(directory),
			entry.filename,
		);
		try {
			const content = await fs.promises.readFile(receiptPath, 'utf-8');
			receipts.push(JSON.parse(content) as ReviewReceipt);
		} catch {
			// Skip unreadable receipts
		}
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
		const receiptPath = path.join(
			resolveReceiptsDir(directory),
			entry.filename,
		);
		try {
			const content = await fs.promises.readFile(receiptPath, 'utf-8');
			receipts.push(JSON.parse(content) as ReviewReceipt);
		} catch {
			// Skip unreadable receipts
		}
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
			lines.push(
				`- REJECTED by ${r.reviewer.agent} at ${r.reviewed_at.slice(0, 10)}: ` +
					`${r.blocking_findings.length} blocking finding(s). ` +
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
