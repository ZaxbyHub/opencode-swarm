/**
 * #2969 (fix plan 05 v8 §2.6): read-only store integrity report behind
 * `/swarm config doctor --integrity`.
 *
 * Six bounded, read-only categories over the local `.swarm` store (see
 * docs/plan-durability.md "Store integrity report"). NOTHING in this module
 * mutates the store — every operation is a stat/read/readdir; there is no
 * repair, quarantine, unlink, or write path anywhere below.
 *
 * `stale_locks` carries a REPORT-ONLY sub-class: a `.lck` whose owner pid is
 * ALIVE past the TTL (the PID-reuse corner of plan 05 v8 §1.1, r6-#2). It is
 * surfaced with a manual-recovery note and deliberately NOT counted toward
 * `integrity_issues_total` — no time window ever converts a live pid into a
 * dead classification, and this report must never motivate one either.
 *
 * INVARIANT 1 (AGENTS.md): wired exclusively into the interactive
 * `handleDoctorCommand` behind the exact-match `--integrity` flag — never
 * into `runConfigDoctor`/`runConfigDoctorWithFixes`, so nothing here can run
 * on the plugin startup path. All walks are entry/depth-bounded and every
 * category fails open (an fs error reports 0 with a note instead of blocking
 * the doctor's structural report).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MEMORY_FAMILY } from '../memory/memory-family-manifest.js';
import {
	MEMBER_RECENCY_KEYS,
	rowId,
	rowRecency,
} from '../memory/memory-family-migration.js';
import {
	MEMORY_LINK_POINTER_FILENAME,
	readMemoryLinkPointer,
	resolveLinkDir,
} from '../memory/memory-link.js';
import {
	LOCK_TIMEOUT_MS,
	readOwnerLockPayload,
} from '../parallel/file-locks.js';
import { RESIDUE_SKIP_DIRS } from '../services/swarm-residue.js';
import { matchTempGrammar } from '../utils/atomic-write.js';

/** Per-category cap on listed entry lines (the counts themselves stay exact). */
const MAX_LISTED = 20;
/** Bounded `.swarm` walk budget for the file categories (entries / depth). */
const MAX_SCAN_ENTRIES = 2000;
const MAX_SCAN_DEPTH = 8;
/** Torn-tail probes read at most this many bytes from the end of a JSONL
 *  file. Feedback PRR-015: the events store's legal max line is 256 KiB
 *  (MAX_EVENT_SIZE, src/events/core-events.ts) — a 64 KiB window reported a
 *  healthy store's full-size tail line as torn (false positive). The window
 *  must exceed the largest legal line, plus newline/UTF-8 slack. */
const TAIL_READ_BYTES = 288 * 1024;
/** Per-member row cap for the memory divergence comparison. */
const MAX_MEMBER_LINES = 20_000;
/** Feedback PRR-022: whole-file member reads are bounded — this is the
 *  per-file byte cap behind the row cap (a member file larger than this is
 *  read truncated; the parse loop's existing 20k-line cap already governs
 *  semantics, so truncation only tightens the bound, never falsifies it). */
const MAX_MEMBER_FILE_BYTES = 4 * 1024 * 1024;
/** Feedback PRR-022: stale-locks walk entry cap (a poisoned locks/ dir with
 *  millions of entries cannot turn the doctor into an unbounded walk; the
 *  substrate sweep and residue scanner use the same bounded-walk discipline). */
const MAX_LOCK_ENTRIES = 1000;
/** Feedback PRR-017: a lock/marker artifact bigger than this is foreign —
 *  payloads and markers are sub-KiB JSON; anything larger is not parsed. */
const MAX_LOCK_ARTIFACT_BYTES = 64 * 1024;
const BAK_SUFFIX = '.bak';

interface CategoryReport {
	/** Actionable count — the only value summed into the total. */
	count: number;
	listed: string[];
	/** Report-only entries are listed but excluded from `count`. */
	reportOnly?: string[];
	note?: string;
}

interface WalkResult {
	tempRel: string[];
	bakRel: string[];
	truncated: boolean;
}

/** readdir-sourced names may carry adversarial characters — strip C0/DEL
 *  control chars first (feedback PRR-018: backtick-only neutralization let
 *  `\n` + forged rows through into the report — the same class doctor.ts's
 *  own sanitizer strips), then neutralize backticks (markdown code-span
 *  breakout) exactly like the residue inventory renderer
 *  (src/services/swarm-residue.ts) does. */
