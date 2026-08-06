/**
 * Tests for activation + rollback (Workstream D).
 * Covers: stale-base refusal, atomic activation, rollback non-mutation,
 * approval hash race, human-only safety (the registry toolPolicy is verified
 * in the command test; here we verify the runtime invariants).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	activateCandidate,
	rollbackCandidate,
} from '../../../../src/services/skill-optimizer/activation.js';
import { recordTransition } from '../../../../src/services/skill-optimizer/lifecycle.js';
import {
	computeContentHash,
	mintCandidateId,
	writeArtifact,
} from '../../../../src/services/skill-optimizer/store.js';

let tmp = '';

beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), 'skill-opt-act-'));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeIncumbent(slug: string, content: string): string {
	const dir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
	mkdirSync(dir, { recursive: true });
	const skillPath = path.join(dir, 'SKILL.md');
	writeFileSync(skillPath, content, 'utf8');
	return skillPath;
}

describe('skill-opt activation — stale base refusal', () => {
	it('refuses activation when the expected hash does not match current', async () => {
		const slug = 'stale-skill';
		writeIncumbent(
			slug,
			'---\nname: stale\ndescription: x\n---\n# Stale\nbody',
		);
		const id = mintCandidateId();
		const result = await activateCandidate({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			actor: 'test',
			expectedContentHash: '0'.repeat(64), // wrong hash
		});
		expect(result.activated).toBe(false);
		expect(result.reason).toContain('STALE_BASE');
	});
});

describe('skill-opt activation — atomic activation + snapshot', () => {
	it('activates a candidate, writes the new content, and records a snapshot', async () => {
		const slug = 'ok-skill';
		const incumbent = '---\nname: ok\ndescription: x\n---\n# Ok\nold';
		writeIncumbent(slug, incumbent);
		const id = mintCandidateId();
		const candidateContent =
			'---\nname: ok\ndescription: x\n---\n# Ok\nnew improved';
		writeArtifact(tmp, slug, id, 'candidate.md', candidateContent);

		// Bring the candidate to accepted_pending_approval first (activation
		// requires the lifecycle to allow the transition).
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'drafted',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'smoke_validated',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'validation_running',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'accepted_pending_approval',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});

		const result = await activateCandidate({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			actor: 'test',
			expectedContentHash: computeContentHash(incumbent),
		});
		expect(result.activated).toBe(true);
		// Live skill now has the candidate content.
		const live = readFileSync(
			path.join(tmp, '.opencode', 'skills', 'generated', slug, 'SKILL.md'),
			'utf8',
		);
		expect(live).toBe(candidateContent);
		// Snapshot recorded.
		expect(existsSync(result.rollbackSnapshotRef)).toBe(true);
		expect(readFileSync(result.rollbackSnapshotRef, 'utf8')).toBe(incumbent);
	});
});

describe('skill-opt activation — rollback non-mutation', () => {
	it('restores the snapshot and appends a rolled_back event (history preserved)', async () => {
		const slug = 'rb-skill';
		const incumbent = '---\nname: rb\ndescription: x\n---\n# Rb\nold';
		writeIncumbent(slug, incumbent);
		const id = mintCandidateId();
		const candidateContent = '---\nname: rb\ndescription: x\n---\n# Rb\nnew';
		writeArtifact(tmp, slug, id, 'candidate.md', candidateContent);
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'drafted',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'smoke_validated',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'validation_running',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'accepted_pending_approval',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		const activated = await activateCandidate({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			actor: 't',
			expectedContentHash: computeContentHash(incumbent),
		});
		expect(activated.activated).toBe(true);

		const rb = await rollbackCandidate({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			actor: 't',
		});
		expect(rb.rolledBack).toBe(true);
		// Live skill restored to incumbent.
		const live = readFileSync(
			path.join(tmp, '.opencode', 'skills', 'generated', slug, 'SKILL.md'),
			'utf8',
		);
		expect(live).toBe(incumbent);
		// History still contains the activated event (never deleted).
		const ledger = readFileSync(
			path.join(
				tmp,
				'.swarm',
				'evolution',
				'skills',
				slug,
				id,
				'lifecycle.jsonl',
			),
			'utf8',
		);
		expect(ledger).toContain('"toState":"activated"');
		expect(ledger).toContain('"toState":"rolled_back"');
	});
});

describe('skill-opt activation — order-of-operations safety (reviewer CR1)', () => {
	it('refuses activation from a non-accepted state WITHOUT mutating the SKILL.md', async () => {
		const slug = 'order-skill';
		const incumbent = '---\nname: order\ndescription: x\n---\n# Order\nbody';
		writeIncumbent(slug, incumbent);
		const id = mintCandidateId();
		writeArtifact(
			tmp,
			slug,
			id,
			'candidate.md',
			'---\nname: order\ndescription: x\n---\n# Order\nnew',
		);
		// Candidate is in 'discovered' (NOT accepted_pending_approval).
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});

		const result = await activateCandidate({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			actor: 'test',
			expectedContentHash: computeContentHash(incumbent),
		});
		expect(result.activated).toBe(false);
		expect(result.reason).toContain('INVALID_STATE');
		// CRITICAL: the SKILL.md is UNCHANGED (no mutation before the throw).
		const live = readFileSync(
			path.join(tmp, '.opencode', 'skills', 'generated', slug, 'SKILL.md'),
			'utf8',
		);
		expect(live).toBe(incumbent);
	});

	it('refuses rollback from a non-activated state WITHOUT mutating the SKILL.md', async () => {
		const slug = 'rb-order-skill';
		const incumbent = '---\nname: rb\ndescription: x\n---\n# Rb\nbody';
		writeIncumbent(slug, incumbent);
		const id = mintCandidateId();
		writeArtifact(tmp, slug, id, 'rollback.md', 'snapshot');
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});

		const result = await rollbackCandidate({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			actor: 't',
		});
		expect(result.rolledBack).toBe(false);
		expect(result.reason).toContain('INVALID_STATE');
		const live = readFileSync(
			path.join(tmp, '.opencode', 'skills', 'generated', slug, 'SKILL.md'),
			'utf8',
		);
		expect(live).toBe(incumbent);
	});
});

describe('skill-opt activation — approval hash race', () => {
	it('a concurrent content change between read and activate is caught by the hash check', async () => {
		const slug = 'race-skill';
		const incumbent = '---\nname: race\ndescription: x\n---\n# Race\nv1';
		const skillPath = writeIncumbent(slug, incumbent);
		const id = mintCandidateId();
		writeArtifact(
			tmp,
			slug,
			id,
			'candidate.md',
			'---\nname: race\ndescription: x\n---\n# Race\nv2',
		);
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'drafted',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'smoke_validated',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'validation_running',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'accepted_pending_approval',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});

		// Caller reads the hash, then someone else mutates the file.
		const expectedHash = computeContentHash(incumbent);
		writeFileSync(
			skillPath,
			'---\nname: race\ndescription: x\n---\n# Race\nsneaky',
			'utf8',
		);

		const result = await activateCandidate({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			actor: 't',
			expectedContentHash: expectedHash,
		});
		expect(result.activated).toBe(false);
		expect(result.reason).toContain('STALE_BASE');
	});
});
