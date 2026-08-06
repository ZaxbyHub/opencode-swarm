/**
 * Append-only lifecycle store for the governed skill optimizer (issue #1822).
 *
 * Storage layout (all under `.swarm/`, AGENTS.md invariant #4):
 *   .swarm/evolution/skills/<skillSlug>/<candidateId>/lifecycle.jsonl   (authoritative)
 *   .swarm/evolution/skills/<skillSlug>/<candidateId>/state.json        (derived projection)
 *   .swarm/evolution/skills/<skillSlug>/<candidateId>/baseline.md       (frozen baseline snapshot)
 *   .swarm/evolution/skills/<skillSlug>/<candidateId>/candidate.md      (drafted candidate)
 *   .swarm/evolution/skills/<skillSlug>/<candidateId>/diff.patch        (computed diff)
 *   .swarm/evolution/skills/<skillSlug>/<candidateId>/rollback.md       (pre-activation snapshot)
 *   .swarm/evolution/skills/lifecycle-quarantine.<ts>.<hash>            (corrupt-tail salvage)
 *
 * Integrity model mirrors `src/plan/ledger.ts`:
 *   - fsync+rename atomic append, gated by an evidence lock;
 *   - replay stops at the first unparseable line, sets `truncated`, captures
 *     the bad suffix, and quarantines it WITHOUT rewriting the canonical ledger;
 *   - hash-before/hash-after chain (reuses the plan-ledger field semantics —
 *     no parallel "previousStateHash");
 *   - partial/corrupt writes never count as acceptance (replay-after-write
 *     verification in `recordTransition`, lifecycle.ts).
 *
 * IDs are collision-resistant and filesystem-safe (`crypto.randomUUID()`).
 */

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync as writeFileSyncAsync,
} from 'node:fs';
import * as path from 'node:path';
import { withEvidenceLock } from '../../evidence/lock.js';

const STORE_SCHEMA_VERSION = '1';

/** Lifecycle states (issue #1822 durable lifecycle). */
export type SkillOptState =
	| 'discovered'
	| 'drafted'
	| 'smoke_validated'
	| 'validation_running'
	| 'accepted_pending_approval'
	| 'rejected'
	| 'inconclusive'
	| 'activated'
	| 'expired'
	| 'rolled_back';

/** A single append-only lifecycle event. Hash chain reuses plan-ledger semantics. */
export interface SkillOptEvent {
	seq: number;
	timestamp: string;
	candidateId: string;
	skillSlug: string;
	eventType: string;
	fromState: SkillOptState | null;
	toState: SkillOptState;
	actor: string;
	origin: string;
	contentHashBefore: string | null;
	contentHashAfter: string | null;
	hashBefore: string;
	hashAfter: string;
	reason: string;
	evidenceRefs: string[];
	payload?: Record<string, unknown>;
}

export interface ReplayResult {
	events: SkillOptEvent[];
	state: SkillOptState | null;
	truncated: boolean;
	badSuffix: string | null;
	/** Sequence number of the last complete (hash-verified) event. */
	lastCompleteSeq: number;
}

/**
 * Canonical JSON stringify with sorted object keys — required for stable
 * content/state hashing across V8 key-insertion-order differences.
 */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** SHA-256 over canonical JSON of an arbitrary value. */
