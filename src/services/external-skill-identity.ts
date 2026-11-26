/**
 * External-skill artifact identity (#3822).
 *
 * Approval of an external-skill candidate is bound to the VERIFIED BYTES of
 * the promoted artifact, recorded in the structured candidate store
 * (`<project>/.swarm/skills/candidates/<uuid>.json` — the promotion history
 * entry's `target_path` + `promoted_content_hash`), never to the mutable
 * artifact frontmatter. This module owns the primitives every
 * trust-consumption point shares:
 *
 *   - `computeArtifactDigest` — the canonical, non-self-referential digest.
 *   - `lookupPromotionRecordByPathSync` — path-first promotion-record
 *     resolution from the structured store.
 *   - `withPromotionRecordIndex` — per-call scope that amortizes ONE bounded
 *     store scan across every verification inside the scope (RP-002).
 *   - `verifyPromotedExternalSkillSync` — digest enforcement for artifacts
 *     under `.opencode/skills/generated/` (used by the propagation gate).
 *
 * ## Threat model (PR #3942 feedback, decided policy)
 *
 * The binding defeats tampering with the generated ARTIFACT. An actor who
 * can write `.swarm/skills/candidates/` can already delete or corrupt a
 * record — that is outside the guarantee. The policy that follows from it:
 *
 *   - Artifact WITH a provenance claim (leading-frontmatter
 *     `skill_origin: promoted_external` / `promoted_from: …`): requires a
 *     determinate matching record + digest match; an indeterminate lookup
 *     (bound hit, corrupt/oversized/unreadable record, unreadable store)
 *     refuses, naming the cause and the bounded record file NAME — never
 *     record content (FB-101/RP-001).
 *   - Artifact WITHOUT a provenance claim and no readable matching record:
 *     accepted as an ordinary generated skill EVEN IF the scan is
 *     indeterminate. A corrupt or oversized UNRELATED record must never
 *     block ordinary skills.
 *   - Bounded-head claim rule (Stage B round 2): the claim state is decided
 *     from the first PROVENANCE_HEAD_BYTES (64 KiB) of the artifact. An
 *     artifact whose leading `---` fence does not CLOSE within that window
 *     while the file is longer has an UNVERIFIABLE claim state and is
 *     refused (`FRONTMATTER_BOUND_REFUSAL`) whenever no readable record
 *     binds its path — including an indeterminate scan. Deterministically
 *     fail-closed: a marker hidden beyond the head can never ride through
 *     as "ordinary". Frontmatter that closes within the window keeps the
 *     normal semantics, and a file SHORTER than the window whose fence
 *     never closes is deterministically scanned whole.
 *   - Path-first binding: a readable record whose CURRENT
 *     `evaluation_verdict` is `promoted` and whose target matches the
 *     artifact path binds the digest even when provenance was stripped.
 *     Records with any other current verdict (a successful revoke stamps
 *     `revoked`) never bind; when several records match one path the
 *     `promoted` one wins regardless of scan order (FB-102). An artifact
 *     restored with a provenance claim and no promoted record is refused as
 *     an orphan claim — stripped provenance is indistinguishable from a
 *     brand-new ordinary skill, which is why a revoked record cannot shadow
 *     one.
 *
 * ## Canonical digest — exact bytes
 *
 * `computeArtifactDigest(content)` returns the lowercase-hex SHA-256 of the
 * complete `content` string (UTF-8 bytes) after replacing the FIRST line
 * that is exactly `content_digest: <64 lowercase hex | pending>` — the
 * artifact's own digest line — with the fixed ASCII placeholder
 * line `content_digest: <recorded>`. Replacing rather than deleting the
 * line keeps the digest stable when the line's VALUE changes, which is
 * exactly what happens when the digest is stamped into the frontmatter at
 * promotion time. Only that exact grammar is masked: a digest line carrying
 * any other value or trailing bytes (CR-only payload, U+2028, free text)
 * hashes as-is, so bytes hidden on the line stay covered (CS-002/FB-207,
 * NF-1). An artifact without such a line hashes as-is — byte-identical to the pre-#3822
 * whole-file SHA-256, so `promoted_content_hash` values written by earlier
 * releases (raw whole-file hashes) keep verifying.
 *
 * ## Legacy rule (approved owner decision ASK-2)
 *
 * A promoted-external artifact whose promotion record carries NO structured
 * full-file hash (`promoted_content_hash` absent) is still accepted when the
 * record exists and the candidate's OLD body-only `sha256` matches the
 * artifact's body — everything after the closing frontmatter divider with the
 * single separator newline stripped (the byte layout every promote release
 * has written). This keeps already-promoted skills loadable; every promotion
 * performed after this change carries the structured hash.
 *
 * ## Sync/async reconciliation (#3822 K1(d) — implementation choice)
 *
 * `validateSkillReference` (skill-propagation-gate) is synchronous while the
 * candidate-store API is async. Rather than add a synchronous accessor to
 * the store (duplicating its parsing/containment logic), this module reads
 * the candidate JSON files directly, bounded per file
 * (`PROMOTION_RECORD_MAX_BYTES`, enforced on the OPEN file handle — RP-003)
 * and in file count (`MAX_PROMOTION_RECORD_FILES`). The scan is skipped
 * entirely when `<project>/.swarm/skills/candidates/` does not exist
 * (readdir ENOENT ⇒ not-found — IA-001); any other readdir error code makes
 * the scan indeterminate (`unreadable-store`). When a record file is
 * unreadable/corrupted/oversized, absence of a matching record cannot be
 * proven for a CLAIMED artifact and verification fails closed with a
 * cause-naming reason: silently skipping an unreadable record would let
 * whoever corrupted it hide that record's promotion identity.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Fixed placeholder line substituted for the artifact's own digest line
 * before hashing (keeps the digest non-self-referential).
 */
