/**
 * Regression + edge-case tests for sanitize-malformed-values.ts.
 *
 * Covers:
 *   - Bug 1: No _def.typeName / ZodFirstPartyTypeKind in source (compile-time guarantee)
 *   - Bug 2: council + memory both reported in same recoveryWarnings
 *   - Bug 3: defaults preserved, only malformed field dropped
 *   - Bug 4: discriminatedUnion strategy preserved, bad leaf dropped
 *   - Bug 5: multiple malformed fields in same section
 *   - Edge cases: non-object inputs, idempotence, purity, termination
 *
 * FR-001 / SC-001.1, SC-001.2, SC-001.3
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
	type SanitizeResult,
	sanitizeMalformedValues,
} from '../../../src/config/sanitize-malformed-values';

// ─── Shared test schemas (duplicated from main test file) ───────────────────────

const minimalSchema = z.object({
	gates: z.object({ enabled: z.boolean() }).optional(),
	council: z
		.object({ enabled: z.boolean(), maxRound: z.number().optional() })
		.optional(),
	guardrails: z.object({ enabled: z.boolean() }).optional(),
	memory: z.object({ enabled: z.boolean() }).optional(),
});

const turboSchema = z.object({
	turbo: z
		.object({
			lean: z
				.object({ max_parallel_coders: z.number(), enabled: z.boolean() })
				.optional(),
		})
		.optional(),
	guardrails: z.object({ enabled: z.boolean() }).optional(),
});

const allOptionalSchema = z.object({
	gates: z.object({ enabled: z.boolean() }).optional(),
	council: z.object({ enabled: z.boolean() }).optional(),
	guardrails: z.object({ enabled: z.boolean() }).optional(),
	memory: z.object({ enabled: z.boolean() }).optional(),
});

// ─── Bug 1: No _def / schema introspection ─────────────────────────────────────

describe('Bug 1 regression — no _def / ZodFirstPartyTypeKind in source', () => {
	it('source uses ONLY safeParse + issue.path/keys/code — no schema introspection', () => {
		const fs = require('node:fs') as typeof import('node:fs');
		const src = fs.readFileSync(
			require('path').resolve(
				__dirname,
				'../../../src/config/sanitize-malformed-values.ts',
			),
			'utf-8',
		);
		// Strip comment lines before checking — the doc comment mentions _def as
		// a thing we intentionally avoid, so it appears in text but not code.
		const codeLines = src
			.split('\n')
			.filter(
				(l: string) => !l.trim().startsWith('*') && !l.trim().startsWith('//'),
			)
			.join('\n');
		expect(codeLines).not.toMatch(/_def\b/);
		expect(codeLines).not.toMatch(/ZodFirstPartyTypeKind/);
		expect(codeLines).not.toMatch(/\.shape\./);
		expect(codeLines).not.toMatch(/instanceof Zod/);
	});

	it('nested optional + default wrappers: recovery works via public API', () => {
		// Proves the public-API approach handles wrappers that previously
		// required schema introspection to detect.
		const wrapperSchema = z.object({
			section: z
				.object({
					enabled: z.boolean().default(false),
					name: z.string().default('default-name'),
				})
				.optional()
				.transform((val) => val ?? { enabled: false, name: 'default-name' }),
			guardrails: z.object({ enabled: z.boolean() }).optional(),
		});

		const rawConfig = {
			section: { enabled: 'yes', name: 'USER-NAME' },
			guardrails: { enabled: true },
		};

		const { config, recoveryWarnings } = sanitizeMalformedValues(
			wrapperSchema,
			rawConfig,
		);

		// guardrails survives (valid).
		expect(config).toHaveProperty('guardrails');
		expect((config as Record<string, unknown>).guardrails).toEqual({
			enabled: true,
		});

		// A warning was emitted for the broken field (not for section as a whole).
		expect(recoveryWarnings.length).toBeGreaterThan(0);

		// section.name should NOT appear in warnings — it was valid.
		const warnedPaths = recoveryWarnings.map((w) => w.section);
		const nameInWarning = warnedPaths.some((s) => s.includes('name'));
		expect(nameInWarning).toBe(false);

		// section.enabled should be in warnings (the malformed field).
		const enabledInWarning = warnedPaths.some((s) => s.includes('enabled'));
		expect(enabledInWarning).toBe(true);
	});
});

// ─── Bug 2: both council + memory reported simultaneously ──────────────────────

describe('Bug 2 regression — council AND memory both reported in recoveryWarnings', () => {
	it('council.enabled = "yes" AND memory.enabled = 1 — BOTH reported, gates preserved', () => {
		const rawConfig = {
			gates: { enabled: true }, // valid
			council: { enabled: 'yes' }, // malformed
			memory: { enabled: 1 }, // malformed
		};

		const { config, recoveryWarnings } = sanitizeMalformedValues(
			minimalSchema,
			rawConfig,
		);

		// gates survives (valid).
		expect(config).toHaveProperty('gates');
		expect((config as Record<string, unknown>).gates).toEqual({
			enabled: true,
		});

		// BOTH council AND memory appear in warnings.
		const warnedSections = recoveryWarnings.map((w) => w.section);
		expect(warnedSections.some((s) => s.includes('council'))).toBe(true);
		expect(warnedSections.some((s) => s.includes('memory'))).toBe(true);

		// At least 2 warnings (one per section).
		expect(recoveryWarnings.length).toBeGreaterThanOrEqual(2);
	});
});

// ─── Bug 3: defaults preserved, only malformed field dropped ────────────────────

describe('Bug 3 regression — defaults preserved, only malformed field dropped', () => {
	it('section.enabled malformed, section.name valid — guardrails survives; enabled field reported in warnings', () => {
		// Schema defines both enabled and name as valid fields.
		// After removing enabled, { name: 'USER-NAME' } is still valid (name is a known key).
		const schemaWithDefaults = z.object({
			section: z
				.object({
					enabled: z.boolean().default(false),
					name: z.string().default('default-name'),
				})
				.optional(),
			guardrails: z.object({ enabled: z.boolean() }).optional(),
		});

		const rawConfig = {
			section: { enabled: 'yes', name: 'USER-NAME' },
			guardrails: { enabled: true },
		};

		const { config, recoveryWarnings } = sanitizeMalformedValues(
			schemaWithDefaults,
			rawConfig,
		);

		// guardrails survives.
		expect(config).toHaveProperty('guardrails');

		// A warning was emitted.
		expect(recoveryWarnings.length).toBeGreaterThan(0);

		// The warning should mention the section and/or the enabled field.
		const warnedPaths = recoveryWarnings.map((w) => w.section);
		const hasEnabledWarning = warnedPaths.some((s) => s.includes('enabled'));
		expect(hasEnabledWarning).toBe(true);

		// section.name should NOT appear in warnings — it was valid.
		const nameInWarning = warnedPaths.some((s) => s.includes('name'));
		expect(nameInWarning).toBe(false);
	});
});

// ─── Bug 4: discriminatedUnion — strategy preserved, bad leaf dropped ───────────

describe('Bug 4 regression — discriminatedUnion strategy preserved, bad leaf dropped', () => {
	it('strategy = "lean" valid, lean.max_parallel_coders = "8" malformed — strategy kept, bad leaf dropped', () => {
		const discriminatedSchema = z.object({
			strategy: z.enum(['lean', 'standard']),
			lean: z
				.object({
					max_parallel_coders: z.number().default(4),
				})
				.optional(),
			standard: z
				.object({
					batch_size: z.number().optional(),
				})
				.optional(),
			guardrails: z.object({ enabled: z.boolean() }).optional(),
		});

		const rawConfig = {
			strategy: 'lean',
			lean: { max_parallel_coders: '8' }, // string instead of number
			guardrails: { enabled: true },
		};

		const { config, recoveryWarnings } = sanitizeMalformedValues(
			discriminatedSchema,
			rawConfig,
		);

		// strategy === 'lean' must be preserved.
		expect((config as Record<string, unknown>).strategy).toBe('lean');

		// guardrails survives.
		expect(config).toHaveProperty('guardrails');

		// The malformed lean.max_parallel_coders was dropped (warning emitted).
		expect(recoveryWarnings.length).toBeGreaterThan(0);
		const warnedPaths = recoveryWarnings.map((w) => w.section);
		const hasLeanWarning =
			warnedPaths.some((s) => s.includes('lean')) ||
			warnedPaths.some((s) => s.includes('max_parallel_coders'));
		expect(hasLeanWarning).toBe(true);
	});
});

// ─── Bug 5: multiple malformed fields in same section ──────────────────────────

describe('Bug 5 regression — multiple malformed fields in one section', () => {
	it('section.a AND section.b both malformed — section dropped with warning, guardrails survives', () => {
		// Bug 5 regression: when multiple fields in the same section are malformed,
		// the algorithm escalates to section-level drop (not field-level) because
		// individual field removal cannot satisfy the schema.
		const multiFieldSchema = z.object({
			section: z
				.object({
					a: z.boolean(),
					b: z.number(),
					name: z.string(),
				})
				.optional(),
			guardrails: z.object({ enabled: z.boolean() }).optional(),
		});

		const rawConfig = {
			section: {
				a: 'yes', // boolean expected, string given
				b: '2', // number expected, string given
				name: 'keep', // valid string
			},
			guardrails: { enabled: true },
		};

		const { config, recoveryWarnings } = sanitizeMalformedValues(
			multiFieldSchema,
			rawConfig,
		);

		// guardrails survives.
		expect(config).toHaveProperty('guardrails');

		// A warning was emitted for the section (at least 1 warning).
		expect(recoveryWarnings.length).toBeGreaterThanOrEqual(1);

		// The warning should mention the section (section-level drop).
		const warnedPaths = recoveryWarnings.map((w) => w.section);
		const hasSectionWarning = warnedPaths.some((s) => s.startsWith('section'));
		expect(hasSectionWarning).toBe(true);
	});
});

// ─── Escalation: leaf → ancestor → section (PRR-013) ──────────────────────────

describe('escalation — drops ancestor section when leaf removal cannot satisfy schema', () => {
	it('GIVEN a section with two required malformed fields, WHEN sanitizeMalformedValues parses, THEN it escalates from leaf-level to section-level drop AND the section-level path appears in warnings', () => {
		// Both `a` and `b` are REQUIRED (non-optional) booleans/numbers and both
		// are wrong type. Dropping just `a` leaves `{ b: 'wrong' }` which still
		// fails (b malformed AND a now missing-required). The fixed-point loop
		// therefore escalates: after leaf removal stalls, it walks up and drops
		// the entire `section` (which is OPTIONAL, so dropping it lets the valid
		// guardrails survive). We prove escalation by asserting the SURVIVING
		// guardrails is intact AND the warning names `section` (the ancestor),
		// not merely a leaf like `section.a`.
		const escalationSchema = z.object({
			section: z
				.object({
					a: z.boolean(),
					b: z.number(),
					name: z.string().optional(),
				})
				.optional(),
			guardrails: z.object({ enabled: z.boolean() }).optional(),
		});

		const rawConfig = {
			section: {
				a: 'yes', // string, not boolean
				b: 'two', // string, not number
				name: 'keep-me',
			},
			guardrails: { enabled: true },
		};

		const { config, recoveryWarnings } = sanitizeMalformedValues(
			escalationSchema,
			rawConfig,
		);

		// guardrails survives the escalation.
		expect(config).toHaveProperty('guardrails');
		expect((config as Record<string, unknown>).guardrails).toEqual({
			enabled: true,
		});

		// The section is gone entirely (escalation dropped the ancestor).
		expect(config).not.toHaveProperty('section');

		// Prove ESCALATION: a warning names the section-level path, not only a
		// leaf. If only leaf-level warnings existed, `section` would still be
		// present (only its fields removed). The ancestor-level warning is the
		// signature that escalation fired.
		const warnedPaths = recoveryWarnings.map((w) => w.section);
		expect(warnedPaths).toContain('section');
	});
});

// ─── Edge case: non-object inputs ─────────────────────────────────────────────

describe('non-object inputs — returns {} with root warning', () => {
	it('null input → {} with one root warning', () => {
		const { config, recoveryWarnings } = sanitizeMalformedValues(
			minimalSchema,
			null as unknown as Record<string, unknown>,
		);
		expect(config).toEqual({});
		expect(recoveryWarnings.length).toBe(1);
		expect(recoveryWarnings[0].section).toBe('<root>');
	});

	it('string input → {} with one root warning', () => {
		const { config, recoveryWarnings } = sanitizeMalformedValues(
			minimalSchema,
			'not-an-object' as unknown as Record<string, unknown>,
		);
		expect(config).toEqual({});
		expect(recoveryWarnings.length).toBe(1);
		expect(recoveryWarnings[0].section).toBe('<root>');
	});

	it('array input → {} with one root warning', () => {
		const { config, recoveryWarnings } = sanitizeMalformedValues(
			minimalSchema,
			[1, 2, 3] as unknown as Record<string, unknown>,
		);
		expect(config).toEqual({});
		expect(recoveryWarnings.length).toBe(1);
		expect(recoveryWarnings[0].section).toBe('<root>');
	});
});

// ─── Edge case: idempotence ───────────────────────────────────────────────────

describe('idempotence — second sanitize on result returns fast path', () => {
	it('sanitize(result.config) returns same config with empty warnings', () => {
		const rawConfig = {
			council: { enabled: 'yes' },
			gates: { enabled: true },
		};

		const first = sanitizeMalformedValues(minimalSchema, rawConfig);
		const second = sanitizeMalformedValues(minimalSchema, first.config);

		// Second call returns fast path (empty warnings).
		expect(second.recoveryWarnings).toEqual([]);
		// config may have been mutated between the two calls, but keys should match.
		expect(Object.keys(second.config).sort()).toEqual(
			Object.keys(first.config).sort(),
		);
	});
});

// ─── Edge case: all-malformed-with-guardrails-surviving ───────────────────────

describe('all-malformed — guardrails survives, everything else dropped', () => {
	it('all sections except guardrails malformed → guardrails survives, all others reported', () => {
		const rawConfig = {
			gates: { enabled: 'yes' },
			council: { enabled: 1 },
			memory: { enabled: 'true' },
			guardrails: { enabled: true }, // valid
		};

		const { config, recoveryWarnings } = sanitizeMalformedValues(
			allOptionalSchema,
			rawConfig,
		);

		// guardrails is the only survivor.
		expect(config).toHaveProperty('guardrails');
		expect(config).not.toHaveProperty('gates');
		expect(config).not.toHaveProperty('council');
		expect(config).not.toHaveProperty('memory');

		// Warnings for each dropped section.
		const warnedSections = recoveryWarnings.map((w) => w.section);
		expect(warnedSections.some((s) => s.includes('gates'))).toBe(true);
		expect(warnedSections.some((s) => s.includes('council'))).toBe(true);
		expect(warnedSections.some((s) => s.includes('memory'))).toBe(true);
	});
});

// ─── Edge case: purity — no mutation of input ──────────────────────────────────

describe('purity — input is never mutated', () => {
	it('input object is not modified after sanitize', () => {
		const rawConfig = {
			council: { enabled: 'yes' },
			gates: { enabled: true },
		};
		const snapshot = JSON.stringify(rawConfig);

		sanitizeMalformedValues(minimalSchema, rawConfig);

		expect(JSON.stringify(rawConfig)).toBe(snapshot);
	});

	it('nested values in input are not modified after sanitize', () => {
		const rawConfig = {
			turbo: {
				lean: {
					max_parallel_coders: '8', // will be dropped
					enabled: true,
				},
			},
		};
		const nestedSnapshot = JSON.stringify(
			(rawConfig as Record<string, unknown>).turbo,
		);

		sanitizeMalformedValues(turboSchema, rawConfig);

		expect(JSON.stringify((rawConfig as Record<string, unknown>).turbo)).toBe(
			nestedSnapshot,
		);
	});
});

// ─── Edge case: always-failing schema — bounded termination ───────────────────

describe('termination — always-failing schema returns in bounded time', () => {
	it('schema with always-failing refine completes without hanging', () => {
		const failingSchema = z.object({
			field: z.string().refine(() => false, {
				message: 'always fails',
			}),
		});

		const rawConfig = { field: 'any-value' };

		const start = Date.now();
		const { config, recoveryWarnings } = sanitizeMalformedValues(
			failingSchema,
			rawConfig,
		);
		const elapsed = Date.now() - start;

		// Must complete in bounded time (under 2 seconds even on slow CI).
		expect(elapsed).toBeLessThan(2000);

		// The field can never satisfy the always-failing refine, so recovery
		// exhausts its options and the post-loop last-resort drops every
		// top-level key — leaving an empty object. Pin this final state.
		expect(config).toEqual({});

		// Warnings exist proving recovery was attempted.
		expect(recoveryWarnings.length).toBeGreaterThan(0);
	});
});
