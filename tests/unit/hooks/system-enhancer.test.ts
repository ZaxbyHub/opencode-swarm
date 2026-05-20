import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { ContextBudgetConfigSchema } from '../../../src/config/schema';
import { extractCurrentPhase } from '../../../src/hooks/extractors';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../../src/state';

describe('System Enhancer Hook', () => {
	describe('extractCurrentPhase', () => {
		it('returns null for empty string', () => {
			const result = extractCurrentPhase('');
			expect(result).toBeNull();
		});

		it('returns null for falsy input (empty string)', () => {
			const result = extractCurrentPhase('');
			expect(result).toBeNull();
		});

		it('parses ## Phase 1: Hooks Pipeline Enhancement [IN PROGRESS] correctly', () => {
			const planContent = `
# Project Plan

## Phase 1: Hooks Pipeline Enhancement [IN PROGRESS]

This phase focuses on implementing the hooks pipeline.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBe('Phase 1: Hooks Pipeline Enhancement [IN PROGRESS]');
		});

		it('parses ## Phase 2: Context Pruning [IN PROGRESS] correctly', () => {
			const planContent = `
# Project Plan

## Phase 2: Context Pruning [IN PROGRESS]

This phase focuses on context pruning.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBe('Phase 2: Context Pruning [IN PROGRESS]');
		});

		it('ignores ## Phase 1 [COMPLETE] phases (not IN PROGRESS)', () => {
			const planContent = `
# Project Plan

## Phase 1 [COMPLETE]

This phase is done.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBeNull();
		});

		it('ignores ## Phase 3 [PENDING] phases', () => {
			const planContent = `
# Project Plan

## Phase 3 [PENDING]

This phase is pending.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBeNull();
		});

		it('handles case insensitive [in progress]', () => {
			const planContent = `
# Project Plan

## Phase 1: Feature Implementation [in progress]

This phase is working.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBe('Phase 1: Feature Implementation [IN PROGRESS]');
		});

		it('falls back to header Phase: 2 [PENDING] from first 3 lines', () => {
			const planContent = `Phase: 2
# Project Plan

Some content here.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBe('Phase 2 [PENDING]');
		});

		it('returns null when no phase info at all', () => {
			const planContent = `
# Project Plan

Some content without phase info.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBeNull();
		});

		it('handles phase without colon', () => {
			const planContent = `
# Project Plan

## Phase 1 Hooks Pipeline Enhancement [IN PROGRESS]

This phase is working.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBe('Phase 1: Hooks Pipeline Enhancement [IN PROGRESS]');
		});

		it('only searches first 20 lines for ## headers', () => {
			const lines: string[] = [];
			// Create content with IN PROGRESS phase on line 25 (beyond the 20 line limit)
			for (let i = 1; i <= 24; i++) {
				lines.push(`Line ${i}`);
			}
			lines.push('## Phase 5: Late Phase [IN PROGRESS]');
			const planContent = lines.join('\n');

			const result = extractCurrentPhase(planContent);
			expect(result).toBeNull();
		});

		it('header fallback works when phase is in first 3 lines', () => {
			const planContent = `Phase: 7
Some header info
More header info`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBe('Phase 7 [PENDING]');
		});

		it('prefers IN PROGRESS match over header fallback', () => {
			const planContent = `Phase: 3
# Project Plan

## Phase 2: Actual Implementation [IN PROGRESS]

This should return the IN PROGRESS phase.
`;
			const result = extractCurrentPhase(planContent);
			expect(result).toBe('Phase 2: Actual Implementation [IN PROGRESS]');
		});
	});
});