export const ARTIFACT_DIGEST_PLACEHOLDER_LINE = 'content_digest: <recorded>';

/** Byte bound for synchronous hashing of a promoted skill artifact (1 MiB). */
export const PROMOTED_ARTIFACT_MAX_BYTES = 1_048_576;

/**
 * Head bytes used for provenance-claim detection before any full read
 * (64 KiB). An artifact whose leading '---' fence does not CLOSE within this
 * window while the file is longer than the window has an UNVERIFIABLE claim
 * state and is refused unless a readable promotion record binds its path
 * (deterministic fail-closed rule — Stage B round 2; see
 * `promotionClaimState`).
 */
export const PROVENANCE_HEAD_BYTES = 65_536;

/**
 * Refusal for an unverifiable claim state: the artifact opens a frontmatter
 * fence that does not close within the provenance head while the file is
 * longer than the head, and no readable promotion record binds its path.
 */
const FRONTMATTER_BOUND_REFUSAL = `generated skill frontmatter exceeds the ${PROVENANCE_HEAD_BYTES}-byte provenance-verification bound; cannot determine whether it carries a promotion claim`;

/** Bound on candidate record files scanned per lookup (store default is 500). */
export const MAX_PROMOTION_RECORD_FILES = 1000;

/** Per-file byte bound while scanning candidate records (1 MiB). */
export const PROMOTION_RECORD_MAX_BYTES = 1_048_576;

/** Bound on the record file NAME surfaced in refusal reasons (defense only). */
const RECORD_NAME_REASON_MAX_CHARS = 128;

// ---------------------------------------------------------------------------
// DI seam — fs stubs (see AGENTS.md invariant 7: prefer _internals DI over
// mock.module). Tests replace individual operations and restore them in
// afterEach; no other module's seam is affected.
// ---------------------------------------------------------------------------

export const _internals: {
	readdirSync: typeof fs.readdirSync;
	openSync: typeof fs.openSync;
	fstatSync: typeof fs.fstatSync;
	readSync: typeof fs.readSync;
	closeSync: typeof fs.closeSync;
	realpathSync: typeof fs.realpathSync;
} = {
	readdirSync: fs.readdirSync.bind(fs),
	openSync: fs.openSync.bind(fs),
	fstatSync: fs.fstatSync.bind(fs),
	readSync: fs.readSync.bind(fs),
	closeSync: fs.closeSync.bind(fs),
	realpathSync: fs.realpathSync.bind(fs),
};

/** A promotion record resolved from the structured candidate store. */
export interface PromotedExternalRecord {
	/** Candidate UUID that owns the promotion. */
	candidateId: string;
	/** Resolved absolute target path recorded at promotion. */
	targetPath: string;
	/** Canonical full-file digest (`promoted_content_hash`). Legacy records may lack it. */
	promotedContentHash?: string;
	/** Candidate body-only sha256 (the pre-#3822 identity, legacy ASK-2 path). */
	bodySha256?: string;
}

/**
 * Why a store scan could not prove absence of a matching record.
 * Callers fail closed for CLAIMED artifacts only (see the module header).
 */
export type PromotionRecordIndeterminateReason =
	| 'over-cap'
	| 'corrupt-record'
	| 'oversized-record'
	| 'unreadable-record'
	| 'unreadable-store';

/**
 * Path-first lookup outcome.
 *
 * `indeterminate` carries the CAUSE and a bounded detail: the record file
 * NAME for record-level causes, the offending count for `over-cap`, and the
 * error code for `unreadable-store`. Never record content.
 */
