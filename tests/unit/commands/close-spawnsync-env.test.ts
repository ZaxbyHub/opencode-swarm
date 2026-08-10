/**
 * Verification tests for SC-127: mergeEnvForChild env-merge behavior.
 *
 * Originally these tested the behavior indirectly through close.ts's
 * `_internals.spawnSync` wrapper. Issue #2030 removed that wrapper (the only
 * caller was the deleted `copySqliteSafe`, which shelled out to the external
 * `sqlite3` CLI — an external dependency the issue eliminates). The env-merge
 * logic itself still lives in `src/utils/bun-compat.ts` and is consumed by
 * other spawn sites, so its contract is tested here directly against the real
 * function rather than through a now-removed wrapper.
 *
 * Tests that mergeEnvForChild correctly handles:
 * 1. envOverrides sets a value in the child
 * 2. envOverrides: null deletes an inherited var
 * 3. env: {} (explicit empty) excludes parent env — regression test from Task 2.1
 * 4. no env and no envOverrides inherits parent env
 * 5. process.env is NOT mutated after the call
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mergeEnvForChild } from '../../../src/utils/bun-compat.js';

describe('mergeEnvForChild env-merge behavior (SC-127)', () => {
	const keysToClean: string[] = [];

	afterEach(() => {
		for (const key of keysToClean) {
			delete process.env[key];
		}
		keysToClean.length = 0;
	});

	// SC-127.1: envOverrides sets a value in the child
	it('envOverrides sets a value in child env', () => {
		const key = 'CLOSE_ENV_SET';
		keysToClean.push(key);
		const merged = mergeEnvForChild(undefined, { [key]: 'override_value' });
		expect(merged?.[key]).toBe('override_value');
	});

	// SC-127.2: envOverrides: null deletes an inherited var
	it('envOverrides: null deletes an inherited var from child env', () => {
		const key = 'CLOSE_ENV_DELETE';
		keysToClean.push(key);
		process.env[key] = 'parent_value';
		const merged = mergeEnvForChild(undefined, { [key]: null });
		expect(merged?.[key]).toBeUndefined();
	});

	// SC-127.3: explicit env: {} excludes parent env — regression test
	it('explicit env: {} excludes parent env', () => {
		const key = 'CLOSE_ENV_EXPLICIT_EMPTY';
		keysToClean.push(key);
		process.env[key] = 'parent_value';
		// Caller explicitly provides an empty base env: the result must NOT
		// inherit the parent's env.
		const merged = mergeEnvForChild({}, undefined);
		expect(merged).toBeDefined();
		expect(merged?.[key]).toBeUndefined();
	});

	// SC-127.4: no env and no envOverrides inherits parent env
	it('no env and no envOverrides inherits parent env', () => {
		const key = 'CLOSE_ENV_INHERIT';
		keysToClean.push(key);
		process.env[key] = 'parent_value';
		const merged = mergeEnvForChild(undefined, undefined);
		expect(merged?.[key]).toBe('parent_value');
	});

	// SC-127.5: process.env is NOT mutated
	it('process.env is NOT mutated after the call', () => {
		const key = 'CLOSE_ENV_NO_MUTATION';
		keysToClean.push(key);
		process.env[key] = 'original_value';
		mergeEnvForChild(undefined, { [key]: 'after' });
		expect(process.env[key]).toBe('original_value');
	});

	// SC-127.6: explicit empty env with override applies the override
	it('explicit env: {} + envOverrides applies override without inheriting parent', () => {
		const parentKey = 'CLOSE_ENV_EXPlicit_PARENT';
		const overrideKey = 'CLOSE_ENV_EXPLICIT_OVERRIDE';
		keysToClean.push(parentKey, overrideKey);
		process.env[parentKey] = 'parent_value';
		const merged = mergeEnvForChild({}, { [overrideKey]: 'set' });
		expect(merged).toBeDefined();
		// Override applied.
		expect(merged?.[overrideKey]).toBe('set');
		// Parent env NOT inherited because caller passed an explicit base env.
		expect(merged?.[parentKey]).toBeUndefined();
	});
});
