/**
 * Single-source contract for the promotion evidence-gate default (MAS-001,
 * PR #3942 feedback round 1 / V5 P10).
 *
 * `promotion_min_terminal_applications` flipped its Zod default 0 -> 1 in this
 * PR (#3820 H1), but `evaluatePromotionPolicy` kept a hand-written
 * `config.promotion_min_terminal_applications ?? 0` fallback. The two defaults
 * could drift silently, and an UNPARSED config (a hand-built
 * `KnowledgeConfig`-shaped object that omits the field at runtime) got the
 * INERT gate — a fail-open divergence from the schema default of 1.
 *
 * This file pins the closed loop:
 *
 *  1. ONE exported constant `DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS = 1`
 *     lives in the zero-import leaf `src/hooks/knowledge-types.ts` (the same
 *     leaf `schema.ts` already sources `OUTCOME_BLOCK_THRESHOLD` from, so no
 *     import cycle and no zod dependency leaks into the hooks leaf chain).
 *  2. The Zod default is DERIVED from the constant (source scan + parsed
 *     value), so the committed `opencode-swarm.schema.json` "default": 1 is
 *     reproducible and this PR never needed to regenerate it.
 *  3. The policy fallback is DERIVED from the same constant (source scan), so
 *     `hive-policy.ts` never re-declares the literal.
 *  4. BEHAVIOR: a config that omits the field at runtime now fails CLOSED —
 *     the `validated_terminal_applications` gate is ACTIVE and an otherwise
 *     eligible entry with no independent evidence is refused. One independent
 *     receipt (allowlisted source) satisfies it.
 *  5. REGRESSION GUARDS: explicit 0 stays the documented operator opt-out,
 *     and the sibling `promotion_min_distinct_cohorts` absent-field fallback
 *     stays 0 (untouched by this fix).
 *  6. STRUCTURE: `hive-policy.ts` must not import zod, and
 *     `knowledge-types.ts` must stay import-free (a leaf — no cycle possible).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import { evaluatePromotionPolicy } from '../../../src/hooks/hive-policy.js';
import {
	DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS,
	type KnowledgeConfig,
	type PromotionEvidenceRecord,
	type SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { ACTIONABLE_FIELDS, makeConfig } from './hive-fixtures.js';

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const POLICY_SOURCE = path.join(REPO_ROOT, 'src', 'hooks', 'hive-policy.ts');
const TYPES_SOURCE = path.join(REPO_ROOT, 'src', 'hooks', 'knowledge-types.ts');
const SCHEMA_SOURCE = path.join(REPO_ROOT, 'src', 'config', 'schema.ts');
const GENERATED_SCHEMA_JSON = path.join(
	REPO_ROOT,
	'opencode-swarm.schema.json',
);

/** Collapse all whitespace runs to single spaces (source scans must survive
 * Biome line-wrapping of the pinned expressions). */
function normalizeWhitespace(source: string): string {
	return source.replace(/\s+/g, ' ');
}

/**
 * An otherwise-fully-eligible swarm entry: active status, eligibility route 1
 * (hive_eligible + 3 distinct phases — clock-independent, unlike route 3),
 * not confidence-floor-demoted, and actionable (predicate + scope tag).
 * Every gate except `validated_terminal_applications` passes, so the evidence
 * gate is the ONLY variable under test.
 */
function makeEligibleEntry(): SwarmKnowledgeEntry {
	return {
		id: 'e-single-source',
		tier: 'swarm',
		lesson: 'A canonical lesson that satisfies every non-evidence gate',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.7,
		status: 'active',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00Z',
				project_name: 'p',
			},
			{
				phase_number: 2,
				confirmed_at: '2026-01-02T00:00:00Z',
				project_name: 'p',
			},
			{
				phase_number: 3,
				confirmed_at: '2026-01-03T00:00:00Z',
				project_name: 'p',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		project_name: 'p',
		hive_eligible: true,
		...ACTIONABLE_FIELDS,
	};
}

function makeIndependentEvidence(): PromotionEvidenceRecord {
	return {
		cohort_id: 'cohort-A',
		entry_id: 'e-single-source',
		retrieval_trace_id: 'trace-1',
		receipt_outcome: 'applied',
		receipt_source: 'reviewer',
		receipt_event_id: 'receipt-1',
		timestamp: '2026-02-01T00:00:00Z',
	};
}

/**
 * Simulates the MAS-001 hazard: an UNPARSED, hand-built config whose
 * `promotion_min_terminal_applications` key is absent at runtime. The
 * destructure-omit keeps the object a real `KnowledgeConfig` for every OTHER
 * field (so unrelated gates stay honest) while the missing key forces the
 * policy fallback — exactly the pre-fix fail-open path.
 */
function configWithoutMinApps(): KnowledgeConfig {
	const { promotion_min_terminal_applications: _omitted, ...rest } =
		makeConfig();
	return rest;
}

function configWithoutMinCohorts(): KnowledgeConfig {
	const { promotion_min_distinct_cohorts: _omitted, ...rest } = makeConfig();
	return rest;
}

