import { describe, expect, test } from 'bun:test';
import { save_plan } from '../../../src/tools/save-plan';
import {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	test_runner,
} from '../../../src/tools/test-runner';

/**
 * Issue #2493 obligation 7 — tool-contract honesty. A `.describe()` string that
 * advertises a default must be enforced by the zod schema (or must stop claiming
 * it). These tests pin both directions for the two tools the issue names.
 */
describe('tool-contract defaults (issue #2493)', () => {
	describe('test_runner timeout_ms — advertised default is enforced', () => {
		test('omitted timeout_ms parses to DEFAULT_TIMEOUT_MS', () => {
			expect(test_runner.args.timeout_ms.parse(undefined)).toBe(
				DEFAULT_TIMEOUT_MS,
			);
		});

		test('explicit timeout_ms passes through unchanged', () => {
			expect(test_runner.args.timeout_ms.parse(1500)).toBe(1500);
			expect(test_runner.args.timeout_ms.parse(MAX_TIMEOUT_MS)).toBe(
				MAX_TIMEOUT_MS,
			);
		});

		test('zero and negative timeout_ms are rejected at the schema layer', () => {
			// Previously `timeout_ms: 0` was silently coerced to 60000 by the
			// `|| DEFAULT_TIMEOUT_MS` fallback; the schema now rejects it so the
			// advertised default is the only defaulting path.
			expect(test_runner.args.timeout_ms.safeParse(0).success).toBe(false);
			expect(test_runner.args.timeout_ms.safeParse(-1).success).toBe(false);
		});

		test('fractional timeout_ms is rejected (integer milliseconds)', () => {
			expect(test_runner.args.timeout_ms.safeParse(100.5).success).toBe(false);
		});

		test('describe still advertises the enforced default and the clamped max', () => {
			const description = (
				test_runner.args.timeout_ms as unknown as {
					description?: string;
				}
			).description;
			expect(description).toContain('default 60000');
			expect(description).toContain('max 300000');
		});
	});

	describe('save_plan task size — describe is truthful about inheritance', () => {
		// A zod `.default('small')` here would break revision semantics: on
		// revision an omitted size must inherit the EXISTING task's size
		// (executeSavePlan fallback `task.size ?? existingTask?.size ??
		// 'small'`, src/tools/save-plan.ts), not be reset to small at parse
		// time. The honest fix is the describe text, so we pin both halves.
		// (save_plan.args is a plain record of field schemas, not a z.object.)
		const sizeField = (
			save_plan.args as unknown as {
				phases: {
					element: {
						shape: {
							tasks: {
								element: {
									shape: {
										size: {
											description?: string;
											safeParse: (v: unknown) => {
												success: boolean;
												data?: unknown;
											};
										};
									};
								};
							};
						};
					};
				};
			}
		).phases.element.shape.tasks.element.shape.size;

		test('size stays optional at the field layer (omitted → undefined)', () => {
			const result = sizeField.safeParse(undefined);
			expect(result.success).toBe(true);
			expect(result.data).toBeUndefined();
		});

		test('explicit size still validates against the enum', () => {
			expect(sizeField.safeParse('medium').success).toBe(true);
			expect(sizeField.safeParse('enormous').success).toBe(false);
		});

		test('describe no longer claims an unenforced default', () => {
			expect(sizeField.description).toBeDefined();
			expect(sizeField.description).not.toContain('(default: small)');
			expect(sizeField.description).toContain('existing task keeps its size');
		});
	});
});
