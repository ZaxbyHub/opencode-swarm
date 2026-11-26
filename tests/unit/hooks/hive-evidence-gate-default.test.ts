/**
 * Evidence gate ACTIVE at shipped defaults + independence allowlist +
 * privileged fast-track field (issue #3820 H1/H2/H3).
 *  - H1(a): `promotion_min_terminal_applications` defaults to 1 — zero
 *    independent application evidence (age-only, tag-only) is NOT promotable.
 *  - H1(b): independence is the explicit `INDEPENDENT_RECEIPT_SOURCES`
 *    allowlist; every other taxonomy source (and absent source) fails closed.
 *  - H2: manual paths load real evidence — unforced direct-text `promoteToHive`
 *    is refused naming the override; `force` + `reason` promotes with audited
 *    lineage; `promoteFromSwarm` consults a REAL loaded independent receipt.
 *  - H3: the caller-suppliable `hive-fast-track` TAG no longer arms route 2 —
 *    only the dedicated `hive_fast_track_authorized` field does;
 *    `knowledge_add` strips the tag from caller tags at ingress.
 * Real transactional contract via temp-dir I/O + the `_internals` DI seam
 * (invariant 7), never `mock.module`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	promises as fsPromises,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFile,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import { evaluatePromotionPolicy } from '../../../src/hooks/hive-policy.js';
import {
	_internals,
	checkHivePromotions,
	promoteFromSwarm,
	promoteToHive,
} from '../../../src/hooks/hive-promoter.js';
import { invalidateKnowledgeStoreDirCache } from '../../../src/hooks/knowledge-link.js';
import {
	CANONICAL_RECEIPT_SOURCES,
	INDEPENDENT_RECEIPT_SOURCES,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store.js';
import type {
	PromotionEvidenceRecord,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import {
	_internals as evidenceStoreInternals,
	loadPromotionEvidenceByEntry,
} from '../../../src/hooks/promotion-evidence-store.js';
import { knowledge_add } from '../../../src/tools/knowledge-add.js';
import { redirectHiveHome } from '../../helpers/hive-home';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { ACTIONABLE_FIELDS, readRawHive } from './hive-fixtures.js';

const FROZEN_NOW = Date.parse('2026-07-01T00:00:00.000Z');
const FROZEN_ISO = new Date(FROZEN_NOW).toISOString();
const OLD_ISO = new Date(FROZEN_NOW - 200 * 86_400_000).toISOString();

// F-005/FB-208 (invariant 7): capture the pristine seams before ANY override
// so afterEach restores them. `realLoadEvidence` re-binds to the production
// loader (a sibling suite may have polluted the seam at import time).
const originalResolveCohortId = _internals.resolveCohortId;
const originalValidateLesson = _internals.validateLesson;
const realLoadEvidence: typeof _internals.loadPromotionEvidence = async (
	directory,
	canonicalCohortId,
) => loadPromotionEvidenceByEntry(directory, canonicalCohortId);

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: 'e1',
		tier: 'swarm',
		lesson: 'A canonical lesson about evidence-gated hive promotion here',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.7,
		status: 'promoted',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 3,
		created_at: FROZEN_ISO,
		updated_at: FROZEN_ISO,
		project_name: 'p',
		...ACTIONABLE_FIELDS,
		...overrides,
	};
}

/** Fixed cohort identity so end-to-end legs do not shell out to git. */
const FIXTURE_COHORT = {
	cohortId: 'cohort-3820-evidence-gate',
	source: 'remote' as const,
	normalizedRemote: 'github.com/t/3820',
	degraded: false,
};

/** Route 1 qualification: hive_eligible + 3 distinct phase confirmations. */
const THREE_PHASES = [1, 2, 3].map((n) => ({
	phase_number: n,
	confirmed_at: `2026-01-0${n}T00:00:00.000Z`,
	project_name: 'p',
}));