describe('DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS single source (MAS-001)', () => {
	describe('the constant', () => {
		it('is exported from the leaf knowledge-types module with value 1', () => {
			expect(DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS).toBe(1);
		});

		it('is declared exactly once in knowledge-types.ts (no forked copies)', () => {
			const source = readFileSync(TYPES_SOURCE, 'utf-8');
			const declarations = source.match(
				/(DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS\s*=\s*\d+)/g,
			);
			expect(declarations).toEqual([
				'DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS = 1',
			]);
		});
	});

	describe('Zod schema default is derived from the constant', () => {
		it('parses an empty config to the constant (and to 1)', () => {
			const parsed = KnowledgeConfigSchema.parse({});
			expect(parsed.promotion_min_terminal_applications).toBe(
				DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS,
			);
			expect(parsed.promotion_min_terminal_applications).toBe(1);
		});

		it('schema.ts references the constant in the .default(...) — not a bare literal', () => {
			const source = normalizeWhitespace(readFileSync(SCHEMA_SOURCE, 'utf-8'));
			expect(source).toMatch(
				/promotion_min_terminal_applications:\s*z\s*\.\s*number\(\)\s*\.\s*min\(0\)\s*\.\s*max\(100\)\s*\.\s*default\(\s*DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS\s*\)/,
			);
		});

		it('the committed generated opencode-swarm.schema.json still says "default": 1', () => {
			const json = JSON.parse(readFileSync(GENERATED_SCHEMA_JSON, 'utf-8')) as {
				properties?: Record<
					string,
					{ knowledge?: { properties?: Record<string, { default?: unknown }> } }
				>;
			};
			const knowledge =
				json.properties?.knowledge?.properties ??
				({} as Record<string, { default?: unknown }>);
			expect(knowledge.promotion_min_terminal_applications?.default).toBe(1);
		});
	});

	describe('policy fallback is derived from the same constant', () => {
		it('hive-policy.ts reads the fallback as ?? DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS', () => {
			const source = normalizeWhitespace(readFileSync(POLICY_SOURCE, 'utf-8'));
			expect(source).toContain(
				'config.promotion_min_terminal_applications ?? DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS',
			);
			// The drifted literal fallback must be gone.
			expect(source).not.toContain(
				'config.promotion_min_terminal_applications ?? 0',
			);
		});

		it('hive-policy.ts imports the constant from the leaf, not from schema.ts', () => {
			const source = readFileSync(POLICY_SOURCE, 'utf-8');
			expect(source).toMatch(
				/import\s*\{[^}]*DEFAULT_PROMOTION_MIN_TERMINAL_APPLICATIONS[^}]*\}\s*from\s*'\.\/knowledge-types\.js'/,
			);
		});
	});

	describe('behavior: an unparsed config missing the field fails CLOSED', () => {
		it('refuses an otherwise-eligible entry with no evidence (gate active, not inert)', () => {
			const decision = evaluatePromotionPolicy({
				entry: makeEligibleEntry(),
				config: configWithoutMinApps(),
				evidence: [],
			});
			expect(decision.eligible).toBe(false);
			const gate = decision.gates.find(
				(g) => g.name === 'validated_terminal_applications',
			);
			expect(gate).toBeDefined();
			expect(gate?.passed).toBe(false);
			// The inert detail ("threshold 0") must NOT appear — the gate is on.
			expect(gate?.detail).not.toContain('threshold 0');
			expect(decision.reason).toContain('validated_terminal_applications');
		});

		it('one independent reviewer receipt satisfies the fail-closed default', () => {
			const decision = evaluatePromotionPolicy({
				entry: makeEligibleEntry(),
				config: configWithoutMinApps(),
				evidence: [makeIndependentEvidence()],
			});
			expect(decision.eligible).toBe(true);
			expect(decision.reason).toBe('all policy gates passed');
		});
	});

	describe('regression guards (behavior that must NOT change)', () => {
		it('explicit promotion_min_terminal_applications: 0 stays the operator opt-out', () => {
			const decision = evaluatePromotionPolicy({
				entry: makeEligibleEntry(),
				config: makeConfig(), // fixtures pin 0/0 as the documented opt-out
				evidence: [],
			});
			expect(decision.eligible).toBe(true);
		});

		it('an absent promotion_min_distinct_cohorts still falls back to 0 (inert)', () => {
			const decision = evaluatePromotionPolicy({
				entry: makeEligibleEntry(),
				config: configWithoutMinCohorts(), // min apps stays 0 here
				evidence: [],
			});
			const gate = decision.gates.find(
				(g) => g.name === 'validated_terminal_applications',
			);
			expect(gate?.passed).toBe(true);
			expect(gate?.detail).toContain('threshold 0');
		});
	});

	describe('structural ratchet (import hygiene)', () => {
		it('hive-policy.ts never imports zod', () => {
			const source = readFileSync(POLICY_SOURCE, 'utf-8');
			expect(source).not.toMatch(/from\s+'zod'/);
		});

		it('knowledge-types.ts stays an import-free leaf (no cycle possible)', () => {
			const source = readFileSync(TYPES_SOURCE, 'utf-8');
			expect(source).not.toMatch(/^import\s/m);
			expect(source).not.toMatch(/^export\s+.*\sfrom\s/m);
		});
	});
});
