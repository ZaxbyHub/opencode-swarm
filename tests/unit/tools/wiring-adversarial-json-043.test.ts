/**
 * WIRE-043, relocated from tests/unit/tools/wiring-adversarial.test.ts
 * (FR-006 over-cap net-shrink): the imports tool's response must be
 * JSON-serializable and free of prototype-pollution keys. Identical
 * assertions to the original.
 */
import { describe, expect, test } from 'bun:test';

describe('Phase 3.1 wiring - TOOL OBJECT STRUCTURE (relocated WIRE-043)', () => {
	test('WIRE-043: imports response is JSON-serializable without prototypes', async () => {
		const { imports } = await import('../../../src/tools/index');

		const result = await imports.execute(
			{ file: '/nonexistent.ts' } as any,
			{} as any,
		);

		// Should be valid JSON
		const parsed = JSON.parse(result);

		// Serialized form should not contain prototype properties
		const serialized = JSON.stringify(parsed);
		expect(serialized).not.toContain('__proto__');
		expect(serialized).not.toContain('constructor');
		expect(serialized).not.toContain('prototype');
		expect(serialized).not.toContain('__proto__');
	});
});
