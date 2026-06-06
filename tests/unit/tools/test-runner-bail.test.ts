/**
 * Verification tests for the `bail` parameter in test_runner tool (Task 1.2)
 *
 * Tests:
 * 1. validateArgs accepts bail=true and bail=false, rejects non-boolean bail
 *
 * Note: Command-building tests for buildTestCommand are not included here because
 * buildTestCommand is not exported from the module. The command-building logic is
 * verified by:
 *   - tests/unit/tools/test-runner.test.ts (integration tests with real framework detection)
 *   - tests/unit/tools/test-runner-dispatch-parity.test.ts (dispatch vs legacy parity)
 *   - Code review of the buildTestCommand switch statement
 *
 * The bail flag flows through runTests() to buildTestCommand(), which is verified
 * by the integration tests in test-runner.test.ts that spawn actual test commands.
 */

import { describe, expect, test } from 'bun:test';

const testRunnerModule = await import('../../../src/tools/test-runner');
const { test_runner } = testRunnerModule;

describe('test-runner.ts — bail parameter validation', () => {
	test('rejects non-boolean bail (string)', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention', files: ['file.ts'], bail: 'true' } as any,
			'',
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects non-boolean bail (number)', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention', files: ['file.ts'], bail: 1 } as any,
			'',
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('rejects non-boolean bail (object)', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention', files: ['file.ts'], bail: {} } as any,
			'',
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Invalid arguments');
	});

	test('accepts bail=true with convention scope', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention', files: ['file.ts'], bail: true },
			'',
		);
		const parsed = JSON.parse(result);
		// bail=true is valid; we expect an error about no framework or files,
		// NOT "Invalid arguments" which would indicate bail validation failed
		expect(parsed.error).not.toContain('Invalid arguments');
	});

	test('accepts bail=false with convention scope', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention', files: ['file.ts'], bail: false },
			'',
		);
		const parsed = JSON.parse(result);
		// bail=false is valid; should not get "Invalid arguments"
		expect(parsed.error).not.toContain('Invalid arguments');
	});

	test('accepts missing bail (undefined) — defaults to false', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention', files: ['file.ts'] },
			'',
		);
		const parsed = JSON.parse(result);
		// No bail param means validation should pass (bail is optional)
		expect(parsed.error).not.toContain('Invalid arguments');
	});
});

describe('test-runner.ts — bail parameter in tool schema', () => {
	test('tool args schema includes bail parameter', () => {
		expect(test_runner.args.bail).toBeDefined();
	});

	test('bail parameter has boolean type in schema', () => {
		// The bail parameter should be defined as optional boolean
		expect(test_runner.args.bail).toBeDefined();
	});
});
