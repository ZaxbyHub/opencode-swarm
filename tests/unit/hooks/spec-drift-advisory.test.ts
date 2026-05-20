/**
 * Tests for the spec-drift system-prompt advisory (issue #853 Layer A).
 *
 * Covers:
 *   - buildSpecDriftAdvisory output shape and content
 *   - architect.ts section 6k contains the literal strings asserted by the
 *     test (removed_task_ids, SPEC_DRIFT_BLOCKED_TOOLS, SPEC_DRIFT_BLOCK)
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SPEC_DRIFT_BLOCKED_TOOLS } from '../../../src/hooks/guardrails';
import { buildSpecDriftAdvisory } from '../../../src/hooks/system-enhancer';

describe('buildSpecDriftAdvisory', () => {
	test('contains header, hashes, surface-to-user instruction, and recovery commands', () => {
		const text = buildSpecDriftAdvisory({
			reason: 'spec.md changed',
			currentHash: 'abc123',
			storedHash: 'def456',
		});
		expect(text).toContain('[spec-drift]');
		expect(text).toContain('Stored spec hash: def456');
		expect(text).toContain('Current spec hash: abc123');
		expect(text).toContain('surface this warning to the user');
		expect(text).toContain('/swarm clarify');
		expect(text).toContain('/swarm acknowledge-spec-drift');
	});

	test('renders "(spec.md missing)" when currentHash is null', () => {
		const text = buildSpecDriftAdvisory({
			reason: 'spec.md missing',
			currentHash: null,
			storedHash: 'def456',
		});
		expect(text).toContain('Current spec hash: (spec.md missing)');
	});

	test('appends mid-load removal disclosure when present', () => {
		const text = buildSpecDriftAdvisory({
			reason: 'spec.md changed',
			currentHash: 'abc123',
			storedHash: 'def456',
			midLoadRemovals: {
				count: 3,
				source: 'load_plan_rebuild_from_ledger',
			},
		});
		expect(text).toContain('Auto-removed during recovery: 3 task(s)');
		expect(text).toContain('source: load_plan_rebuild_from_ledger');
		expect(text).toContain('.swarm/plan-ledger.jsonl');
	});

	test('omits mid-load disclosure when not present', () => {
		const text = buildSpecDriftAdvisory({
			reason: 'spec.md changed',
			currentHash: 'abc123',
			storedHash: 'def456',
		});
		expect(text).not.toContain('Auto-removed during recovery');
	});

	test('lists every SPEC_DRIFT_BLOCKED_TOOLS entry in the "Do NOT proceed" line', () => {
		const text = buildSpecDriftAdvisory({
			reason: 'spec.md changed',
			currentHash: 'abc123',
			storedHash: 'def456',
		});
		for (const tool of SPEC_DRIFT_BLOCKED_TOOLS) {
			expect(text).toContain(tool);
		}
	});
});

describe('architect.ts section 6k prompt', () => {
	test('contains removed_task_ids, SPEC_DRIFT_BLOCKED_TOOLS, and SPEC_DRIFT_BLOCK', () => {
		const architectPath = path.resolve(
			__dirname,
			'..',
			'..',
			'..',
			'src',
			'agents',
			'architect.ts',
		);
		const txt = fs.readFileSync(architectPath, 'utf-8');
		const startIdx = txt.indexOf('6k. SPEC-STALENESS GUARD:');
		expect(startIdx).toBeGreaterThan(-1);
		const endIdx = txt.indexOf('### MODE: EXECUTE', startIdx);
		expect(endIdx).toBeGreaterThan(startIdx);
		const section = txt.slice(startIdx, endIdx);
		expect(section).toContain('removed_task_ids');
		expect(section).toContain('SPEC_DRIFT_BLOCKED_TOOLS');
		expect(section).toContain('SPEC_DRIFT_BLOCK');
	});
});