function safeName(s: string): string {
	return s.replace(/[\p{Cc}]/gu, '').replace(/`/g, "'");
}

/**
 * Render the read-only integrity section (including the leading
 * `'\n---\n\n## <Title>\n\n'` separator, per the doctor section convention).
 * Async for signature symmetry with the other doctor section renderers; all
 * filesystem work here is synchronous and read-only.
 */
export async function renderStoreIntegritySection(
	directory: string,
): Promise<string> {
	const swarmRoot = path.join(directory, '.swarm');
	const now = Date.now();
	const swarmExists = fs.existsSync(swarmRoot);

	const walk = safeValue(
		() => (swarmExists ? walkSwarmTree(swarmRoot) : emptyWalk()),
		emptyWalk(),
	);

	const reports: Array<[string, CategoryReport]> = [
		[
			'ledger_torn_tail',
			safeCategory(() =>
				tornCategory(
					path.join(swarmRoot, 'plan-ledger.jsonl'),
					'plan-ledger.jsonl',
				),
			),
		],
		[
			'events_torn_tail',
			safeCategory(() =>
				tornCategory(path.join(swarmRoot, 'events.jsonl'), 'events.jsonl'),
			),
		],
		['temp_artifacts', safeCategory(() => tempCategory(walk))],
		['stale_locks', safeCategory(() => checkStaleLocks(swarmRoot, now))],
		['orphaned_bak', safeCategory(() => bakCategory(swarmRoot, walk))],
		[
			'memory_same_id_divergences',
			safeCategory(() => checkMemoryDivergences(directory, swarmRoot)),
		],
	];

	const lines: string[] = [];
	lines.push(
		'Read-only crash-consistency audit of the local `.swarm` store. This report never mutates, repairs, quarantines, or deletes anything.',
	);
	if (!swarmExists) {
		lines.push('No `.swarm` directory found — every category is 0.');
	}
	let total = 0;
	for (const [key, report] of reports) {
		total += report.count;
		lines.push(...renderCategory(key, report));
	}
	lines.push(`integrity_issues_total: ${total}`);
	return `\n---\n\n## Store Integrity Report (read-only)\n\n${lines.join('\n')}\n`;
}

function renderCategory(key: string, report: CategoryReport): string[] {
	const lines = [
		`- ${key}: ${report.count}${report.note ? ` (${report.note})` : ''}`,
	];
	for (const entry of report.listed.slice(0, MAX_LISTED)) {
		lines.push(`  - ${entry}`);
	}
	if (report.listed.length > MAX_LISTED) {
		lines.push(`  - … and ${report.listed.length - MAX_LISTED} more`);
	}
	for (const entry of (report.reportOnly ?? []).slice(0, MAX_LISTED)) {
		lines.push(`  - ${entry}`);
	}
	if ((report.reportOnly ?? []).length > MAX_LISTED) {
		lines.push(
			`  - … and ${(report.reportOnly ?? []).length - MAX_LISTED} more (report-only, not counted)`,
		);
	}
	return lines;
}

/** Every category fails open: an fs error reports 0 with a note instead of
 *  blocking the doctor's structural report. */
function safeCategory(compute: () => CategoryReport): CategoryReport {
	try {
		return compute();
	} catch {
		return { count: 0, listed: [], note: 'unreadable (reported as 0)' };
	}
}

function safeValue<T>(compute: () => T, fallback: T): T {
	try {
		return compute();
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------------------
// Categories 1 + 2: torn JSONL tails
// ---------------------------------------------------------------------------

/** Why a JSONL tail is torn. */
type TornReason =
	| 'last line not newline-terminated'
	| 'last line not valid JSON';

/**
 * Bounded torn-tail probe: read at most the final TAIL_READ_BYTES and test
 * the last CONTENT line. A crash mid-append leaves either a non-terminated
 * final line or a partial (unparsable) one. Missing/empty file = not torn.
 */
function checkTornTail(absPath: string): TornReason | null {
	let size = 0;
	try {
		size = fs.statSync(absPath).size;
	} catch {
		return null; // missing file = 0 for this category
	}
	if (size === 0) return null;
	const len = Math.min(TAIL_READ_BYTES, size);
	const fd = fs.openSync(absPath, 'r');
	try {
		const buf = Buffer.alloc(len);
		const read = fs.readSync(fd, buf, 0, len, size - len);
		const text = buf.toString('utf-8', 0, read);
		if (!text.endsWith('\n')) return 'last line not newline-terminated';
		let body = text.slice(0, -1);
		while (body.endsWith('\n')) body = body.slice(0, -1);
		if (body.length === 0) return null; // newline-only file: no content line
		const lineStart = body.lastIndexOf('\n') + 1;
		try {
			JSON.parse(body.slice(lineStart).trim());
			return null;
		} catch {
			return 'last line not valid JSON';
		}
	} finally {
		fs.closeSync(fd);
	}
}

function tornCategory(absPath: string, rel: string): CategoryReport {
	const reason = checkTornTail(absPath);
	if (reason === null) return { count: 0, listed: [] };
	return { count: 1, listed: [`\`${safeName(rel)}\` (${reason})`] };
}

// ---------------------------------------------------------------------------
// Categories 3 + 5: bounded `.swarm` walk (temp artifacts, orphaned .bak)
// ---------------------------------------------------------------------------

function emptyWalk(): WalkResult {
	return { tempRel: [], bakRel: [], truncated: false };
}

/**
 * One bounded walk (max MAX_SCAN_ENTRIES entries, depth MAX_SCAN_DEPTH)
 * collecting basenames that match a registered atomic-write temp grammar
 * (via `matchTempGrammar` — the single registry) and `.bak` candidates.
 * The archive/quarantine/locks subtrees are skipped for the same reasons
 * the residue inventory skips them (live-writer and retention territory).
 */
function walkSwarmTree(swarmRoot: string): WalkResult {
	const out = emptyWalk();
	let scanned = 0;
	const walk = (relDir: string, depth: number): void => {
		if (out.truncated) return;
		const absDir =
			relDir === '' ? swarmRoot : path.join(swarmRoot, ...relDir.split('/'));
		let dirents: fs.Dirent[];
		try {
			dirents = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			return; // unreadable subtree is not an integrity signal
		}
		for (const dirent of dirents) {
			if (++scanned > MAX_SCAN_ENTRIES) {
				out.truncated = true;
				return;
			}
			if (relDir === '' && RESIDUE_SKIP_DIRS.includes(dirent.name)) continue;
			const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
			if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
				if (depth + 1 <= MAX_SCAN_DEPTH) walk(rel, depth + 1);
				continue;
			}
			if (matchTempGrammar(dirent.name)) out.tempRel.push(rel);
			if (dirent.name.endsWith(BAK_SUFFIX)) out.bakRel.push(rel);
		}
	};
	walk('', 0);
	return out;
}

function truncatedNote(): string {
	return `scan truncated at ${MAX_SCAN_ENTRIES} entries — counts may be partial`;
}

function tempCategory(walk: WalkResult): CategoryReport {
	return {
		count: walk.tempRel.length,
		listed: walk.tempRel.map((rel) => `\`${safeName(rel)}\``),
		note: walk.truncated ? truncatedNote() : undefined,
	};
}

/** A `.bak` with no sibling canonical file is orphaned; a `.bak` beside its
 *  canonical file (the full-auto backup pattern) is intentional. */
function bakCategory(swarmRoot: string, walk: WalkResult): CategoryReport {
	const report: CategoryReport = {
		count: 0,
		listed: [],
		note: walk.truncated ? truncatedNote() : undefined,
	};
	for (const rel of walk.bakRel) {
		const abs = path.join(swarmRoot, ...rel.split('/'));
		const canonicalRel = rel.slice(0, -BAK_SUFFIX.length);
		if (fs.existsSync(abs.slice(0, -BAK_SUFFIX.length))) continue;
		report.count += 1;
		report.listed.push(
			`\`${safeName(rel)}\` (no sibling \`${safeName(canonicalRel)}\`)`,
		);
	}
	return report;
}

// ---------------------------------------------------------------------------
// Category 4: stale locks (actionable + the REPORT-ONLY live-pid sub-class)
// ---------------------------------------------------------------------------

/** Mirror of the substrate's payload validation (parseOwnerPayload in
 *  src/parallel/file-locks.ts): a REAL owner pid from a v1 payload, or null
 *  when the payload is absent/unparsable/non-v1/ownerless. Feedback PRR-011:
 *  the mirror previously accepted non-v1 payloads as live-owner candidates,
 *  contradicting the substrate (which breaks non-v1 past TTL) and making the
 *  report-only class wrong for malformed-payload locks. */
function parseOwnerPid(raw: string | null): number | null {
	if (raw === null || raw.length === 0) return null;
	try {
		const parsed = JSON.parse(raw) as { v?: unknown; ownerPid?: unknown };
		const pid = parsed?.ownerPid;
		if (
			parsed?.v === 1 &&
			typeof pid === 'number' &&
			Number.isSafeInteger(pid) &&
			pid > 0
		) {
			return pid;
		}
		return null;
	} catch {
		return null;
	}
}

/** Local liveness probe (process.kill(pid, 0)): ESRCH = provably dead;
 *  success/EPERM = alive — identical fail-safe semantics to `isPidAlive` in
 *  src/parallel/file-locks.ts (kept local so this report stays read-only
 *  against the substrate's DI seam). */
function isPidDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ESRCH';
	}
}

