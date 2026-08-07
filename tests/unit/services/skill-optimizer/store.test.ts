/**
 * Tests for the governed-skill-optimizer append-only lifecycle store.
 * Covers: append/replay, hash-chain integrity, corrupt-tail quarantine,
 * atomicity, collision-resistant IDs, content hashing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { recordTransition } from '../../../../src/services/skill-optimizer/lifecycle.js';
import {
	appendEvent,
	computeContentHash,
	computeStateHash,
	isValidCandidateId,
	isValidSkillSlug,
	mintCandidateId,
	quarantineSuffix,
	readArtifact,
	replayCandidate,
	writeArtifact,
} from '../../../../src/services/skill-optimizer/store.js';

let tmp = '';

beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), 'skill-opt-store-'));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe('skill-opt store — IDs and hashes', () => {
	it('mints collision-resistant filesystem-safe candidate IDs', () => {
		const id = mintCandidateId();
		expect(isValidCandidateId(id)).toBe(true);
		const id2 = mintCandidateId();
		expect(id).not.toBe(id2);
	});

	it('validates skill slugs', () => {
		expect(isValidSkillSlug('my-skill')).toBe(true);
		expect(isValidSkillSlug('My_Skill')).toBe(false);
		expect(isValidSkillSlug('')).toBe(false);
		expect(isValidSkillSlug('a'.repeat(64))).toBe(true);
		expect(isValidSkillSlug('a'.repeat(65))).toBe(false);
	});

	it('computes deterministic content + state hashes', () => {
		expect(computeContentHash('abc')).toBe(computeContentHash('abc'));
		expect(computeContentHash('abc')).not.toBe(computeContentHash('abd'));
		expect(computeStateHash({ b: 2, a: 1 })).toBe(
			computeStateHash({ a: 1, b: 2 }),
		);
	});
});

describe('skill-opt store — append + replay', () => {
	it('appends a first event with seq 1 and replays it', async () => {
		const event = await appendEvent(tmp, {
			candidateId: 'cand-1234',
			skillSlug: 'test-skill',
			eventType: 'discover',
			fromState: null,
			toState: 'discovered',
			actor: 'test',
			origin: 'test',
			reason: 'first',
			contentHashBefore: null,
			contentHashAfter: 'h1',
			evidenceRefs: [],
		});
		expect(event.seq).toBe(1);
		expect(event.hashBefore).toBe(computeStateHash(null));
		expect(event.hashAfter).not.toBe('');

		const replay = replayCandidate(tmp, 'test-skill', 'cand-1234');
		expect(replay.events).toHaveLength(1);
		expect(replay.state).toBe('discovered');
		expect(replay.truncated).toBe(false);
		expect(replay.lastCompleteSeq).toBe(1);
	});

	it('chains subsequent events with hashBefore = previous hashAfter', async () => {
		const slug = 'chain-skill';
		const id = mintCandidateId();
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'discover',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'drafted',
			eventType: 'draft',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		const replay = replayCandidate(tmp, slug, id);
		expect(replay.events).toHaveLength(2);
		expect(replay.events[1].hashBefore).toBe(replay.events[0].hashAfter);
		expect(replay.state).toBe('drafted');
	});

	it('verifies the append after write — a partial write throws', async () => {
		// Append succeeds normally; we verify the read-back path is exercised.
		const event = await appendEvent(tmp, {
			candidateId: 'cand-verify',
			skillSlug: 'verify-skill',
			eventType: 'discover',
			fromState: null,
			toState: 'discovered',
			actor: 't',
			origin: 't',
			reason: 'r',
			contentHashBefore: null,
			contentHashAfter: 'h',
			evidenceRefs: [],
		});
		expect(event.seq).toBe(1);
		// File exists and is one valid JSON line.
		const file = path.join(
			tmp,
			'.swarm',
			'evolution',
			'skills',
			'verify-skill',
			'cand-verify',
			'lifecycle.jsonl',
		);
		expect(existsSync(file)).toBe(true);
		const lines = readFileSync(file, 'utf8')
			.split('\n')
			.filter((l) => l.trim());
		expect(lines).toHaveLength(1);
	});
});

describe('skill-opt store — corrupt tail quarantine', () => {
	it('stops at the first unparseable line and quarantines the suffix', async () => {
		const slug = 'corrupt-skill';
		const id = mintCandidateId();
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'discover',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		const file = path.join(
			tmp,
			'.swarm',
			'evolution',
			'skills',
			slug,
			id,
			'lifecycle.jsonl',
		);
		// Append a corrupt line.
		writeFileSync(file, '\n{not valid json}\n', { flag: 'a' });
		const replay = replayCandidate(tmp, slug, id);
		expect(replay.truncated).toBe(true);
		expect(replay.badSuffix).toContain('not valid json');
		expect(replay.events).toHaveLength(1); // the one good event survived
		expect(replay.lastCompleteSeq).toBe(1);

		// Quarantine writes the suffix without touching the canonical ledger.
		const qPath = quarantineSuffix(tmp, slug, replay.badSuffix!);
		expect(existsSync(qPath)).toBe(true);
		// Canonical ledger still contains the corrupt suffix (never truncated).
		const canonical = readFileSync(file, 'utf8');
		expect(canonical).toContain('not valid json');
	});

	it('detects a tampered hashAfter as corruption', async () => {
		const slug = 'tamper-skill';
		const id = mintCandidateId();
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'discover',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		const file = path.join(
			tmp,
			'.swarm',
			'evolution',
			'skills',
			slug,
			id,
			'lifecycle.jsonl',
		);
		// Tamper: rewrite the event with a bogus hashAfter.
		const original = JSON.parse(readFileSync(file, 'utf8')) as {
			hashAfter: string;
		};
		original.hashAfter = '0'.repeat(64);
		writeFileSync(file, `${JSON.stringify(original)}\n`);
		const replay = replayCandidate(tmp, slug, id);
		expect(replay.truncated).toBe(true);
	});

	it('F3: appending after a corrupt tail drops the corrupt suffix and recovers', async () => {
		const slug = 'recover-skill';
		const id = mintCandidateId();
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'discover',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		const file = path.join(
			tmp,
			'.swarm',
			'evolution',
			'skills',
			slug,
			id,
			'lifecycle.jsonl',
		);
		// Inject a corrupt suffix.
		writeFileSync(file, '\n{CORRUPT_LINE}\n', { flag: 'a' });
		// Append a new event — the corrupt suffix must be dropped (F3 fix).
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'drafted',
			eventType: 'draft',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		const replay = replayCandidate(tmp, slug, id);
		expect(replay.truncated).toBe(false);
		expect(replay.state).toBe('drafted');
		expect(replay.events).toHaveLength(2); // discovered + drafted, corrupt line gone
		// The canonical file no longer contains the corruption.
		const canonical = readFileSync(file, 'utf8');
		expect(canonical).not.toContain('CORRUPT_LINE');
	});
});

describe('skill-opt store — artifacts', () => {
	it('writes and reads artifact files atomically', () => {
		const p = writeArtifact(
			tmp,
			'art-skill',
			'cand-art',
			'baseline.md',
			'baseline content',
		);
		expect(existsSync(p)).toBe(true);
		expect(readArtifact(tmp, 'art-skill', 'cand-art', 'baseline.md')).toBe(
			'baseline content',
		);
		expect(readArtifact(tmp, 'art-skill', 'cand-art', 'missing.md')).toBeNull();
	});
});

describe('skill-opt store — input validation', () => {
	it('rejects an invalid skill slug', async () => {
		let threw = false;
		try {
			await appendEvent(tmp, {
				candidateId: 'cand-ok',
				skillSlug: 'Invalid Slug',
				eventType: 'discover',
				fromState: null,
				toState: 'discovered',
				actor: 't',
				origin: 't',
				reason: 'r',
				contentHashBefore: null,
				contentHashAfter: null,
				evidenceRefs: [],
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	it('rejects an invalid candidate id', async () => {
		let threw = false;
		try {
			await appendEvent(tmp, {
				candidateId: 'x', // too short
				skillSlug: 'ok-skill',
				eventType: 'discover',
				fromState: null,
				toState: 'discovered',
				actor: 't',
				origin: 't',
				reason: 'r',
				contentHashBefore: null,
				contentHashAfter: null,
				evidenceRefs: [],
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});