export type PromotionRecordLookup =
	| { status: 'found'; record: PromotedExternalRecord }
	| { status: 'not-found' }
	| {
			status: 'indeterminate';
			reason: PromotionRecordIndeterminateReason;
			detail?: string;
	  };

// ---------------------------------------------------------------------------
// Canonical digest
// ---------------------------------------------------------------------------

/**
 * Compute the canonical artifact digest (#3822 K1(b)).
 *
 * See the module docstring for the exact byte specification. Deterministic
 * for a given artifact content regardless of the VALUE on the artifact's own
 * `content_digest:` line — which is what makes stamping the digest into the
 * frontmatter possible without invalidating the record.
 *
 * Canonicalization note (CS-002/FB-207, NF-1): only an exact digest line
 * (value 64 lowercase hex or `pending`, ended by LF, CRLF or end of input)
 * is replaced; a CR-only ending or any trailing byte leaves the line hashed
 * as-is. This canonicalization has never shipped in a release —
 * `promoted_content_hash` values computed with the older CR-accepting form
 * exist only in this PR's own test fixtures — so no stored-hash migration
 * is needed for the fix.
 */
export function computeArtifactDigest(content: string): string {
	// Mask ONLY a digest line whose value is exactly 64 lowercase hex chars (or
	// the promote-time draft token `pending`) followed by LF, CRLF or end of
	// input. Any other value — trailing text, CR-only payload, U+2028 — is
	// hashed as-is, so payload hidden on the digest line cannot verify (NF-1).
	// No `m` flag: `$`/`^` under `/m` also match at U+2028/U+2029.
	const canonical = content.replace(
		/(^|\n)content_digest: (?:[a-f0-9]{64}|pending)(?=\r?\n|$)/,
		(_m, lead: string) => `${lead}${ARTIFACT_DIGEST_PLACEHOLDER_LINE}`,
	);
	return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Bounded fd reads (RP-003)
// ---------------------------------------------------------------------------

/** Discriminated outcome of a bounded fd read (never throws for fs errors). */
export type BoundedReadResult =
	| { ok: true; content: string; size: number }
	| { ok: false; code: 'not-regular-file' }
	| { ok: false; code: 'exceeds-bound' }
	| { ok: false; code: 'changed-during-read' }
	| { ok: false; code: 'unreadable' };

/**
 * Bounded synchronous read over ONE file handle (RP-003): open once, fstat
 * THE HANDLE, reject when the handle's own size exceeds `limitBytes`, and
 * read at most cap+1 bytes, where cap = min(st.size, limitBytes) is taken
 * from the OPEN handle's fstat (so a stat/read race can never admit more
 * bytes than the bound). The extra byte DETECTS growth: when more than
 * st.size bytes arrive the file changed during the read, and the read fails
 * closed with the distinct `changed-during-read` code instead of returning
 * truncated bytes as success. The allocation stays cap+1 ≤ limitBytes+1, so
 * a store full of small records never allocates the full per-record bound.
 * The handle is closed in `finally` on every path.
 */
export function readBoundedFileSync(
	filePath: string,
	limitBytes: number,
): BoundedReadResult {
	let fd: number;
	try {
		fd = _internals.openSync(filePath, 'r');
	} catch {
		return { ok: false, code: 'unreadable' };
	}
	try {
		let st: fs.Stats;
		try {
			st = _internals.fstatSync(fd);
		} catch {
			return { ok: false, code: 'unreadable' };
		}
		if (!st.isFile()) return { ok: false, code: 'not-regular-file' };
		if (st.size > limitBytes) return { ok: false, code: 'exceeds-bound' };
		const cap = st.size;
		const buffer = Buffer.alloc(cap + 1);
		let bytesRead = 0;
		while (bytesRead <= cap) {
			let n: number;
			try {
				n = _internals.readSync(
					fd,
					buffer,
					bytesRead,
					cap + 1 - bytesRead,
					bytesRead,
				);
			} catch {
				return { ok: false, code: 'unreadable' };
			}
			if (n <= 0) break;
			bytesRead += n;
		}
		if (bytesRead > cap) {
			// The file grew after the fstat — the bytes are not the ones the
			// bound was computed over, so refuse rather than hash a mix.
			return { ok: false, code: 'changed-during-read' };
		}
		return {
			ok: true,
			content: buffer.toString('utf-8', 0, bytesRead),
			size: bytesRead,
		};
	} finally {
		try {
			_internals.closeSync(fd);
		} catch {
			// Best-effort close — the outcome above is already decided.
		}
	}
}

/**
 * Bounded HEAD read for provenance-claim detection (Stage B round 2): reads
 * min(size, PROVENANCE_HEAD_BYTES) bytes over ONE fd handle (the same
 * open/fstat/read/close-finally mechanism as `readBoundedFileSync`) and
 * returns the FULL file size alongside the head so the caller can
 * distinguish a file whose frontmatter fence simply never closes (whole
 * file visible — deterministically scannable) from one whose fence closes
 * beyond the head (claim state unverifiable). Never rejects on size.
 */
function readHeadSync(
	filePath: string,
):
	| { content: string; size: number }
	| { code: 'not-regular-file' }
	| { code: 'unreadable' } {
	let fd: number;
	try {
		fd = _internals.openSync(filePath, 'r');
	} catch {
		return { code: 'unreadable' };
	}
	try {
		let st: fs.Stats;
		try {
			st = _internals.fstatSync(fd);
		} catch {
			return { code: 'unreadable' };
		}
		if (!st.isFile()) return { code: 'not-regular-file' };
		const cap = Math.min(st.size, PROVENANCE_HEAD_BYTES);
		const buffer = Buffer.alloc(cap);
		let bytesRead = 0;
		while (bytesRead < cap) {
			let n: number;
			try {
				n = _internals.readSync(
					fd,
					buffer,
					bytesRead,
					cap - bytesRead,
					bytesRead,
				);
			} catch {
				return { code: 'unreadable' };
			}
			if (n <= 0) break;
			bytesRead += n;
		}
		return { content: buffer.toString('utf-8', 0, bytesRead), size: st.size };
	} finally {
		try {
			_internals.closeSync(fd);
		} catch {
			// Best-effort close.
		}
	}
}

// ---------------------------------------------------------------------------
// Provenance detection helpers
// ---------------------------------------------------------------------------

/** Frontmatter lines that mark an artifact as a promoted external skill. */
const PROMOTED_PROVENANCE_LINES = new Set([
	'skill_origin: promoted_external',
	'promoted_from: external-skill-candidate',
]);

/**
 * Extract the LEADING frontmatter block (`---` ... `---`) of the head, or
 * null when the content does not start with one (FB-108).
 *
 * When the artifact opens a `---` fence that never closes within the given
 * content, everything after the opening fence is treated as the
 * (unterminated) block — correct only when the WHOLE file is visible; the
 * verifier distinguishes that case from a truncated head via
 * `promotionClaimState` below.
 */
function extractLeadingFrontmatterBlock(head: string): string | null {
	const complete = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
	if (complete) return complete[1] ?? null;
	const open = /^---\r?\n([\s\S]*)$/.exec(head);
	if (open) return open[1] ?? null;
	return null;
}

/** True when the block contains a promoted-provenance marker line. */
function blockCarriesClaimMarker(block: string): boolean {
	for (const rawLine of block.split('\n')) {
		if (PROMOTED_PROVENANCE_LINES.has(rawLine.trim())) return true;
	}
	return false;
}

/**
 * The artifact's promotion-claim state under the bounded head (Stage B
 * round 2 deterministic rule):
 *
 *  - 'claimed'     — a marker line sits in the leading frontmatter block
 *                    (complete block, or an unterminated block whose whole
 *                    file is visible, which is deterministically scannable).
 *  - 'unclaimed'   — no leading fence at all, or a complete block without a
 *                    marker. Marker text in the BODY after a complete block
 *                    is prose, not a claim (FB-108).
 *  - 'unverifiable'— the artifact opens a fence that does not close within
 *                    the head AND the file is longer than the head: whether
 *                    a marker lies beyond the cutoff cannot be determined,
 *                    so verification must refuse (unless a readable
 *                    promotion record binds the path — the path-first
 *                    digest flow does not depend on the claim state).
 */
export type PromotionClaimState = 'claimed' | 'unclaimed' | 'unverifiable';

function promotionClaimState(
	head: string,
	fileLongerThanHead: boolean,
): PromotionClaimState {
	const complete = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
	if (complete) {
		return blockCarriesClaimMarker(complete[1] ?? '') ? 'claimed' : 'unclaimed';
	}
	const open = /^---\r?\n/.exec(head);
	if (!open) return 'unclaimed';
	if (fileLongerThanHead) return 'unverifiable';
	// Unterminated fence, whole file visible: every remaining byte is
	// frontmatter — deterministic claim detection over it.
	return blockCarriesClaimMarker(head.slice(open[0].length))
		? 'claimed'
		: 'unclaimed';
}

/** Extract `candidate_id` from the leading frontmatter block, if present. */
function extractFrontmatterCandidateId(head: string): string | null {
	const block = extractLeadingFrontmatterBlock(head);
	if (block === null) return null;
	for (const rawLine of block.split('\n')) {
		const match = /^candidate_id:[ \t]*(\S+)$/.exec(rawLine.trim());
		if (match) return match[1] ?? null;
	}
	return null;
}

/**
 * Shared promoted-provenance claim predicate (Stage B FB-103): the SAME
 * frontmatter-only logic `verifyPromotedExternalSkillSync` uses — the
 * leading `--- ... ---` block, never body prose — recognizing BOTH marker
 * lines (`skill_origin: promoted_external` AND `promoted_from:
 * external-skill-candidate`). Consumers that were checking only
 * `skill_origin === 'promoted_external'` missed artifacts claiming
 * provenance through the other marker.
 *
 * Stage B round 2 consistency: callers hold the FULL artifact content, but
 * the decision MIRRORS the verifier's bounded-head policy exactly (the head
 * window is PROVENANCE_HEAD_BYTES bytes): an artifact whose fence does not
 * close within that window while the content is longer is
 * CLAIMED-BY-POLICY (returns true) — the verifier refuses it as
 * unverifiable, so the sweep and regenerateSkill must skip/refuse it too
 * rather than mutate bytes the gate will not load. A file shorter than the
 * window whose fence never closes is deterministically scanned whole.
 */
export function artifactCarriesPromotionClaim(content: string): boolean {
	const bytes = Buffer.from(content, 'utf-8');
	const head = bytes.subarray(0, PROVENANCE_HEAD_BYTES).toString('utf-8');
	const state = promotionClaimState(head, bytes.length > PROVENANCE_HEAD_BYTES);
	// 'claimed' and 'unverifiable' both count as claimed-by-policy.
	return state !== 'unclaimed';
}

/**
 * Extract the artifact body (everything after the closing frontmatter
 * divider, with the single separator newline stripped) — the legacy ASK-2
 * comparison basis. Returns `null` when no frontmatter block is present.
 */
function extractBodyAfterFrontmatter(content: string): string | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return null;
	const body = match[2] ?? '';
	if (body.startsWith('\r\n')) return body.slice(2);
	if (body.startsWith('\n')) return body.slice(1);
	return body;
}

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