function checkStaleLocks(swarmRoot: string, now: number): CategoryReport {
	const report: CategoryReport = { count: 0, listed: [], reportOnly: [] };
	const locksDir = path.join(swarmRoot, 'locks');
	// Feedback PRR-004: `.swarm/events.lock` sits OUTSIDE the locks/ dir —
	// the doctor's promised report-only surface did not exist for the events
	// store's lock artifact. Classify it (and its break marker) here.
	const eventsLockPath = path.join(swarmRoot, 'events.lock');
	classifyLockArtifact(
		report,
		now,
		eventsLockPath,
		'events.lock',
		/* isDir */ false,
	);
	const eventsMarkerPath = `${eventsLockPath}.breaking`;
	if (
		fs.existsSync(eventsMarkerPath) &&
		!fs.lstatSync(eventsMarkerPath).isSymbolicLink()
	) {
		report.count += 1;
		report.listed.push(
			`\`events.lock.breaking\` (break marker present — live breaker protocol state or crash orphan)`,
		);
	}
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(locksDir, { withFileTypes: true });
	} catch {
		return report; // absent locks dir = 0 (the common case)
	}
	let scanned = 0;
	for (const dirent of dirents) {
		if (++scanned > MAX_LOCK_ENTRIES) {
			report.note = truncatedNote();
			break;
		}
		const abs = path.join(locksDir, dirent.name);
		const rel = `locks/${dirent.name}`;
		// Feedback PRR-017: never follow symlinks out of `.swarm` — the
		// residue scanner's refusal discipline (repo convention; an attacker-
		// planted symlink must not redirect the report's reads).
		if (dirent.isSymbolicLink()) continue;
		try {
			if (dirent.name.endsWith('.lck') && !dirent.isDirectory()) {
				classifyLockArtifact(report, now, abs, rel, /* isDir */ false);
			} else if (
				dirent.name.endsWith('.lock.lock') &&
				dirent.isDirectory() &&
				!dirent.isSymbolicLink()
			) {
				// Legacy proper-lockfile dir artifact (pre-#2967 substrate).
				classifyLockArtifact(report, now, abs, rel, /* isDir */ true);
			} else if (
				(dirent.name.includes('.breaking') || dirent.name.includes('.take.')) &&
				!dirent.isDirectory()
			) {
				// Feedback PRR-006/014 (doctor side): break markers and takeover
				// residue are listed (presence itself is diagnostic; the
				// substrate sweep owns removal past 60s).
				report.count += 1;
				report.listed.push(
					`\`${safeName(rel)}\` (break marker/takeover residue present)`,
				);
			} else if (dirent.name.endsWith('.lock') && !dirent.isDirectory()) {
				// Legacy sentinel FILE (`.lock`): listed when past TTL (the
				// substrate's isLocked legacy fallback covers these).
				if (now - fs.statSync(abs).mtimeMs <= LOCK_TIMEOUT_MS) continue;
				report.count += 1;
				report.listed.push(
					`\`${safeName(rel)}\` (legacy sentinel file, past TTL)`,
				);
			}
		} catch {
			/* per-entry fs errors are not integrity signals — skip the entry */
		}
	}
	return report;
}

