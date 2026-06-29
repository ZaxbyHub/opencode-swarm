import { describe, expect, it } from 'bun:test';
import {
	type LoadEvidenceResult,
	loadEvidence,
} from '../../../src/evidence/index.js';

describe('LoadEvidenceResult export', () => {
	it('should be importable from the barrel path', () => {
		// Type-only import test - this line validates the type can be imported
		// If this compiles, the export is working correctly
		const _typeCheck: LoadEvidenceResult | undefined = undefined;
		expect(_typeCheck).toBeUndefined();
	});

	it('should return not_found status for non-existent task', async () => {
		const result = await loadEvidence('.', 'nonexistent-9999');
		expect(result.status).toBe('not_found');
	});
});