/** Case-normalized path key (win32 paths compare case-insensitively). */
function pathIdentityKey(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Both stable identities of a path: the lexically resolved form and (when it
 * exists) the realpath form. Two spellings of the same file (e.g. a store
 * record written through a symlinked project root) match on at least one key.
 */
function pathIdentityKeys(absolutePath: string): Set<string> {
	const keys = new Set<string>([pathIdentityKey(absolutePath)]);
	try {
		keys.add(pathIdentityKey(_internals.realpathSync(absolutePath)));
	} catch {
		// Missing or unreadable — the resolved form is the only identity.
	}
	return keys;
}

// ---------------------------------------------------------------------------
// Record resolution (bounded synchronous scan — see module docstring)
// ---------------------------------------------------------------------------

/** SHA-256 shape accepted for structured hashes. */
const HEX64_RE = /^[a-f0-9]{64}$/;

/**
 * The newest 'promoted' history entry that carries a structured
 * `target_path`. Automatic history entries lacking the field are skipped.
 * `promotedContentHash` is null when the entry is the legacy shape (ASK-2).
 */
function newestStructuredPromotionEntry(
	history: unknown,
): { targetPath: string; promotedContentHash: string | null } | null {
	if (!Array.isArray(history)) return null;
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (!entry || typeof entry !== 'object') continue;
		const record = entry as Record<string, unknown>;
		if (record.verdict !== 'promoted') continue;
		const targetPath =
			typeof record.target_path === 'string' ? record.target_path.trim() : '';
		if (!targetPath) continue;
		const promotedContentHash =
			typeof record.promoted_content_hash === 'string' &&
			HEX64_RE.test(record.promoted_content_hash)
				? record.promoted_content_hash
				: null;
		// The newest promoted entry carrying a target path is this candidate's
		// authoritative promotion identity; older entries are stale.
		return { targetPath, promotedContentHash };
	}
	return null;
}