/** Shared classifier for `.lck` and legacy `.lock.lock` dir artifacts.
 *  Feedback PRR-017/022: bounded stat + bounded read (a foreign oversized
 *  artifact is listed, not parsed). */
function classifyLockArtifact(
	report: CategoryReport,
	now: number,
	abs: string,
	rel: string,
	isDir: boolean,
): void {
	try {
		const stat = fs.statSync(abs);
		if (now - stat.mtimeMs <= LOCK_TIMEOUT_MS) return;
		if (stat.size > MAX_LOCK_ARTIFACT_BYTES) {
			report.count += 1;
			report.listed.push(
				`\`${safeName(rel)}\` (${stat.size} bytes — oversized foreign artifact, past TTL)`,
			);
			return;
		}
		if (isDir) {
			report.count += 1;
			report.listed.push(
				`\`${safeName(rel)}\` (legacy proper-lockfile dir, past TTL)`,
			);
			return;
		}
		const ownerPid = parseOwnerPid(readOwnerLockPayload(abs));
		if (ownerPid !== null && !isPidDead(ownerPid)) {
			// REPORT-ONLY sub-class (plan 05 v8 §1.1, r6-#2): a live owner
			// pid may be the PID-reuse corner. Never auto-removed; manual
			// recovery; automatic recovery resumes when the pid exits.
			report.reportOnly?.push(
				`\`${safeName(rel)}\` (report-only: live owner pid — manual recovery; never auto-removed)`,
			);
			return;
		}
		report.count += 1;
		report.listed.push(
			ownerPid === null
				? `\`${safeName(rel)}\` (unparsable owner payload, past TTL)`
				: `\`${safeName(rel)}\` (owner pid ${ownerPid} dead, past TTL)`,
		);
	} catch {
		/* per-entry fs errors are not integrity signals — skip the entry */
	}
}

