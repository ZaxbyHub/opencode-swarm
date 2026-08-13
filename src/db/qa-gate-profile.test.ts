/**
 * Tests for src/db/qa-gate-profile.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { derivePlanId } from '../plan/utils.js';
import { closeAllProjectDbs, getProjectDb } from './project-db.js';
import {
	_internals,
	computeProfileHash,
	DEFAULT_QA_GATES,
	getEffectiveGates,
	getOrCreateProfile,
	getOrCreateProfileForIdentity,
	getProfile,
	getProfileForIdentity,
	getProfileLookupForIdentity,
	lockProfile,
	lockProfileForIdentity,
	QaGateProfileIdentityUnboundError,
	setGates,
	setGatesForIdentity,
} from './qa-gate-profile.js';

let tempDir: string;
const originalAfterSetGatesRead = _internals.afterSetGatesRead;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(process.cwd(), 'qa-gate-profile-test-')),
	);
});

afterEach(() => {
	delete _internals.afterSetGatesForIdentityRead;
	_internals.afterSetGatesRead = originalAfterSetGatesRead;
	closeAllProjectDbs();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('qa-gate-profile', () => {
	const originalGetProfile = _internals.getProfile;

	afterEach(() => {
		_internals.getProfile = originalGetProfile;
		_internals.afterSetGatesRead = originalAfterSetGatesRead;
		delete _internals.afterSetGatesForIdentityRead;
	});

	test('getProfile returns null for unknown plan_id', () => {
		expect(getProfile(tempDir, 'missing')).toBeNull();
	});

	test('getProfile does NOT create .swarm/swarm.db on read from fresh dir', () => {
		const dbPath = path.join(tempDir, '.swarm', 'swarm.db');
		expect(fs.existsSync(path.join(tempDir, '.swarm'))).toBe(false);
		expect(fs.existsSync(dbPath)).toBe(false);

		const result = getProfile(tempDir, 'plan-that-does-not-exist');
		expect(result).toBeNull();
		expect(fs.existsSync(dbPath)).toBe(false);
	});

	test('getOrCreateProfile seeds defaults', () => {
		const p = getOrCreateProfile(tempDir, 'plan-1', 'ts');
		expect(p.plan_id).toBe('plan-1');
		expect(p.project_type).toBe('ts');
		expect(p.gates).toEqual(DEFAULT_QA_GATES);
		expect(p.locked_at).toBeNull();
	});

	test('getOrCreateProfile atomically overlays an initial gate selection', () => {
		const p = getOrCreateProfile(tempDir, 'plan-initial', 'ts', {
			reviewer: false,
			mutation_test: true,
		});
		expect(p.gates.reviewer).toBe(false);
		expect(p.gates.mutation_test).toBe(true);
		expect(p.gates.test_engineer).toBe(DEFAULT_QA_GATES.test_engineer);
	});

	test('exact identity profiles use collision-safe storage rows and preserve readable ids outwardly', () => {
		const identity = { swarm: 'mega one', title: 'Plan / 1' };
		const expectedReadablePlanId = derivePlanId(identity);
		const p = getOrCreateProfileForIdentity(tempDir, identity, 'ts', {
			reviewer: false,
		});

		expect(p.plan_id).toBe(expectedReadablePlanId);
		expect(p.raw_swarm).toBe(identity.swarm);
		expect(p.raw_title).toBe(identity.title);
		expect(p.identity_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(getProfile(tempDir, expectedReadablePlanId)).toBeNull();

		const db = getProjectDb(tempDir);
		const row = db
			.query<{ plan_id: string }, [number]>(
				'SELECT plan_id FROM qa_gate_profile WHERE id = ?',
			)
			.get(p.id);
		expect(row?.plan_id).toBe(`qa2-${p.identity_hash}`);
	});

	test('colliding raw identities create distinct exact profiles instead of colliding on readable plan_id', () => {
		const first = getOrCreateProfileForIdentity(tempDir, {
			swarm: 'mega one',
			title: 'Plan / 1',
		});
		const second = getOrCreateProfileForIdentity(tempDir, {
			swarm: 'mega?one',
			title: 'Plan ? 1',
		});

		expect(first.id).not.toBe(second.id);
		expect(first.plan_id).toBe(second.plan_id);
		expect(first.identity_hash).not.toBe(second.identity_hash);
		expect(
			getProfileForIdentity(tempDir, {
				swarm: 'mega one',
				title: 'Plan / 1',
			})?.id,
		).toBe(first.id);
		expect(
			getProfileForIdentity(tempDir, {
				swarm: 'mega?one',
				title: 'Plan ? 1',
			})?.id,
		).toBe(second.id);
	});

	test('getOrCreateProfileForIdentity creates an exact profile beside an unbound legacy collision', () => {
		const legacyIdentity = { swarm: 'mega one', title: 'Plan / 1' };
		const exactIdentity = { swarm: 'mega?one', title: 'Plan ? 1' };
		const readablePlanId = derivePlanId(legacyIdentity);
		expect(derivePlanId(exactIdentity)).toBe(readablePlanId);

		const legacy = getOrCreateProfile(tempDir, readablePlanId, 'legacy', {
			reviewer: false,
		});
		const exact = getOrCreateProfileForIdentity(tempDir, exactIdentity, 'ts', {
			mutation_test: true,
		});

		expect(exact.id).not.toBe(legacy.id);
		expect(exact.plan_id).toBe(readablePlanId);
		expect(exact.project_type).toBe('ts');
		expect(exact.gates.mutation_test).toBe(true);
		expect(getProfile(tempDir, readablePlanId)?.id).toBe(legacy.id);
		expect(getProfileForIdentity(tempDir, exactIdentity)?.id).toBe(exact.id);
		expect(getProfileLookupForIdentity(tempDir, legacyIdentity).kind).toBe(
			'unbound_legacy',
		);
		expect(() => getProfileForIdentity(tempDir, legacyIdentity)).toThrow(
			QaGateProfileIdentityUnboundError,
		);
		expect(
			getOrCreateProfileForIdentity(tempDir, exactIdentity, 'ignored').id,
		).toBe(exact.id);

		const storage = getProjectDb(tempDir)
			.query<{ plan_id: string }, [number]>(
				'SELECT plan_id FROM qa_gate_profile WHERE id = ?',
			)
			.get(exact.id);
		expect(storage?.plan_id).toBe(`qa2-${exact.identity_hash}`);
	});

	test('exact lookup distinguishes missing, bound, and unbound legacy rows', () => {
		const identity = { swarm: 'legacy swarm', title: 'Legacy Plan' };
		const planId = derivePlanId(identity);
		getOrCreateProfile(tempDir, planId, 'ts');

		const unbound = getProfileLookupForIdentity(tempDir, identity);
		expect(unbound.kind).toBe('unbound_legacy');
		if (unbound.kind === 'unbound_legacy') {
			expect(unbound.profile.plan_id).toBe(planId);
		}
		expect(() => getProfileForIdentity(tempDir, identity)).toThrow(
			QaGateProfileIdentityUnboundError,
		);

		const bound = setGatesForIdentity(
			tempDir,
			identity,
			{},
			{
				allowLegacyAdoption: true,
				legacyAdoptionIdentity: identity,
			},
		);
		expect(bound.plan_id).toBe(planId);
		expect(getProfileLookupForIdentity(tempDir, identity).kind).toBe('bound');
		expect(
			getProfileLookupForIdentity(tempDir, {
				swarm: 'missing',
				title: 'identity',
			}).kind,
		).toBe('missing');
	});

	test('getOrCreateProfile re-reads a concurrent winner after a UNIQUE race', () => {
		let firstRead = true;
		_internals.getProfile = (directory, planId) => {
			if (firstRead) {
				firstRead = false;
				const db = getProjectDb(directory);
				db.run(
					'INSERT INTO qa_gate_profile (plan_id, project_type, gates) VALUES (?, ?, ?)',
					[
						planId,
						'concurrent',
						JSON.stringify({ ...DEFAULT_QA_GATES, reviewer: true }),
					],
				);
				return null;
			}
			return originalGetProfile(directory, planId);
		};

		const winner = getOrCreateProfile(tempDir, 'plan-race', 'loser', {
			reviewer: false,
		});
		expect(winner.project_type).toBe('concurrent');
		expect(winner.gates.reviewer).toBe(true);
		expect(() => setGates(tempDir, 'plan-race', { reviewer: false })).toThrow(
			/ratchet/i,
		);
	});

	test('getOrCreateProfile is idempotent', () => {
		const a = getOrCreateProfile(tempDir, 'plan-1');
		const b = getOrCreateProfile(tempDir, 'plan-1');
		expect(a.id).toBe(b.id);
	});

	test('setGates can enable additional gates (ratchet tighter)', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		const updated = setGates(tempDir, 'plan-1', { council_mode: true });
		expect(updated.gates.council_mode).toBe(true);
		expect(updated.gates.reviewer).toBe(true);
	});

	test('setGates rejects attempts to disable an enabled gate', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		expect(() => setGates(tempDir, 'plan-1', { reviewer: false })).toThrow(
			/ratchet/i,
		);
	});

	test('setGatesForIdentity adopts an unlocked legacy row without changing immutable columns', () => {
		const identity = { swarm: 'legacy swarm', title: 'Legacy Plan' };
		const planId = derivePlanId(identity);
		const legacy = getOrCreateProfile(tempDir, planId, 'ts', {
			reviewer: false,
		});

		const adopted = setGatesForIdentity(
			tempDir,
			identity,
			{ reviewer: true },
			{
				allowLegacyAdoption: true,
				legacyAdoptionIdentity: identity,
			},
		);
		expect(adopted.id).toBe(legacy.id);
		expect(adopted.plan_id).toBe(planId);
		expect(adopted.gates.reviewer).toBe(true);

		const binding = getProjectDb(tempDir)
			.query<{ readable_plan_id: string }, [number]>(
				'SELECT readable_plan_id FROM qa_gate_profile_identity WHERE profile_id = ?',
			)
			.get(legacy.id);
		expect(binding?.readable_plan_id).toBe(planId);
	});

	test('setGatesForIdentity can adopt a locked legacy row with an empty patch but rejects locked mutations', () => {
		const identity = { swarm: 'legacy swarm', title: 'Legacy Plan' };
		const planId = derivePlanId(identity);
		getOrCreateProfile(tempDir, planId, 'ts');
		lockProfile(tempDir, planId, 7);

		const adopted = setGatesForIdentity(
			tempDir,
			identity,
			{},
			{
				allowLegacyAdoption: true,
				legacyAdoptionIdentity: identity,
			},
		);
		expect(adopted.locked_by_snapshot_seq).toBe(7);
		expect(getProfileLookupForIdentity(tempDir, identity).kind).toBe('bound');

		expect(() =>
			setGatesForIdentity(
				tempDir,
				identity,
				{ council_mode: true },
				{
					allowLegacyAdoption: true,
					legacyAdoptionIdentity: identity,
				},
			),
		).toThrow(/locked/i);
	});

	test('setGatesForIdentity creates a distinct exact row for a raw-different collision with an unbound legacy row', () => {
		const legacyIdentity = { swarm: 'mega one', title: 'Plan / 1' };
		const replacementIdentity = { swarm: 'mega?one', title: 'Plan ? 1' };
		const planId = derivePlanId(legacyIdentity);
		const legacy = getOrCreateProfile(tempDir, planId, 'ts', {
			reviewer: false,
		});

		const replacement = setGatesForIdentity(
			tempDir,
			replacementIdentity,
			{ mutation_test: true },
			{
				allowLegacyCollisionCreate: true,
			},
		);

		expect(replacement.id).not.toBe(legacy.id);
		expect(replacement.plan_id).toBe(planId);
		expect(replacement.gates.mutation_test).toBe(true);
		expect(getProfileLookupForIdentity(tempDir, replacementIdentity).kind).toBe(
			'bound',
		);
		expect(getProfileLookupForIdentity(tempDir, legacyIdentity).kind).toBe(
			'unbound_legacy',
		);
	});

	test('lockProfile sets locked_at and snapshot seq', () => {
		getOrCreateProfile(tempDir, 'plan-1');
		const locked = lockProfile(tempDir, 'plan-1', 7);
		expect(locked.locked_at).not.toBeNull();
		expect(locked.locked_by_snapshot_seq).toBe(7);
	});

	test('lockProfileForIdentity locks exact profiles by binding instead of readable plan id', () => {
		const identity = { swarm: 'exact swarm', title: 'Exact Plan' };
		getOrCreateProfileForIdentity(tempDir, identity);
		const locked = lockProfileForIdentity(tempDir, identity, 42);
		expect(locked.locked_at).not.toBeNull();
		expect(locked.locked_by_snapshot_seq).toBe(42);
	});

	test('computeProfileHash is stable and sensitive to gate changes', () => {
		const identity = { swarm: 'hash swarm', title: 'Hash Plan' };
		const p1 = getOrCreateProfileForIdentity(tempDir, identity);
		const h1 = computeProfileHash(p1);
		expect(h1).toMatch(/^[0-9a-f]{64}$/);

		const p2 = setGatesForIdentity(tempDir, identity, { council_mode: true });
		const h2 = computeProfileHash(p2);
		expect(h2).not.toBe(h1);
	});

	test('getEffectiveGates ratchets tighter via session overrides', () => {
		const p = getOrCreateProfile(tempDir, 'plan-1');
		const eff = getEffectiveGates(p, { council_mode: true });
		expect(eff.council_mode).toBe(true);
		expect(eff.reviewer).toBe(true);
	});

	test('getEffectiveGates ignores false overrides (cannot disable)', () => {
		const p = getOrCreateProfile(tempDir, 'plan-1');
		const eff = getEffectiveGates(p, { reviewer: false });
		expect(eff.reviewer).toBe(true);
	});
});