/** One candidate record parsed during a scan. */
interface ScannedCandidateRecord {
	record: PromotedExternalRecord;
	targetKeys: Set<string>;
}

/** Result of one full bounded scan of the candidate store. */
interface PromotionIndexState {
	/** pathIdentityKey -> first matching promoted record (readdir order). */
	byPathKey: Map<string, PromotedExternalRecord>;
	/** First indeterminate cause seen during the scan, if any. */
	indeterminate: {
		reason: PromotionRecordIndeterminateReason;
		detail?: string;
	} | null;
}

/**
 * Build the path-key -> record index for a candidate store with the SAME
 * caps and indeterminate semantics as a single lookup (RP-002). Records
 * whose current `evaluation_verdict` is not `promoted` are skipped (FB-102).
 */
function buildPromotionIndex(directory: string): PromotionIndexState {
	const candidatesDir = path.join(directory, '.swarm', 'skills', 'candidates');

	let names: string[];
	try {
		names = _internals.readdirSync(candidatesDir);
	} catch (err) {
		const code =
			err && typeof err === 'object' && 'code' in err
				? String((err as { code?: unknown }).code)
				: '';
		// ENOENT is a determinate empty store; anything else (EACCES/EPERM/
		// ENOTDIR/...) cannot prove absence (IA-001).
		if (code === 'ENOENT') {
			return { byPathKey: new Map(), indeterminate: null };
		}
		return {
			byPathKey: new Map(),
			indeterminate: { reason: 'unreadable-store', detail: code || 'unknown' },
		};
	}

	const jsonNames = names.filter((name) => name.endsWith('.json'));
	if (jsonNames.length > MAX_PROMOTION_RECORD_FILES) {
		// DELIBERATE TRADE-OFF (documented in the release fragment): the cap
		// bounds the synchronous work done on the delegation hot path. Above it
		// NO record is read, so path-first enforcement of a readable matching
		// record is suspended for UNCLAIMED artifacts (a CLAIMED artifact is
		// still refused as indeterminate). Normal operation stays far below the
		// cap; an over-cap store requires out-of-band writes, which the
		// threat model above already places outside the binding's guarantee.
		return {
			byPathKey: new Map(),
			indeterminate: {
				reason: 'over-cap',
				detail: String(jsonNames.length),
			},
		};
	}

	const byPathKey = new Map<string, PromotedExternalRecord>();
	let indeterminate: PromotionIndexState['indeterminate'] = null;

	for (const name of jsonNames) {
		const file = path.join(candidatesDir, name);
		const raw = readBoundedFileSync(file, PROMOTION_RECORD_MAX_BYTES);
		if (!raw.ok) {
			// A corrupted/oversized/unreadable record could be the one that
			// binds this artifact — record the cause and keep scanning; a
			// readable matching record found later still wins.
			if (indeterminate === null) {
				const reason: PromotionRecordIndeterminateReason =
					raw.code === 'exceeds-bound'
						? 'oversized-record'
						: 'unreadable-record';
				indeterminate = {
					reason,
					detail: name.slice(0, RECORD_NAME_REASON_MAX_CHARS),
				};
			}
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.content);
		} catch {
			if (indeterminate === null) {
				indeterminate = {
					reason: 'corrupt-record',
					detail: name.slice(0, RECORD_NAME_REASON_MAX_CHARS),
				};
			}
			continue;
		}
		if (!parsed || typeof parsed !== 'object') continue;
		const candidate = parsed as Record<string, unknown>;

		// FB-102: only a CURRENTLY-promoted candidate binds its target path.
		// A successful revoke stamps `evaluation_verdict: 'revoked'` (the
		// older 'promoted' history entry keeps its target_path); skipping the
		// whole record here is what stops a revoked promotion from shadowing
		// its slug forever.
		if (candidate.evaluation_verdict !== 'promoted') continue;

		const promotion = newestStructuredPromotionEntry(
			candidate.evaluation_history,
		);
		if (!promotion) continue;

		const resolvedTarget = path.resolve(directory, promotion.targetPath);
		const scanned: ScannedCandidateRecord = {
			record: {
				candidateId:
					typeof candidate.id === 'string' && candidate.id.length > 0
						? candidate.id
						: name.replace(/\.json$/, ''),
				targetPath: resolvedTarget,
			},
			targetKeys: pathIdentityKeys(resolvedTarget),
		};
		if (promotion.promotedContentHash !== null) {
			scanned.record.promotedContentHash = promotion.promotedContentHash;
		}
		if (
			typeof candidate.sha256 === 'string' &&
			HEX64_RE.test(candidate.sha256)
		) {
			scanned.record.bodySha256 = candidate.sha256;
		}

		// First promoted record in readdir order wins a contested path
		// (matches the pre-index lookup; the promoted-verdict skip above is
		// what makes the choice order-independent between revoked/promoted).
		for (const key of scanned.targetKeys) {
			if (!byPathKey.has(key)) byPathKey.set(key, scanned.record);
		}
	}

	return { byPathKey, indeterminate };
}

