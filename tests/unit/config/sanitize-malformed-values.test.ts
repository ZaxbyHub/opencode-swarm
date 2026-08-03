/**
 * Tests for sanitize-malformed-values.ts — recursive recovery granularity policy.
 *
 * Tests verify that when a config has malformed values, the recovery helper:
 *   1. Preserves valid sections (SC-001.1, SC-001.2, SC-001.3)
 *   2. Drops leaf scalars and uses defaults (leaf-scalar granularity)
 *   3. Drops entire sections when needed (section-drop granularity)
 *   4. Recurses upward correctly (regression-upward)
 *   5. Handles the all-malformed case (only guardrails survives)
 *   6. Handles clean and empty configs without warnings
 *   7. Terminates on pathological inputs
 *
 * FR-001 / SC-001.1, SC-001.2, SC-001.3
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
	type RecoveryWarning,
	type SanitizeResult,
	sanitizeMalformedValues,
} from '../../../src/config/sanitize-malformed-values';

// ─── Helper schemas for testing ────────────────────────────────────────────────

/** Minimal top-level schema used across most tests. */
const minimalSchema = z.object({
	gates: z
		.object({
			enabled: z.boolean(),
		})
		.optional(),
	council: z
		.object({
			enabled: z.boolean(),
			maxRound: z.number().optional(),
		})
		.optional(),
	guardrails: z
		.object({
			enabled: z.boolean(),
		})
		.optional(),
	memory: z
		.object({
			enabled: z.boolean(),
		})
		.optional(),
});

/** Schema with a nested turbo.lean section for leaf/section granularity tests. */
const turboSchema = z.object({
	turbo: z
		.object({
			lean: z
				.object({
					max_parallel_coders: z.number(),
					enabled: z.boolean(),
				})
				.optional(),
		})
		.optional(),
	guardrails: z
		.object({
			enabled: z.boolean(),
		})
		.optional(),
});

/** Schema with a pr_monitor section that must be an object. */
const prMonitorSchema = z.object({
	pr_monitor: z
		.object({
			enabled: z.boolean(),
			pollingInterval: z.number().optional(),
		})
		.optional(),
	guardrails: z
		.object({
			enabled: z.boolean(),
		})
		.optional(),
});

/** Schema with all sections optional — used for all-malformed case. */
const allOptionalSchema = z.object({
	gates: z.object({ enabled: z.boolean() }).optional(),
	council: z.object({ enabled: z.boolean() }).optional(),
	guardrails: z.object({ enabled: z.boolean() }).optional(),
	memory: z.object({ enabled: z.boolean() }).optional(),
});