function record(
	overrides: Partial<PromotionEvidenceRecord>,
): PromotionEvidenceRecord {
	return {
		cohort_id: 'cohort-A',
		entry_id: 'e1',
		retrieval_trace_id: 't1',
		receipt_outcome: 'applied',
		receipt_event_id: 'r1',
		timestamp: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

/** The one gate every H1/H3 refusal below is attributable to. */
function evidenceGateOf(decision: {
	gates: { name: string; passed: boolean; detail: string }[];
}) {
	return decision.gates.find(
		(g) => g.name === 'validated_terminal_applications',
	);
}

/** Sources that are NOT independent — every non-allowlist taxonomy member. */
const REFUSED_SOURCES = [
	'delegate',
	'architect_marker',
	'application_gate_staleness_release',
	'application_gate_denial_limit_release',
	'application_gate_session_reset_release',
	'manual',
	'migration',
	'phase_override',
	'unknown',
] as const;

/** Sources the #3820 H1(b) allowlist accepts as independent. */
const ACCEPTED_SOURCES = ['reviewer', 'architect', 'test_engineer'] as const;

describe('#3820 H1(a) — shipped defaults make the evidence gate bite', () => {
	it('an age-only entry (0 evidence, 0 confirmations) is ineligible at the shipped defaults', () => {
		const defaults = KnowledgeConfigSchema.parse({});
		const decision = evaluatePromotionPolicy({
			entry: makeEntry({
				hive_eligible: false,
				created_at: OLD_ISO, // route 3 (age) fires — 200 days old
			}),
			config: defaults,
			evidence: [],
		});

		// Qualifies through the age route → the refusal is attributable to the
		// evidence gate, not an unrelated one.
		expect(
			decision.gates.find((g) => g.name === 'eligibility_route')?.detail,
		).toContain('route 3');
		const gate = evidenceGateOf(decision);
		expect(gate?.detail).not.toContain('threshold 0');
		expect(gate?.passed).toBe(false);
		expect(decision.eligible).toBe(false);
	});

	it('a caller-supplied hive-fast-track TAG alone (no authorization field) is ineligible', () => {
		const defaults = KnowledgeConfigSchema.parse({});
		const decision = evaluatePromotionPolicy({
			entry: makeEntry({
				tags: ['hive-fast-track'],
				hive_eligible: false,
				created_at: FROZEN_ISO, // young — no route fires from the tag
			}),
			config: defaults,
			evidence: [],
		});
		expect(decision.eligible).toBe(false);
		const failed = decision.gates.filter((g) => !g.passed).map((g) => g.name);
		expect(
			failed.some(
				(name) =>
					name === 'eligibility_route' ||
					name === 'validated_terminal_applications',
			),
		).toBe(true);
	});

	it('the allowlist is exactly the three independent role sources', () => {
		expect([...INDEPENDENT_RECEIPT_SOURCES].sort()).toEqual([
			'architect',
			'reviewer',
			'test_engineer',
		]);
		// The allowlist is a subset of the closed receipt-source taxonomy.
		for (const source of INDEPENDENT_RECEIPT_SOURCES) {
			expect(CANONICAL_RECEIPT_SOURCES.has(source)).toBe(true);
		}
	});
});

describe('#3820 H1(b) — per-source independence at the shipped defaults', () => {
	const evaluateWithSource = (receipt_source?: string) =>
		evaluatePromotionPolicy({
			entry: makeEntry({ hive_eligible: true, confirmed_by: THREE_PHASES }),
			config: KnowledgeConfigSchema.parse({}),
			evidence: [
				record(
					receipt_source === undefined
						? { receipt_event_id: 'r-legacy' }
						: { receipt_source },
				),
			],
		});

	for (const source of REFUSED_SOURCES) {
		it(`refuses '${source}' evidence (not independent) at the shipped defaults`, () => {
			const decision = evaluateWithSource(source);
			expect(evidenceGateOf(decision)?.passed).toBe(false);
			expect(decision.eligible).toBe(false);
		});
	}

	it('refuses source-less (pre-#2032) evidence at the shipped defaults', () => {
		const decision = evaluateWithSource(undefined);
		expect(evidenceGateOf(decision)?.passed).toBe(false);
		expect(decision.eligible).toBe(false);
	});

	for (const source of ACCEPTED_SOURCES) {
		it(`accepts '${source}' evidence as independent at the shipped defaults`, () => {
			const decision = evaluateWithSource(source);
			const gate = evidenceGateOf(decision);
			expect(gate?.passed).toBe(true);
			expect(gate?.detail).toContain('independent receipt(s)');
			expect(decision.eligible).toBe(true);
		});
	}
});

describe('#3820 H2/H3 — promoter end-to-end behavior on the default config', () => {
	const defaults = KnowledgeConfigSchema.parse({});
	const DIRECT_LESSON =
		'Always validate the promotion evidence gate before a hive write lands';

	let tempHome: string;
	let swarmDir: string;
	let restoreHiveHome: () => void = () => {};
	let restoreClock: Restore | null = null;

	beforeEach(() => {
		tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hive-eg-')));
		restoreHiveHome = redirectHiveHome(tempHome);
		swarmDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-eg-')));
		restoreClock = freezeClock({ fixedNow: FROZEN_NOW });
		_internals.resolveCohortId = mock(async () => FIXTURE_COHORT);
		_internals.validateLesson = mock(() => ({
			valid: true,
			layer: 1,
			reason: '',
			severity: 'none' as const,
		})) as unknown as typeof _internals.validateLesson;
		// Default for the H2 legs; the H3 legs override per-leg.
		_internals.loadPromotionEvidence = mock(
			async () => ({}),
		) as unknown as typeof _internals.loadPromotionEvidence;
	});

	afterEach(() => {
		try {
			restoreHiveHome();
			restoreClock?.();
			rmSync(tempHome, { recursive: true, force: true });
			rmSync(swarmDir, { recursive: true, force: true });
		} finally {
			// Restore ALL three overridden seams (F-005/FB-208) even if cleanup throws.
			_internals.resolveCohortId = originalResolveCohortId;
			_internals.validateLesson = originalValidateLesson;
			_internals.loadPromotionEvidence = realLoadEvidence;
			mock.restore();
		}
	});

	it('unforced direct-text promoteToHive is refused with the override-naming message', async () => {
		const msg = await promoteToHive(
			swarmDir,
			DIRECT_LESSON,
			undefined,
			undefined,
			undefined,
			ACTIONABLE_FIELDS,
		);
		expect(msg).toContain('Promotion blocked by policy');
		expect(msg).toContain('validated_terminal_applications');
		expect(msg).toContain('--force --reason');
		expect(await readRawHive()).toHaveLength(0);
	});

	it('forced direct-text promotion (force + reason) succeeds and writes audited lineage', async () => {
		const msg = await promoteToHive(
			swarmDir,
			DIRECT_LESSON,
			undefined,
			{ force: true, reason: 'operator-verified lesson, no receipts yet' },
			undefined,
			ACTIONABLE_FIELDS,
		);
		expect(msg).toContain('Promoted to hive');
		const hive = await readRawHive();
		expect(hive).toHaveLength(1);
		expect(hive[0].lineage?.actor).toBe('manual-override');
		expect(hive[0].lineage?.reason).toBe(
			'operator-verified lesson, no receipts yet',
		);
		expect(hive[0].lineage?.override_failed_gates).toContain(
			'validated_terminal_applications',
		);
		expect(hive[0].lineage?.promotion_event_id).toBeTruthy();
		// The written hive entry never inherits a privileged route-2 tag.
		expect(hive[0].tags ?? []).not.toContain('hive-fast-track');
	});

	it('promoteFromSwarm succeeds with a REAL loaded independent receipt', async () => {
		const swarm = makeEntry({
			id: 'e-real',
			hive_eligible: true,
			confirmed_by: THREE_PHASES,
		});
		const fp = resolveSwarmKnowledgePath(swarmDir);
		await fsPromises.mkdir(path.dirname(fp), { recursive: true });
		await fsPromises.writeFile(fp, `${JSON.stringify(swarm)}\n`, 'utf-8');

		// Restore the REAL evidence loader; the seeded ledger seam beneath it
		// (frozen C11) maps membership into PromotionEvidenceRecords by entry id.
		_internals.loadPromotionEvidence = realLoadEvidence;
		const realQuery = evidenceStoreInternals.queryHistoricalOutcomes;
		evidenceStoreInternals.queryHistoricalOutcomes = (async () => ({
			ok: true,
			memberships: [
				{
					cohort_id: FIXTURE_COHORT.cohortId,
					source_link_id: 'link-1',
					entry_id: 'e-real',
					trace_id: 'trace-real',
					phase: 1,
					terminal_history: [
						{
							outcome: 'applied',
							source: 'reviewer',
							event_id: 'receipt-real',
							committed_at: '2026-01-01T00:00:00Z',
						},
					],
				},
			],
		})) as unknown as typeof evidenceStoreInternals.queryHistoricalOutcomes;

		try {
			const msg = await promoteFromSwarm(swarmDir, 'e-real');
			expect(msg).toContain('Promoted lesson e-real');
			expect(msg).not.toContain('Promotion blocked by policy');
			const hive = await readRawHive();
			expect(hive).toHaveLength(1);
			expect(hive[0].lineage?.actor).toBe('manual');
			expect(hive[0].lineage?.override_failed_gates).toBeUndefined();
		} finally {
			evidenceStoreInternals.queryHistoricalOutcomes = realQuery;
		}
	});

	it('adversarial: a tagged entry WITH qualifying evidence but NO authorization field is not promoted', async () => {
		// One qualifying reviewer receipt — the evidence gate passes at defaults,
		// so the ONLY thing that can refuse the entry is the eligibility route
		// (the tag must not arm route 2).
		_internals.loadPromotionEvidence = mock(async () => ({
			'e-tagged': [
				record({ entry_id: 'e-tagged', receipt_source: 'reviewer' }),
			],
		})) as unknown as typeof _internals.loadPromotionEvidence;
		const entry = makeEntry({
			id: 'e-tagged',
			tags: ['hive-fast-track'],
			hive_eligible: false,
		});
		const summary = await checkHivePromotions([entry], defaults, swarmDir);
		expect(summary.new_promotions).toBe(0);
		expect((summary.diagnostics ?? []).join(' ')).toContain(
			'eligibility_route',
		);
		expect(await readRawHive()).toHaveLength(0);
	});

	it('the dedicated authorization field arms route 2 (same entry, field set)', async () => {
		_internals.loadPromotionEvidence = mock(async () => ({
			'e-field': [record({ entry_id: 'e-field', receipt_source: 'reviewer' })],
		})) as unknown as typeof _internals.loadPromotionEvidence;
		const entry = makeEntry({
			id: 'e-field',
			tags: [],
			hive_fast_track_authorized: true,
			hive_eligible: false,
		});
		const summary = await checkHivePromotions([entry], defaults, swarmDir);
		expect(summary.new_promotions).toBe(1);
		const hive = await readRawHive();
		expect(hive).toHaveLength(1);
		// The privileged arming field is policy transport only — it is not
		// copied onto the promoted hive entry as a caller-visible tag.
		expect(hive[0].tags ?? []).not.toContain('hive-fast-track');
	});

	it('a pre-existing legacy tag-bearing entry still promotes through real routes', async () => {
		// Legacy tag-bearing entries keep working when they qualify through a
		// REAL route (here route 1) with independent evidence.
		_internals.loadPromotionEvidence = mock(async () => ({
			e1: [record({ receipt_source: 'reviewer' })],
		})) as unknown as typeof _internals.loadPromotionEvidence;
		const entry = makeEntry({
			tags: ['hive-fast-track'],
			hive_eligible: true,
			confirmed_by: THREE_PHASES,
		});
		const summary = await checkHivePromotions([entry], defaults, swarmDir);
		expect(summary.new_promotions).toBe(1);
		expect(await readRawHive()).toHaveLength(1);
	});
});

describe('#3820 H3 — knowledge_add ingress strips the privileged tag', () => {
	const V3_FIELDS = {
		applies_to_agents: ['coder'],
		required_actions: ['apply this lesson when relevant'],
	};
	let tmpDir: string;
	let cleanupDir: () => void;
	let cleanupEnv: () => void;

	beforeEach(() => {
		cleanupEnv = createIsolatedTestEnv().cleanup;
		const created = createSafeTestDir('hive-evidence-ingress-');
		tmpDir = created.dir;
		cleanupDir = created.cleanup;
		invalidateKnowledgeStoreDirCache();
	});

	afterEach(() => {
		invalidateKnowledgeStoreDirCache();
		cleanupDir();
		cleanupEnv();
	});

	async function add(args: Record<string, unknown>) {
		return JSON.parse(
			await knowledge_add.execute(args, { directory: tmpDir } as never),
		);
	}

	async function readEntries(): Promise<Array<Record<string, unknown>>> {
		try {
			const content = await fsPromises.readFile(
				path.join(tmpDir, '.swarm', 'knowledge.jsonl'),
				'utf-8',
			);
			return content
				.split('\n')
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l) as Record<string, unknown>);
		} catch {
			return [];
		}
	}

	it('caller-supplied hive-fast-track tags are stripped and the authorization field is never set', async () => {
		const res = await add({
			lesson: 'Prefer explicit column widths over implicit defaults here',
			category: 'process',
			...V3_FIELDS,
			tags: ['hive-fast-track', 'linting', 'HIVE-FAST-TRACK'],
		});
		expect(res.success).toBe(true);
		const entries = await readEntries();
		expect(entries).toHaveLength(1);
		const tags = entries[0].tags as string[];
		expect(tags).not.toContain('hive-fast-track');
		expect(tags).not.toContain('HIVE-FAST-TRACK');
		expect(tags).toContain('linting');
		// The caller can never write the privileged authorization field through
		// knowledge_add — the stored entry does not carry it.
		expect(entries[0].hive_fast_track_authorized).toBeUndefined();
	});
});