/** Resolve one artifact's lookup from a built index. */
function lookupWithIndex(
	state: PromotionIndexState,
	artifactAbsolutePath: string,
): PromotionRecordLookup {
	const artifactKeys = pathIdentityKeys(artifactAbsolutePath);
	for (const key of artifactKeys) {
		const record = state.byPathKey.get(key);
		if (record !== undefined) return { status: 'found', record };
	}
	if (state.indeterminate !== null) {
		return { status: 'indeterminate', ...state.indeterminate };
	}
	return { status: 'not-found' };
}

/** The ambient per-call scope (RP-002). Null outside a scope. */
interface AmbientPromotionScope {
	/** pathIdentityKey the scope was opened for (reuse guard). */
	directoryKey: string;
	/** Lazily built on the FIRST lookup inside the scope. */
	index: PromotionIndexState | null;
}

let activePromotionScope: AmbientPromotionScope | null = null;

/**
 * Run `fn` with ONE bounded promotion-record index for `directory`
 * (RP-002): the store is scanned at most once — lazily, on the FIRST lookup
 * inside the scope — and every `lookupPromotionRecordByPathSync` /
 * `verifyPromotedExternalSkillSync` call made against the SAME directory
 * inside `fn` reuses it. The index is discarded when the scope exits —
 * there is NO cross-call persistence and no mtime-keyed cache, so two
 * sequential top-level calls always observe in-place record edits. A scope
 * in which no lookup happens never touches the store.
 *
 * `fn` must be SYNCHRONOUS: the scope is ambient module state, and an
 * `await` inside it would let a concurrent hook invocation observe (or
 * replace) it. Callers wrap individual synchronous loops, not async hook
 * bodies. A nested scope builds its own lazy index and restores the outer
 * scope afterwards.
 */