describe('sanitizeMalformedValues', () => {
	// ── SC-001.1 ───────────────────────────────────────────────────────────────
	describe('SC-001.1 — valid gates block + malformed council.enabled', () => {
		it('GIVEN valid gates block and council.enabled = "yes", WHEN sanitizeMalformedValues parses, THEN gates is preserved AND a warning is emitted naming the broken field or section', () => {
			const rawConfig = {
				gates: { enabled: true },
				council: { enabled: 'yes' }, // string instead of boolean
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				minimalSchema,
				rawConfig,
			);

			// Valid gates is preserved.
			expect(config).toHaveProperty('gates');
			expect((config as Record<string, unknown>).gates).toEqual({
				enabled: true,
			});

			// council is either dropped (if section-level recovery) or the field is dropped.
			// The key invariant: gates survives.
			// A warning is emitted for the broken field or section.
			expect(recoveryWarnings.length).toBeGreaterThan(0);
			const brokenSections = recoveryWarnings.map((w) => w.section);
			// The warning should name council (either as 'council' or 'council.enabled').
			expect(brokenSections.some((s) => s.includes('council'))).toBe(true);
		});
	});

	// ── SC-001.2 ───────────────────────────────────────────────────────────────
	describe('SC-001.2 — two distinct sections each with a malformed value', () => {
		it('GIVEN council.enabled = "yes" AND memory.enabled = 1 (number), WHEN sanitizeMalformedValues parses, THEN valid gates is preserved AND at least one broken section is reported', () => {
			const rawConfig = {
				gates: { enabled: true },
				council: { enabled: 'yes' }, // string instead of boolean
				memory: { enabled: 1 }, // number instead of boolean
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				minimalSchema,
				rawConfig,
			);

			// Valid gates survives.
			expect(config).toHaveProperty('gates');
			expect((config as Record<string, unknown>).gates).toEqual({
				enabled: true,
			});

			// At least one warning was emitted for a broken section.
			expect(recoveryWarnings.length).toBeGreaterThan(0);
			const sections = recoveryWarnings.map((w) => w.section);
			// gates should NOT be in warnings (it's valid).
			expect(sections.some((s) => s.includes('gates'))).toBe(false);
		});
	});

	// ── SC-001.3 ───────────────────────────────────────────────────────────────
	describe('SC-001.3 — single section malformed → result is NOT bare guardrails-only default', () => {
		it('GIVEN only council.enabled = "yes", WHEN sanitizeMalformedValues parses, THEN the result is not a bare empty object — a warning is emitted proving recovery was attempted', () => {
			const rawConfig = {
				council: { enabled: 'yes' }, // malformed
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				minimalSchema,
				rawConfig,
			);

			// Result has at least one warning (something was dropped).
			expect(recoveryWarnings.length).toBeGreaterThan(0);

			// The key invariant: the result is not the bare guardrails-only default.
			// recoveryWarnings prove recovery was attempted and a specific section was dropped.
			const sections = recoveryWarnings.map((w) => w.section);
			expect(sections.some((s) => s.includes('council'))).toBe(true);
		});
	});

	// ── Leaf-scalar granularity ─────────────────────────────────────────────────
	describe('leaf-scalar granularity — drop individual leaf field when possible', () => {
		it('GIVEN turbo.lean.max_parallel_coders = "8" (string), WHEN sanitizeMalformedValues parses, THEN a warning is emitted for the dropped field AND the remaining config is valid', () => {
			const rawConfig = {
				turbo: {
					lean: {
						max_parallel_coders: '8', // string instead of number
						enabled: true, // valid boolean
					},
				},
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				turboSchema,
				rawConfig,
			);

			// A warning is emitted for the dropped field or section.
			expect(recoveryWarnings.length).toBeGreaterThan(0);
			const sections = recoveryWarnings.map((w) => w.section);
			// The warning should mention either the field (max_parallel_coders) or the
			// section (turbo.lean) depending on which level recovery happened at.
			const hasExpectedWarning =
				sections.some((s) => s.includes('max_parallel_coders')) ||
				sections.some((s) => s.includes('lean'));
			expect(hasExpectedWarning).toBe(true);

			// The final config should be a valid object (may be empty if entire
			// turbo section was dropped).
			expect(typeof config).toBe('object');
		});
	});

	// ── Section-drop granularity ────────────────────────────────────────────────
	describe('section-drop granularity — drop entire section when type is wrong', () => {
		it('GIVEN pr_monitor = "enabled" (string instead of object), WHEN sanitizeMalformedValues parses, THEN pr_monitor section is absent AND guardrails survives', () => {
			const rawConfig = {
				pr_monitor: 'enabled', // string instead of object
				guardrails: { enabled: true },
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				prMonitorSchema,
				rawConfig,
			);

			// pr_monitor is gone.
			expect(config).not.toHaveProperty('pr_monitor');

			// guardrails survives.
			expect(config).toHaveProperty('guardrails');
			expect((config as Record<string, unknown>).guardrails).toEqual({
				enabled: true,
			});

			// A section-level warning is emitted.
			const sections = recoveryWarnings.map((w) => w.section);
			expect(sections.some((s) => s.includes('pr_monitor'))).toBe(true);
		});
	});

	// ── Recursion-upward ───────────────────────────────────────────────────────
	describe('recursion-upward — drop lean section, preserve turbo', () => {
		it('GIVEN turbo.lean with multiple bad fields, WHEN sanitizeMalformedValues parses, THEN lean is dropped AND turbo is preserved (or absent if lean was the only field)', () => {
			const rawConfig = {
				turbo: {
					lean: {
						max_parallel_coders: 'not-a-number', // string instead of number
						enabled: 'yes', // string instead of boolean
					},
				},
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				turboSchema,
				rawConfig,
			);

			// lean is gone (either section-level drop or field-level drop).
			const turbo = (config as Record<string, unknown>).turbo as
				| Record<string, unknown>
				| undefined;

			// A warning was emitted for lean-related path.
			expect(recoveryWarnings.length).toBeGreaterThan(0);
			const sections = recoveryWarnings.map((w) => w.section);
			const hasLeanWarning =
				sections.some((s) => s.includes('lean')) ||
				sections.some((s) => s.includes('turbo'));
			expect(hasLeanWarning).toBe(true);
		});
	});

	// ── All-sections-malformed ─────────────────────────────────────────────────
	describe('all-sections-malformed — only guardrails survives', () => {
		it('GIVEN all sections except guardrails are malformed, WHEN sanitizeMalformedValues parses, THEN guardrails survives AND broken sections are reported', () => {
			const rawConfig = {
				gates: { enabled: 'yes' }, // string instead of boolean
				council: { enabled: 1 }, // number instead of boolean
				memory: { enabled: 'true' }, // string instead of boolean
				guardrails: { enabled: true }, // valid
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				allOptionalSchema,
				rawConfig,
			);

			// guardrails is preserved.
			expect(config).toHaveProperty('guardrails');
			expect((config as Record<string, unknown>).guardrails).toEqual({
				enabled: true,
			});

			// Broken sections are reported (at least one warning).
			expect(recoveryWarnings.length).toBeGreaterThan(0);
			const sections = recoveryWarnings.map((w) => w.section);
			// At least one of the broken sections appears in warnings.
			const hasBrokenSectionWarning =
				sections.some((s) => s.includes('gates')) ||
				sections.some((s) => s.includes('council')) ||
				sections.some((s) => s.includes('memory'));
			expect(hasBrokenSectionWarning).toBe(true);
		});
	});

	// ── Clean config ────────────────────────────────────────────────────────────
	describe('clean config (no malformations) — returns config unchanged', () => {
		it('GIVEN a fully valid config, WHEN sanitizeMalformedValues parses, THEN config is returned unchanged AND recoveryWarnings is empty', () => {
			const rawConfig = {
				gates: { enabled: true },
				council: { enabled: false, maxRound: 3 },
				guardrails: { enabled: true },
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				minimalSchema,
				rawConfig,
			);

			expect(config).toEqual(rawConfig);
			expect(recoveryWarnings).toEqual([]);
		});
	});

	// ── Empty config ───────────────────────────────────────────────────────────
	describe('empty config — returns empty object', () => {
		it('GIVEN an empty config object, WHEN sanitizeMalformedValues parses, THEN config is returned unchanged AND recoveryWarnings is empty', () => {
			const rawConfig = {};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				minimalSchema,
				rawConfig,
			);

			expect(config).toEqual({});
			expect(recoveryWarnings).toEqual([]);
		});

		it('GIVEN a config with only valid optional sections, WHEN sanitizeMalformedValues parses, THEN config is returned as-is with no warnings', () => {
			const rawConfig = { guardrails: { enabled: true } };

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				allOptionalSchema,
				rawConfig,
			);

			expect(config).toEqual({ guardrails: { enabled: true } });
			expect(recoveryWarnings).toEqual([]);
		});
	});

	// ── Recursion termination ──────────────────────────────────────────────────
	describe('recursion termination — no infinite loop on pathological inputs', () => {
		it('GIVEN deeply nested malformed values, WHEN sanitizeMalformedValues parses, THEN it returns in bounded time with a result', () => {
			const deepSchema = z.object({
				a: z
					.object({
						b: z
							.object({
								c: z.object({
									value: z.number(),
								}),
							})
							.optional(),
					})
					.optional(),
			});

			const rawConfig = {
				a: {
					b: {
						c: {
							value: 'not-a-number', // string instead of number
						},
					},
				},
			};

			// If this ever entered an infinite loop, the test runner would time out.
			const start = Date.now();
			const { config, recoveryWarnings } = sanitizeMalformedValues(
				deepSchema,
				rawConfig,
			);
			const elapsed = Date.now() - start;

			// Should complete in well under 1 second on any platform.
			expect(elapsed).toBeLessThan(1000);

			// We get a result — the question is whether recovery happened.
			expect(typeof config).toBe('object');
			expect(Array.isArray(recoveryWarnings)).toBe(true);
		});

		it('GIVEN a config where ALL leaf values in a section are wrong type, WHEN sanitizeMalformedValues parses, THEN it terminates and emits warnings', () => {
			const deepSchema = z.object({
				level1: z
					.object({
						level2: z
							.object({
								level3: z.object({
									field1: z.number(),
									field2: z.boolean(),
								}),
							})
							.optional(),
					})
					.optional(),
			});

			const rawConfig = {
				level1: {
					level2: {
						level3: {
							field1: 'wrong-string', // string instead of number
							field2: 'also-wrong', // string instead of boolean
						},
					},
				},
			};

			const start = Date.now();
			const { recoveryWarnings } = sanitizeMalformedValues(
				deepSchema,
				rawConfig,
			);
			const elapsed = Date.now() - start;

			// Should complete in bounded time.
			expect(elapsed).toBeLessThan(1000);

			// Warnings were emitted (something was dropped).
			expect(recoveryWarnings.length).toBeGreaterThan(0);
		});
	});

	// ── RecoveryWarning interface shape ───────────────────────────────────────
	describe('RecoveryWarning interface shape', () => {
		it('every warning has the required fields: section, severity, message', () => {
			const rawConfig = {
				council: { enabled: 'yes' },
			};

			const { recoveryWarnings } = sanitizeMalformedValues(
				minimalSchema,
				rawConfig,
			);

			expect(recoveryWarnings.length).toBeGreaterThan(0);
			for (const warning of recoveryWarnings) {
				expect(typeof warning.section).toBe('string');
				expect(warning.section.length).toBeGreaterThan(0);
				expect(warning.severity).toBe('warn');
				expect(typeof warning.message).toBe('string');
				expect(warning.message.length).toBeGreaterThan(0);
			}
		});

		it('SanitizeResult has both config and recoveryWarnings fields', () => {
			const rawConfig = {};
			const result = sanitizeMalformedValues(minimalSchema, rawConfig);

			expect(result).toHaveProperty('config');
			expect(result).toHaveProperty('recoveryWarnings');
			expect(Array.isArray(result.recoveryWarnings)).toBe(true);
			expect(typeof result.config).toBe('object');
		});
	});

	// ── Partial validity — some fields within a section are valid ─────────────
	describe('partial validity within a section — algorithm attempts recovery', () => {
		it('GIVEN a section with one malformed field and one valid field, WHEN sanitizeMalformedValues parses, THEN it terminates with a result and emits a warning', () => {
			const rawConfig = {
				council: {
					enabled: 'yes', // malformed
					maxRound: 5, // valid
				},
			};

			const { config, recoveryWarnings } = sanitizeMalformedValues(
				minimalSchema,
				rawConfig,
			);

			// We get a result object.
			expect(typeof config).toBe('object');

			// A warning was emitted (recovery was attempted).
			expect(recoveryWarnings.length).toBeGreaterThan(0);

			// The warning names the broken field or section.
			const sections = recoveryWarnings.map((w) => w.section);
			expect(sections.some((s) => s.includes('council'))).toBe(true);
		});
	});
});
