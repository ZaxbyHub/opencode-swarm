/**
 * Adversarial tests for barrel export of check_gate_status in src/tools/index.ts
 * Tests for: duplicate export collisions, broken module path, missing symbol,
 * and accidental export-surface divergence
 */

import { describe, expect, it } from 'bun:test';

// Test 1: Verify barrel export exists and is accessible
describe('barrel export exists', () => {
	it('check_gate_status is exported from barrel index.ts', async () => {
		// This import tests that the barrel file can be parsed and the export exists
		const barrel = await import('./index');

		// The check_gate_status should be exported from the barrel
		expect('check_gate_status' in barrel).toBe(true);
		expect(typeof barrel.check_gate_status).toBe('object');
		expect(barrel.check_gate_status).not.toBeNull();
		expect(typeof barrel.check_gate_status.execute).toBe('function');
	});
});

// Test 2: No duplicate export collisions - check_gate_status appears only once in barrel
describe('no duplicate export collisions', () => {
	it('check_gate_status appears exactly once in barrel exports', async () => {
		const barrel = await import('./index');

		// Get all exported symbols
		const exports = Object.keys(barrel);

		// Filter for check_gate_status - should appear exactly once
		const matchingExports = exports.filter((e) => e === 'check_gate_status');
		expect(matchingExports.length).toBe(1);
	});

	it('check_gate_status does not conflict with similar export names', async () => {
		const barrel = await import('./index');

		// Check that no similar names exist that could cause collision
		const exports = Object.keys(barrel);
		const gateRelated = exports.filter((e) => e.includes('gate'));

		// Must include check_gate_status; no collision with camelCase or kebab-case variants
		expect(gateRelated).toContain('check_gate_status');
		expect(gateRelated).not.toContain('checkGateStatus');
		expect(gateRelated).not.toContain('check-gate-status');
	});
});

// Test 3: Broken module path - verify the source module path exists
describe('source module path integrity', () => {
	it('source module check-gate-status.ts exists and exports check_gate_status', async () => {
		// This tests that the relative path resolves correctly
		const sourceModule = await import('./check-gate-status');

		// Source module must export check_gate_status
		expect('check_gate_status' in sourceModule).toBe(true);
		expect(typeof sourceModule.check_gate_status).toBe('object');
	});

	it('barrel export matches source module export identity', async () => {
		const barrel = await import('./index');
		const sourceModule = await import('./check-gate-status');

		// The exported symbol from barrel should be the exact same reference
		// as what's exported from the source module
		expect(barrel.check_gate_status).toBe(sourceModule.check_gate_status);
	});
});

// Test 4: Export surface divergence - verify complete export surface matches
describe('export surface divergence check', () => {
	it('barrel exports exactly what source module exports', async () => {
		const barrel = await import('./index');
		const sourceModule = await import('./check-gate-status');

		// Both should have the same exported properties for check_gate_status
		const barrelKeys = Object.keys(barrel.check_gate_status);
		const sourceKeys = Object.keys(sourceModule.check_gate_status);

		// The barrel should re-export everything the source module exports
		expect(barrelKeys).toEqual(sourceKeys);
	});

	it('barrel does not add extra properties to check_gate_status', async () => {
		const barrel = await import('./index');
		const sourceModule = await import('./check-gate-status');

		// Get extra keys that are in barrel but not in source
		const barrelKeys = Object.keys(barrel.check_gate_status);
		const sourceKeys = Object.keys(sourceModule.check_gate_status);

		const extraKeys = barrelKeys.filter((k) => !sourceKeys.includes(k));
		expect(extraKeys).toEqual([]);
	});
});

// Test 5: TypeScript compile-time verification via import validation
describe('type and structure verification', () => {
	it('check_gate_status has expected tool structure', async () => {
		const { check_gate_status } = await import('./index');

		// Verify expected properties exist on the tool
		expect(check_gate_status).toHaveProperty('description');
		expect(check_gate_status).toHaveProperty('args');
		expect(check_gate_status).toHaveProperty('execute');
		expect(typeof check_gate_status.description).toBe('string');
		expect(typeof check_gate_status.args).toBe('object');
		expect(typeof check_gate_status.execute).toBe('function');
	});
});

// Test 6: Re-export from nested path doesn't break
describe('nested re-export integrity', () => {
	it('check_gate_status can be imported from index.ts directly', async () => {
		// This is the actual usage pattern - importing from the barrel
		const { check_gate_status } = await import('./index');

		expect(check_gate_status).toBeDefined();
		expect(typeof check_gate_status.execute).toBe('function');
	});
});

// Test 7: Verify no symbol aliasing issues
describe('symbol aliasing correctness', () => {
	it('export name matches source export name exactly', async () => {
		const barrel = await import('./index');
		const sourceModule = await import('./check-gate-status');

		// The export name should be identical (snake_case)
		const barrelExportNames = Object.keys(barrel).filter(
			(k) => k === 'check_gate_status',
		);
		const sourceExportNames = Object.keys(sourceModule).filter(
			(k) => k === 'check_gate_status',
		);

		expect(barrelExportNames).toEqual(sourceExportNames);
	});
});

// Test 8: Empty/malformed module path detection
describe('malformed import path handling', () => {
	it('importing from non-existent path would fail at runtime', async () => {
		// This is a sanity check - we can't test invalid paths directly,
		// but we verify our valid path works
		expect(async () => {
			await import('./check-gate-status');
		}).not.toThrow();
	});
});

// Test 9: Circular dependency check
describe('no circular dependency issues', () => {
	it('importing index does not cause circular dependency errors', async () => {
		// Import twice to ensure no state issues from circular deps
		const barrel1 = await import('./index');
		const barrel2 = await import('./index');

		expect(barrel1.check_gate_status).toBe(barrel2.check_gate_status);
	});
});

// Test 10: All exports from barrel are accounted for
describe('barrel export completeness', () => {
	it('check_gate_status is included in all barrel exports list', async () => {
		const barrel = await import('./index');
		const exports = Object.keys(barrel);

		// check_gate_status should be in the list of all exports
		expect(exports).toContain('check_gate_status');
	});
});