// ---------------------------------------------------------------------------
// Category 6: same-id divergences across the linked cohort + local stores
// ---------------------------------------------------------------------------

interface MemberRows {
	/** id → the engine's recency value for that id's EFFECTIVE (last) row. */
	by: Map<string, number | undefined>;
	truncated: boolean;
}

/** Last-valid-row-wins per id — the engine's own load semantics
 *  (`appendUnionById` compares against the EFFECTIVE last row). */
function effectiveRowsByRecency(
	absPath: string,
	keys: readonly string[],
): MemberRows {
	const out: MemberRows = { by: new Map(), truncated: false };
	let content: string;
	try {
		// Feedback PRR-022: bound the whole-file read (the report's own
		// plan-durability doc claims bounded reads; a huge member file must
		// not balloon memory). The first MAX_MEMBER_FILE_BYTES carry far more
		// than the 20k-row parse cap, so semantics are unchanged for legal
		// stores; oversized ones now report truncated.
		const stat = fs.statSync(absPath);
		const len = Math.min(stat.size, MAX_MEMBER_FILE_BYTES);
		const fd = fs.openSync(absPath, 'r');
		try {
			const buf = Buffer.alloc(len);
			const read = fs.readSync(fd, buf, 0, len, 0);
			content = buf.toString('utf-8', 0, read);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return out; // absent member file = no rows on that side
	}
	const lines = content.split('\n');
	if (lines.length > MAX_MEMBER_LINES) out.truncated = true;
	const limit = Math.min(lines.length, MAX_MEMBER_LINES);
	for (let i = 0; i < limit; i += 1) {
		const trimmed = lines[i]!.trim();
		if (trimmed.length === 0) continue;
		let row: unknown;
		try {
			row = JSON.parse(trimmed);
		} catch {
			continue; // malformed lines are not this category's signal
		}
		const id = rowId(row);
		if (id === null) continue;
		out.by.set(id, rowRecency(row, keys));
	}
	return out;
}

/** Only when a memory-link pointer exists. Row identity (the `id` field),
 *  versioned membership, and the recency comparison ALL come from the
 *  migration engine's exported helpers so the report cannot drift from the
 *  engine's merge semantics. Anything unexpected about the link structure
 *  reports 0 with a 'not linked' note. */
function checkMemoryDivergences(
	directory: string,
	swarmRoot: string,
): CategoryReport {
	const report: CategoryReport = { count: 0, listed: [] };
	const pointerPath = path.join(swarmRoot, MEMORY_LINK_POINTER_FILENAME);
	if (!fs.existsSync(pointerPath)) {
		report.note = 'not linked';
		return report;
	}
	const pointer = readMemoryLinkPointer(directory);
	if (!pointer) {
		report.note = 'not linked';
		return report;
	}
	const cohortDir = path.join(resolveLinkDir(pointer.linkId), 'memory');
	const localDir = path.join(swarmRoot, 'memory');
	const members = MEMORY_FAMILY.filter(
		(member) =>
			member.mergeStrategy === 'append-union' &&
			MEMBER_RECENCY_KEYS[member.filename] !== undefined,
	);
	for (const member of members) {
		const keys = MEMBER_RECENCY_KEYS[member.filename] ?? [];
		const local = effectiveRowsByRecency(
			path.join(localDir, member.filename),
			keys,
		);
		const cohort = effectiveRowsByRecency(
			path.join(cohortDir, member.filename),
			keys,
		);
		const truncated = [local, cohort].filter((m) => m.truncated);
		if (truncated.length > 0) {
			report.note = `${member.filename} truncated at ${MAX_MEMBER_LINES} lines`;
		}
		for (const [id, localRecency] of local.by) {
			if (!cohort.by.has(id)) continue;
			// undefined vs number IS a divergence (one side carries a version
			// signal the other lacks); undefined === undefined is not.
			if (cohort.by.get(id) === localRecency) continue;
			report.count += 1;
			report.listed.push(
				`\`${safeName(member.filename)}\` id \`${safeName(id)}\` (version/updated fields differ between cohort and local stores)`,
			);
		}
	}
	return report;
}
