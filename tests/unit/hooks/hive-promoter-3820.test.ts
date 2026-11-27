/**
 * #3820 reshape coverage extracted from hive-promoter.test.ts (FR-006: that
 * file is over the 500-line cap, so its #3820 additions live here to keep it
 * net-zero). The four tests below are the strength-preserving reshapes plus
 * their negative legs:
 *   - route 2 armed ONLY by the dedicated `hive_fast_track_authorized` field
 *     (H3); the caller-supplied `hive-fast-track` tag no longer promotes.
 *   - direct-text promotion requires the audited `--force --reason` override
 *     under the default-on application-evidence gate (H2/ASK-1).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	checkHivePromotions,
	promoteToHive,
} from '../../../src/hooks/hive-promoter.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { KNOWLEDGE_SCHEMA_VERSION } from '../../../src/hooks/knowledge-types.js';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';
import { redirectHiveHome } from '../../helpers/hive-home';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { ACTIONABLE_FIELDS, makeConfig, readRawHive } from './hive-fixtures.js';

const FROZEN_NOW = Date.parse('2026-07-01T00:00:00.000Z');
const FROZEN_ISO = new Date(FROZEN_NOW).toISOString();

let restoreClock: Restore | null = null;
beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FROZEN_NOW });
});
afterEach(() => restoreClock?.());

/** A fixed cohort identity so tests do not shell out to git. */
const FIXED_COHORT = {
	cohortId: 'cohort-aaaa11112222',
	source: 'remote' as const,
	normalizedRemote: 'github.com/test/repo',
	degraded: false,
};

// F-005/FB-208 (invariant 7): capture the PRISTINE seams before ANY override
// so afterEach can restore them. `mock.restore()` resets the mock functions
// but leaves the `_internals` properties pointing at them, which leaked the
// mocks into sibling test files sharing this Bun process.
const originalResolveCohortId = _internals.resolveCohortId;
const originalValidateLesson = _internals.validateLesson;
const originalLoadPromotionEvidence = _internals.loadPromotionEvidence;

function makeSwarmEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: 'swarm-1',
		tier: 'swarm',
		lesson: 'Use bun for fast test execution across the project',
		category: 'process',
		tags: ['testing', 'performance'],
		scope: 'global',
		confidence: 0.7,
		status: 'promoted',
		hive_eligible: true,
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		project_name: 'projectA',
		...ACTIONABLE_FIELDS,
		...overrides,
	};
}

describe('hive-promoter #3820 reshapes (route 2 field + audited direct text)', () => {
	let tempHome: string;
	let swarmDir: string;
	let restoreHiveHome: () => void = () => {};

	beforeEach(() => {
		tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hive-test-')));
		restoreHiveHome = redirectHiveHome(tempHome);
		swarmDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-')));
		_internals.resolveCohortId = mock(async () => FIXED_COHORT);
		_internals.validateLesson = mock(() => ({
			valid: true,
			layer: 0,
			reason: '',
			severity: undefined,
		})) as unknown as typeof _internals.validateLesson;
		_internals.loadPromotionEvidence = mock(
			async () => ({}),
		) as unknown as typeof _internals.loadPromotionEvidence;
	});

	afterEach(() => {
		try {
			restoreHiveHome();
			rmSync(tempHome, { recursive: true, force: true });
			rmSync(swarmDir, { recursive: true, force: true });
		} finally {
			// Restore ALL three overridden seams (F-005/FB-208) even when the
			// cleanup above throws, so the leak never outlives this file.
			_internals.resolveCohortId = originalResolveCohortId;
			_internals.validateLesson = originalValidateLesson;
			_internals.loadPromotionEvidence = originalLoadPromotionEvidence;
			mock.restore();
		}
	});

	it('route 2: authorized fast-track field promotes regardless of phase count', async () => {
		const entry = makeSwarmEntry({
			hive_fast_track_authorized: true,
			hive_eligible: false,
			confirmed_by: [],
		});
		await checkHivePromotions([entry], makeConfig(), swarmDir);
		expect(await readRawHive()).toHaveLength(1);
	});

	it('route 2 negative: the caller-supplied hive-fast-track TAG alone does NOT promote', async () => {
		const entry = makeSwarmEntry({
			tags: ['hive-fast-track'],
			hive_eligible: false,
			confirmed_by: [],
			created_at: FROZEN_ISO, // recent, so route 3 (age) cannot fire either
		});
		const summary = await checkHivePromotions([entry], makeConfig(), swarmDir);
		expect(summary.new_promotions).toBe(0);
		expect(await readRawHive()).toHaveLength(0);
	});

	it('force+reason direct text writes to the canonical hive path with lineage + canonical fields', async () => {
		const msg = await promoteToHive(
			swarmDir,
			'Always run the full test suite before merging a pull request',
			undefined,
			{ force: true, reason: 'audited direct-text promotion (#3820)' },
			undefined,
			// #1821 A3: the direct-text path must supply its own predicate +
			// scope; the actionability_floor gate is ON by default.
			ACTIONABLE_FIELDS,
		);
		expect(msg).toContain('Promoted to hive');
		const hive = await readRawHive();
		expect(hive).toHaveLength(1);
		expect(hive[0].scope).toBe('global');
		expect(hive[0].retrieval_outcomes).toBeDefined();
		expect(hive[0].confidence).toBe(1.0);
		expect(hive[0].status).toBe('promoted');
		expect(hive[0].tier).toBe('hive');
		// The audited override is the actor now: the evidence gate fails for
		// the no-prior-id stand-in, so the promotion records the failed gates.
		expect(hive[0].lineage?.actor).toBe('manual-override');
		expect(hive[0].lineage?.reason).toBe(
			'audited direct-text promotion (#3820)',
		);
		expect(hive[0].lineage?.override_failed_gates).toContain(
			'validated_terminal_applications',
		);
		expect(hive[0].lineage?.source_cohort_id).toBe(FIXED_COHORT.cohortId);
		// schema_version tracks KNOWLEDGE_SCHEMA_VERSION, not a hardcoded
		// literal (M3 fix).
		expect(hive[0].schema_version).toBe(KNOWLEDGE_SCHEMA_VERSION);
		// source_project = basename of directory.
		expect(hive[0].source_project).toBe(path.basename(swarmDir));
	});

	it('unforced direct text is refused with the override-naming message', async () => {
		const msg = await promoteToHive(
			swarmDir,
			'Always run the full test suite before merging a pull request',
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

	it('hive store stays empty when nothing promoted', async () => {
		expect(await readRawHive()).toHaveLength(0);
		expect(resolveHiveKnowledgePath()).toContain(tempHome);
	});
});