export function withPromotionRecordIndex<T>(directory: string, fn: () => T): T {
	const previous = activePromotionScope;
	activePromotionScope = {
		directoryKey: pathIdentityKey(directory),
		index: null,
	};
	try {
		return fn();
	} finally {
		activePromotionScope = previous;
	}
}

/**
 * The scope's index when a lookup for `directory` runs inside a matching
 * scope (building it on first use); null otherwise.
 */
function scopedIndexFor(directory: string): PromotionIndexState | null {
	const scope = activePromotionScope;
	if (scope === null || scope.directoryKey !== pathIdentityKey(directory)) {
		return null;
	}
	if (scope.index === null) scope.index = buildPromotionIndex(directory);
	return scope.index;
}

/**
 * Resolve the promotion record for an artifact BY CANONICAL PATH (#3822
 * K1(c)) — `candidate_id` frontmatter is NOT the lookup key, so deleting the
 * provenance fields cannot disguise a promoted artifact. Inside a
 * `withPromotionRecordIndex` scope for the same directory this resolves
 * against the scope's index (one scan per scope); otherwise it scans.
 */
export function lookupPromotionRecordByPathSync(
	directory: string,
	artifactAbsolutePath: string,
): PromotionRecordLookup {
	const index = scopedIndexFor(directory);
	if (index !== null) {
		return lookupWithIndex(index, artifactAbsolutePath);
	}
	return lookupWithIndex(buildPromotionIndex(directory), artifactAbsolutePath);
}

// ---------------------------------------------------------------------------
// Verification entry point (propagation gate)
// ---------------------------------------------------------------------------

/**
 * Human-readable refusal text for an indeterminate lookup: names the cause
 * and the bounded record file NAME (never content). The "synchronous
 * verification bound" phrase is reserved for the over-cap cause (FB-101).
 */
function indeterminateRefusalText(
	lookup: Extract<PromotionRecordLookup, { status: 'indeterminate' }>,
): string {
	switch (lookup.reason) {
		case 'over-cap':
			return `cannot verify generated skill identity — the external-skill candidate store exceeds the synchronous verification bound (${lookup.detail ?? '?'} record files > ${MAX_PROMOTION_RECORD_FILES})`;
		case 'corrupt-record':
			return `cannot verify generated skill identity — candidate record "${lookup.detail ?? '?'}" is corrupt (unparseable JSON)`;
		case 'oversized-record':
			return `cannot verify generated skill identity — candidate record "${lookup.detail ?? '?'}" exceeds the ${PROMOTION_RECORD_MAX_BYTES}-byte record bound`;
		case 'unreadable-record':
			return `cannot verify generated skill identity — candidate record "${lookup.detail ?? '?'}" is unreadable`;
		case 'unreadable-store':
			return `cannot verify generated skill identity — the external-skill candidate store directory is unreadable (${lookup.detail ?? 'unknown error'})`;
	}
}