export function computeStateHash(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** SHA-256 of raw text content (a SKILL.md body). */
export function computeContentHash(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compute the chain hash for an event. Protects the full audit narrative:
 * seq, ids, transition, actor/origin/reason, content hashes, and the prior
 * hash. `evidenceRefs` and `payload` are included so tampering with evidence
 * references or payload metadata is detectable on replay (reviewer IM4).
 * `hashAfter` itself is excluded (it is the output). `timestamp` is included
 * so a replayed event at the same seq with a different time is detected.
 */
function computeEventHash(event: {
	seq: number;
	candidateId: string;
	skillSlug: string;
	eventType: string;
	fromState: SkillOptState | null;
	toState: SkillOptState;
	actor: string;
	origin: string;
	reason: string;
	contentHashBefore: string | null;
	contentHashAfter: string | null;
	hashBefore: string;
	evidenceRefs: string[];
	payload?: Record<string, unknown>;
	timestamp: string;
}): string {
	return computeStateHash({
		seq: event.seq,
		candidateId: event.candidateId,
		skillSlug: event.skillSlug,
		eventType: event.eventType,
		fromState: event.fromState,
		toState: event.toState,
		actor: event.actor,
		origin: event.origin,
		reason: event.reason,
		contentHashBefore: event.contentHashBefore,
		contentHashAfter: event.contentHashAfter,
		hashBefore: event.hashBefore,
		evidenceRefs: event.evidenceRefs,
		...(event.payload ? { payload: event.payload } : {}),
		timestamp: event.timestamp,
	});
}

/** Filesystem-safe skill slug check (mirrors skill-evaluator's SLUG_PATTERN). */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isValidSkillSlug(slug: string): boolean {
	return SLUG_PATTERN.test(slug);
}

/** Validate a candidate ID is filesystem-safe (uuid or equivalent). */
export function isValidCandidateId(id: string): boolean {
	return /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

/** Mint a fresh collision-resistant candidate ID. */
export function mintCandidateId(): string {
	return randomUUID();
}

function candidateDir(directory: string, skillSlug: string, candidateId: string): string {
	return path.join(directory, '.swarm', 'evolution', 'skills', skillSlug, candidateId);
}

function ledgerPath(directory: string, skillSlug: string, candidateId: string): string {
	return path.join(candidateDir(directory, skillSlug, candidateId), 'lifecycle.jsonl');
}

function stateProjectionPath(
	directory: string,
	skillSlug: string,
	candidateId: string,
): string {
	return path.join(candidateDir(directory, skillSlug, candidateId), 'state.json');
}

function ensureCandidateDir(directory: string, skillSlug: string, candidateId: string): string {
	const dir = candidateDir(directory, skillSlug, candidateId);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Fsync-then-rename atomic write (mirrors `writeFileFsyncedThenRename` in
 * `src/plan/ledger.ts:169`). fsync guarantees the bytes hit durable storage
 * before the rename makes the file visible.
 */
function writeFileFsyncedThenRename(tempPath: string, targetPath: string, data: string): void {
	const fd = openSync(tempPath, 'w');
	try {
		writeFileSync(fd, data, 'utf8');
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tempPath, targetPath);
}

/** DI seam for test injection (AGENTS.md invariant #7 — preferred over mock.module). */
export const _internals = {
	withEvidenceLock,
	writeFileFsyncedThenRename,
	writeFileSync: writeFileSyncAsync,
	readFileSync,
	renameSync,
	unlinkSync,
	existsSync,
	statSync,
};

/**
 * Append a lifecycle event atomically. Computes the hash chain from the
 * current replayed state, fsync+rename under an evidence lock, then verifies
 * the append by re-reading. Returns the persisted event.
 *
 * Throws if the post-write replay does not contain the appended event at the
 * expected seq — a partial/corrupt write never counts as a successful
 * transition.
 */
export async function appendEvent(
	directory: string,
	eventInput: Omit<
		SkillOptEvent,
		'seq' | 'timestamp' | 'hashBefore' | 'hashAfter'
	> & { timestamp?: string },
): Promise<SkillOptEvent> {
	if (!isValidSkillSlug(eventInput.skillSlug)) {
		throw new Error(`invalid skill slug: ${eventInput.skillSlug}`);
	}
	if (!isValidCandidateId(eventInput.candidateId)) {
		throw new Error(`invalid candidate id: ${eventInput.candidateId}`);
	}
	const filePath = ledgerPath(directory, eventInput.skillSlug, eventInput.candidateId);
	ensureCandidateDir(directory, eventInput.skillSlug, eventInput.candidateId);

	return _internals.withEvidenceLock(
		directory,
		path.join('.swarm', 'evolution', 'skills', eventInput.skillSlug, eventInput.candidateId, 'lifecycle.jsonl'),
		'skill-opt-ledger',
		'append-skill-opt-event',
		async () => {
			const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
			const events = parseEventsFromText(existing);
			const nextSeq = events.length === 0 ? 1 : events[events.length - 1].seq + 1;
			const lastEvent = events.length === 0 ? null : events[events.length - 1];
			const hashBefore = lastEvent ? lastEvent.hashAfter : computeStateHash(null);

			const event: SkillOptEvent = {
				seq: nextSeq,
				timestamp: eventInput.timestamp ?? new Date().toISOString(),
				candidateId: eventInput.candidateId,
				skillSlug: eventInput.skillSlug,
				eventType: eventInput.eventType,
				fromState: eventInput.fromState,
				toState: eventInput.toState,
				actor: eventInput.actor,
				origin: eventInput.origin,
				contentHashBefore: eventInput.contentHashBefore,
				contentHashAfter: eventInput.contentHashAfter,
				hashBefore,
				hashAfter: '',
				reason: eventInput.reason,
				evidenceRefs: eventInput.evidenceRefs,
				...(eventInput.payload ? { payload: eventInput.payload } : {}),
			};
			event.hashAfter = computeEventHash(event);

			const tempPath = `${filePath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
			const line = `${JSON.stringify(event)}\n`;
			_internals.writeFileFsyncedThenRename(tempPath, filePath, existing + line);

			// Replay-after-write verification — partial/corrupt writes never count.
			const verify = parseEventsFromText(_internals.readFileSync(filePath, 'utf8'));
			const last = verify.length > 0 ? verify[verify.length - 1] : null;
			if (!last || last.seq !== event.seq || last.hashAfter !== event.hashAfter) {
				throw new Error(
					`skill-opt ledger append verification failed for candidate ${event.candidateId} seq ${event.seq}`,
				);
			}
			return event;
		},
	);
}

/** Parse events from raw ledger text. Stops at the first unparseable line. */
function parseEventsFromText(text: string): SkillOptEvent[] {
	if (text.length === 0) return [];
	const lines = text.split('\n');
	const events: SkillOptEvent[] = [];
	for (const line of lines) {
		if (line.length === 0) continue;
		try {
			events.push(JSON.parse(line) as SkillOptEvent);
		} catch {
			break;
		}
	}
	return events;
}

/**
 * Replay a candidate's lifecycle ledger. Mirrors `readLedgerEventsWithIntegrity`
 * in `src/plan/ledger.ts:1105`: stops at the first unparseable line, marks the
 * replay `truncated`, and surfaces the bad suffix for quarantine. The canonical
 * ledger is NEVER rewritten or truncated by this read.
 */
export function replayCandidate(
	directory: string,
	skillSlug: string,
	candidateId: string,
): ReplayResult {
	const filePath = ledgerPath(directory, skillSlug, candidateId);
	if (!existsSync(filePath)) {
		return {
			events: [],
			state: null,
			truncated: false,
			badSuffix: null,
			lastCompleteSeq: 0,
		};
	}
	const text = readFileSync(filePath, 'utf8');
	if (text.length === 0) {
		return {
			events: [],
			state: null,
			truncated: false,
			badSuffix: null,
			lastCompleteSeq: 0,
		};
	}
	const lines = text.split('\n');
	const events: SkillOptEvent[] = [];
	let truncated = false;
	let badSuffix: string | null = null;
	let lastCompleteSeq = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.length === 0) continue;
		let parsed: SkillOptEvent;
		try {
			parsed = JSON.parse(line) as SkillOptEvent;
		} catch {
			truncated = true;
			badSuffix = lines.slice(i).join('\n');
			break;
		}
		// Verify the hash chain. A line whose hashAfter does not recompute stops
		// the replay — the suffix is quarantined. This is the tamper-evidence
		// mechanism (protects the full audit narrative — reviewer IM4).
		const recomputed = computeEventHash(parsed);
		if (recomputed !== parsed.hashAfter) {
			truncated = true;
			badSuffix = lines.slice(i).join('\n');
			break;
		}
		events.push(parsed);
		lastCompleteSeq = parsed.seq;
	}

	const state = events.length === 0 ? null : events[events.length - 1].toState;
	return { events, state, truncated, badSuffix, lastCompleteSeq };
}

/**
 * Quarantine a corrupt ledger suffix. Writes the bad suffix to a unique side
 * file under `.swarm/evolution/skills/`. NEVER rewrites or truncates the
 * canonical `lifecycle.jsonl`. Mirrors `quarantineLedgerSuffix` in
 * `src/plan/ledger.ts:1188`.
 */
export function quarantineSuffix(
	directory: string,
	skillSlug: string,
	badSuffix: string,
): string {
	const dir = path.join(directory, '.swarm', 'evolution', 'skills');
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const hash = computeStateHash(badSuffix).slice(0, 12);
	const stamp = Date.now();
	const quarantinePath = path.join(
		dir,
		`lifecycle-quarantine.${skillSlug}.${stamp}.${hash}`,
	);
	writeFileSyncAsync(quarantinePath, badSuffix, 'utf8');
	return quarantinePath;
}

/**
 * Derive the projection `state.json` from the ledger replay. Derived, not
 * authoritative — callers must always re-derive from the ledger rather than
 * trust a stale projection. Writes atomically (temp+rename).
 */
export function writeStateProjection(
	directory: string,
	skillSlug: string,
	candidateId: string,
	replay: ReplayResult,
): void {
	const target = stateProjectionPath(directory, skillSlug, candidateId);
	ensureCandidateDir(directory, skillSlug, candidateId);
	const projection = {
		v: 1,
		candidateId,
		skillSlug,
		state: replay.state,
		lastCompleteSeq: replay.lastCompleteSeq,
		truncated: replay.truncated,
		eventCount: replay.events.length,
		updatedAt: new Date().toISOString(),
	};
	const tempPath = `${target}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	_internals.writeFileFsyncedThenRename(tempPath, target, `${JSON.stringify(projection, null, 2)}\n`);
}

/** Snapshot a text file (baseline/candidate/rollback) atomically. */
export function writeArtifact(
	directory: string,
	skillSlug: string,
	candidateId: string,
	fileName: string,
	content: string,
): string {
	const dir = ensureCandidateDir(directory, skillSlug, candidateId);
	const target = path.join(dir, fileName);
	const tempPath = `${target}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	_internals.writeFileFsyncedThenRename(tempPath, target, content);
	return target;
}

/** Read a snapshot artifact, returning null if absent. */
export function readArtifact(
	directory: string,
	skillSlug: string,
	candidateId: string,
	fileName: string,
): string | null {
	const target = path.join(candidateDir(directory, skillSlug, candidateId), fileName);
	if (!existsSync(target)) return null;
	return readFileSync(target, 'utf8');
}

export const SKILL_OPT_STORE_SCHEMA_VERSION = STORE_SCHEMA_VERSION;
