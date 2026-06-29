/**
 * Verification tests for check_gate_status export from src/tools/index.ts
 *
 * Tests:
 * 1. check_gate_status is exported exactly once from src/tools/index.ts
 * 2. The export is consumable (importable) by plugin registration code
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Test 1: Verify the export appears exactly once in the source
describe('check_gate_status export surface', () => {
	it('should be exported exactly once from src/tools/index.ts', async () => {
		// Read the source file to verify the export appears exactly once
		const indexPath = path.join(process.cwd(), 'src', 'tools', 'index.ts');
		const content = fs.readFileSync(indexPath, 'utf-8');

		// Count occurrences of check_gate_status export
		// Should match: export { check_gate_status } from './check-gate-status';
		const exportMatches = content.match(/export\s*{\s*check_gate_status\s*}/g);

		expect(exportMatches).not.toBeNull();
		expect(exportMatches?.length).toBe(1);
	});

	it('should export from the correct module path', async () => {
		const indexPath = path.join(process.cwd(), 'src', 'tools', 'index.ts');
		const content = fs.readFileSync(indexPath, 'utf-8');

		// Verify it exports from './check-gate-status'
		const exportLineRegex =
			/export\s*{\s*check_gate_status\s*}\s*from\s*['"]\.\/check-gate-status['"]/;
		expect(exportLineRegex.test(content)).toBe(true);
	});
});

// Test 2: Verify the export is consumable by plugin registration code
describe('check_gate_status consumability', () => {
	it('should be importable from src/tools/index', async () => {
		// This verifies the export is consumable - can be imported
		const toolsIndex = await import('../../../src/tools/index');

		// Check that check_gate_status exists as an export
		expect('check_gate_status' in toolsIndex).toBe(true);
	});

	it('should be a valid tool function (has execute and description)', async () => {
		const { check_gate_status } = await import('../../../src/tools/index');

		// Verify it's a valid tool definition with expected properties
		expect(check_gate_status).toBeDefined();
		expect(typeof check_gate_status).toBe('object');

		// Check it's a tool with description and execute
		expect(check_gate_status).toHaveProperty('description');
		expect(check_gate_status).toHaveProperty('execute');
		expect(typeof check_gate_status.execute).toBe('function');
	});

	it('should have correct description text', async () => {
		const { check_gate_status } = await import('../../../src/tools/index');

		expect(check_gate_status.description).toBeDefined();
		expect(typeof check_gate_status.description).toBe('string');
		expect(check_gate_status.description).toContain('gate status');
	});
});

// Test 3: Verify the source module also exports it correctly
describe('check_gate_status source module', () => {
	it('should be defined in check-gate-status.ts', async () => {
		const checkGateStatus = await import(
			'../../../src/tools/check-gate-status'
		);

		// The source should export check_gate_status
		expect('check_gate_status' in checkGateStatus).toBe(true);
	});

	it('should export a tool with task_id argument schema', async () => {
		const { check_gate_status } = await import(
			'../../../src/tools/check-gate-status'
		);

		// The tool should have args with task_id defined
		expect(check_gate_status.args).toBeDefined();
		expect(check_gate_status.args).toHaveProperty('task_id');
	});
});