/**
 * Verify a generated-root artifact against its promotion record (#3822 K1).
 *
 * Decision tree (see the module header for the threat model):
 *   - scan indeterminate + claim   → refuse (cannot prove absence), naming
 *                                    the cause and the record file name
 *   - scan indeterminate + no claim→ accept (a corrupt/oversized unrelated
 *                                    record never blocks ordinary skills)
 *   - no record + claim            → refuse (orphaned promotion claim)
 *   - no record + no claim         → accept (ordinary generated skill)
 *   - unverifiable claim state     → refuse with FRONTMATTER_BOUND_REFUSAL
 *                                    (fence unclosed within the 64 KiB head
 *                                    while the file is longer — Stage B
 *                                    round 2 deterministic fail-closed rule)
 *                                    whenever no readable record binds the
 *                                    path, INCLUDING an indeterminate scan
 *   - record found (path-first)    → frontmatter candidate_id, when present,
 *                                    must agree with the record; then the
 *                                    canonical digest (or, for legacy
 *                                    records without a structured hash, the
 *                                    body-only sha256) must match the
 *                                    on-disk bytes. The claim state is
 *                                    irrelevant here: the readable record's
 *                                    digest binding is authoritative.
 *
 * Fail-closed on mismatch, missing digest, unreadable, or oversized files.
 */
export function verifyPromotedExternalSkillSync(
	directory: string,
	artifactAbsolutePath: string,
): { ok: true } | { ok: false; reason: string } {
	const head = readHeadSync(artifactAbsolutePath);
	if ('code' in head) {
		return {
			ok: false,
			reason:
				head.code === 'not-regular-file'
					? 'promoted skill artifact is not a regular file'
					: 'promoted skill artifact is unreadable',
		};
	}
	const claimState = promotionClaimState(
		head.content,
		head.size > PROVENANCE_HEAD_BYTES,
	);

	const lookup = lookupPromotionRecordByPathSync(
		directory,
		artifactAbsolutePath,
	);
	if (lookup.status === 'indeterminate') {
		if (claimState === 'unclaimed') return { ok: true };
		if (claimState === 'unverifiable') {
			return { ok: false, reason: FRONTMATTER_BOUND_REFUSAL };
		}
		return { ok: false, reason: indeterminateRefusalText(lookup) };
	}
	if (lookup.status === 'not-found') {
		if (claimState === 'unverifiable') {
			return { ok: false, reason: FRONTMATTER_BOUND_REFUSAL };
		}
		if (claimState === 'claimed') {
			return {
				ok: false,
				reason:
					'promoted external skill has no matching promotion record in the candidate store',
			};
		}
		return { ok: true };
	}

	// Record found — the path (not the frontmatter) owns the identity.
	const frontCandidateId = extractFrontmatterCandidateId(head.content);
	if (
		frontCandidateId !== null &&
		frontCandidateId !== lookup.record.candidateId
	) {
		return {
			ok: false,
			reason: `promoted external skill candidate_id mismatch (frontmatter "${frontCandidateId}" does not match the recorded promotion)`,
		};
	}

	const content = readBoundedFileSync(
		artifactAbsolutePath,
		PROMOTED_ARTIFACT_MAX_BYTES,
	);
	if (!content.ok) {
		return {
			ok: false,
			reason:
				content.code === 'exceeds-bound'
					? `promoted skill artifact exceeds the ${PROMOTED_ARTIFACT_MAX_BYTES}-byte digest bound`
					: content.code === 'not-regular-file'
						? 'promoted skill artifact is not a regular file'
						: content.code === 'changed-during-read'
							? 'promoted skill artifact changed while being read'
							: 'promoted skill artifact is unreadable',
		};
	}

	if (lookup.record.promotedContentHash !== undefined) {
		const digest = computeArtifactDigest(content.content);
		if (digest !== lookup.record.promotedContentHash) {
			return {
				ok: false,
				reason:
					'promoted external skill content digest does not match the recorded promotion hash',
			};
		}
		return { ok: true };
	}

	// Legacy record without a structured full-file hash (approved ASK-2):
	// accept when the OLD body-only sha256 still matches the artifact body.
	if (lookup.record.bodySha256 === undefined) {
		return {
			ok: false,
			reason: 'promotion record carries no verifiable content hash',
		};
	}
	const body = extractBodyAfterFrontmatter(content.content);
	if (
		body === null ||
		createHash('sha256').update(body).digest('hex') !== lookup.record.bodySha256
	) {
		return {
			ok: false,
			reason:
				'promoted external skill body no longer matches the recorded candidate hash',
		};
	}
	return { ok: true };
}
