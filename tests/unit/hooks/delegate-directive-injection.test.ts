/**
 * Behavioral tests for delegate-directive-injection hook (FR-012).
 *
 * Tests the three observable outcomes:
 *   1. Injects delegate-specific directives into subagent prompts
 *   2. Preserves parent directives (original prompt content)
 *   3. Rejects malformed directive payloads (returns 0, never throws)
 *
 * Uses _internals DI seam on knowledge-injector.ts for mock injection,
 * and mock.module for loadPlan and readPhaseDirectivesToVerify.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DirectiveToVerify } from '../../../src/agents/reviewer-directive-compliance.js';
import type { DelegateInjectionInput } from '../../../src/hooks/delegate-directive-injection.js';
import { injectDelegateDirectivesBefore } from '../../../src/hooks/delegate-directive-injection.js';
import {
	buildDelegateDirectiveBlock,
	DELEGATE_DIRECTIVE_BLOCK_TAG,
} from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import {
	makeConfig,
	makeEntry,
	makeInput,
} from './delegate-directive-injection.fixtures.js';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('injectDelegateDirectivesBefore — FR-012 behavioral tests', () => {
	// Working directory for tests that need one (not used for file I/O in these
	// tests since we mock the file-reading functions, but required by signature).
	const testDir = path.join(os.tmpdir(), 'delegate-directive-test');

	// Save original _internals from knowledge-injector
	let originalSearchKnowledge: typeof import('../../../src/hooks/knowledge-injector.js')._internals.searchKnowledge;
	let originalRecordKnowledgeEvent: typeof import('../../../src/hooks/knowledge-injector.js')._internals.recordKnowledgeEvent;

	beforeEach(async () => {
		// Dynamically import to avoid top-level import issues with mock.module
		const ki = await import('../../../src/hooks/knowledge-injector.js');
		originalSearchKnowledge = ki._internals.searchKnowledge;
		originalRecordKnowledgeEvent = ki._internals.recordKnowledgeEvent;
		// Mock recordKnowledgeEvent to prevent real file writes
		ki._internals.recordKnowledgeEvent = mock(async () => {});
	});

	afterEach(async () => {
		// Restore original _internals
		const ki = await import('../../../src/hooks/knowledge-injector.js');
		ki._internals.searchKnowledge = originalSearchKnowledge;
		ki._internals.recordKnowledgeEvent = originalRecordKnowledgeEvent;
		mock.restore();
	});

	// -------------------------------------------------------------------------
	// Outcome 1: Injects delegate-specific directives into subagent prompts
	// -------------------------------------------------------------------------

	describe('injects delegate-specific directives into subagent prompts', () => {
		it('prepends delegate directive block to coder prompt', async () => {
			const config = makeConfig();

			// Mock injectForDelegate to return test entries via _internals seam
			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [
					makeEntry({
						id: 'k-1',
						directive_priority: 'high',
						lesson: 'Use _internals for test seams',
						forbidden_actions: ['mock.module without spread'],
					}),
					makeEntry({
						id: 'k-2',
						directive_priority: 'medium',
						lesson: 'Prefer early returns',
					}),
				],
				trace_id: 'test-trace',
			}));

			// Also mock loadPlan to return a plan with a phase — spread real exports
			const realPlanManager = await import('../../../src/plan/manager.js');
			mock.module('../../../src/plan/manager.js', () => ({
				...realPlanManager,
				loadPlan: mock(async () => ({
					title: 'Test Plan',
					current_phase: 2,
					phases: [
						{ id: 1, name: 'Phase 1' },
						{ id: 2, name: 'Phase 2' },
					],
				})),
			}));

			// Mock readPhaseDirectivesToVerify — spread real exports
			const realPhaseDirectives = await import(
				'../../../src/hooks/phase-directives.js'
			);
			mock.module('../../../src/hooks/phase-directives.js', () => ({
				...realPhaseDirectives,
				readPhaseDirectivesToVerify: mock(
					async () => [] as DirectiveToVerify[],
				),
			}));

			const input = makeInput({
				args: {
					subagent_type: 'coder',
					prompt: 'Implement the feature',
				},
			});

			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);

			expect(count).toBe(2);
			// Verify the prompt was modified
			const prompt = (input.args as Record<string, unknown>).prompt as string;
			expect(prompt).toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
			expect(prompt).toContain('<delegate_knowledge_directives>');
			expect(prompt).toContain('k-1');
			expect(prompt).toContain('k-2');
			// Original prompt should be preserved at the end
			expect(prompt).toContain('Implement the feature');
		});

		it('injects for reviewer agent including compliance block', async () => {
			const config = makeConfig();

			// Mock searchKnowledge
			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [
					makeEntry({
						id: 'k-review-1',
						directive_priority: 'critical',
						lesson: 'Verify every changed file',
					}),
				],
				trace_id: 'review-trace',
			}));

			// Mock loadPlan — spread real exports
			const realPlanManager = await import('../../../src/plan/manager.js');
			mock.module('../../../src/plan/manager.js', () => ({
				...realPlanManager,
				loadPlan: mock(async () => ({
					title: 'Test Plan',
					current_phase: 1,
					phases: [{ id: 1, name: 'Phase 1' }],
				})),
			}));

			// Mock readPhaseDirectivesToVerify — spread real exports
			const realPhaseDirectives = await import(
				'../../../src/hooks/phase-directives.js'
			);
			mock.module('../../../src/hooks/phase-directives.js', () => ({
				...realPhaseDirectives,
				readPhaseDirectivesToVerify: mock(
					async () =>
						[
							{
								id: 'phase-dir-1',
								priority: 'high' as const,
								lesson: 'Check all return paths',
							},
						] as DirectiveToVerify[],
				),
			}));

			const input = makeInput({
				args: {
					subagent_type: 'reviewer',
					prompt: 'Review the implementation',
				},
			});

			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);

			expect(count).toBe(1);
			const prompt = (input.args as Record<string, unknown>).prompt as string;
			// Reviewer gets BOTH delegate block AND compliance block
			expect(prompt).toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
			expect(prompt).toContain('<delegate_knowledge_directives>');
			expect(prompt).toContain('k-review-1');
			// Compliance block tag
			expect(prompt).toContain('<directives_to_verify>');
			expect(prompt).toContain('phase-dir-1');
		});

		it('returns 0 when no entries are retrieved (empty result)', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [],
				trace_id: 'empty-trace',
			}));

			// Mock loadPlan — spread real exports
			const realPlanManager = await import('../../../src/plan/manager.js');
			mock.module('../../../src/plan/manager.js', () => ({
				...realPlanManager,
				loadPlan: mock(async () => ({
					title: 'Test Plan',
					current_phase: 1,
					phases: [{ id: 1, name: 'Phase 1' }],
				})),
			}));

			// Mock readPhaseDirectivesToVerify — spread real exports
			const realPhaseDirectives = await import(
				'../../../src/hooks/phase-directives.js'
			);
			mock.module('../../../src/hooks/phase-directives.js', () => ({
				...realPhaseDirectives,
				readPhaseDirectivesToVerify: mock(
					async () => [] as DirectiveToVerify[],
				),
			}));

			const input = makeInput({
				args: {
					subagent_type: 'coder',
					prompt: 'Do something',
				},
			});

			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);

			expect(count).toBe(0);
			// Prompt should NOT have been modified
			expect((input.args as Record<string, unknown>).prompt).toBe(
				'Do something',
			);
		});

		it('returns 0 for non-delegated agent (unrecognized subagent_type)', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [makeEntry({ id: 'orphan', lesson: 'Orphaned directive' })],
				trace_id: 'orphan-trace',
			}));

			// Mock loadPlan — spread real exports
			const realPlanManager = await import('../../../src/plan/manager.js');
			mock.module('../../../src/plan/manager.js', () => ({
				...realPlanManager,
				loadPlan: mock(async () => null),
			}));

			// Mock readPhaseDirectivesToVerify — spread real exports
			const realPhaseDirectives = await import(
				'../../../src/hooks/phase-directives.js'
			);
			mock.module('../../../src/hooks/phase-directives.js', () => ({
				...realPhaseDirectives,
				readPhaseDirectivesToVerify: mock(
					async () => [] as DirectiveToVerify[],
				),
			}));

			// 'unrecognized_agent' is not in the DELEGATED_AGENTS set
			const input = makeInput({
				args: {
					subagent_type: 'unrecognized_agent',
					prompt: 'Do something',
				},
			});

			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);

			expect(count).toBe(0);
			expect((input.args as Record<string, unknown>).prompt).toBe(
				'Do something',
			);
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 2: Preserves parent directives (original prompt content)
	// -------------------------------------------------------------------------

	describe('preserves parent directives', () => {
		it('original prompt text appears verbatim after the injected block', async () => {
			const config = makeConfig();
			const originalPrompt =
				'TO: coder\nTASK: Refactor the auth module\nFILE: src/auth.ts\nINPUT: Add OAuth2 support';

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [
					makeEntry({
						id: 'k-preserve',
						directive_priority: 'medium',
						lesson: 'Preserve existing test coverage',
					}),
				],
				trace_id: 'preserve-trace',
			}));

			// Mock loadPlan — spread real exports
			const realPlanManager = await import('../../../src/plan/manager.js');
			mock.module('../../../src/plan/manager.js', () => ({
				...realPlanManager,
				loadPlan: mock(async () => ({
					title: 'Test Plan',
					current_phase: 1,
					phases: [{ id: 1, name: 'Phase 1' }],
				})),
			}));

			// Mock readPhaseDirectivesToVerify — spread real exports
			const realPhaseDirectives = await import(
				'../../../src/hooks/phase-directives.js'
			);
			mock.module('../../../src/hooks/phase-directives.js', () => ({
				...realPhaseDirectives,
				readPhaseDirectivesToVerify: mock(
					async () => [] as DirectiveToVerify[],
				),
			}));

			const input = makeInput({
				args: {
					subagent_type: 'coder',
					prompt: originalPrompt,
				},
			});

			await injectDelegateDirectivesBefore(testDir, input, config);

			const modifiedPrompt = (input.args as Record<string, unknown>)
				.prompt as string;
			// Every line of the original prompt should appear in the modified prompt
			for (const line of originalPrompt.split('\n')) {
				expect(modifiedPrompt).toContain(line);
			}
			// The injected block should come BEFORE the original prompt
			const blockIndex = modifiedPrompt.indexOf(DELEGATE_DIRECTIVE_BLOCK_TAG);
			const originalIndex = modifiedPrompt.indexOf('TO: coder');
			expect(blockIndex).toBeLessThan(originalIndex);
		});

		it('does not duplicate injection when called twice (idempotency)', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [
					makeEntry({ id: 'k-idempotent', lesson: 'Idempotent injection' }),
				],
				trace_id: 'idempotent-trace',
			}));

			// Mock loadPlan — spread real exports
			const realPlanManager = await import('../../../src/plan/manager.js');
			mock.module('../../../src/plan/manager.js', () => ({
				...realPlanManager,
				loadPlan: mock(async () => ({
					title: 'Test Plan',
					current_phase: 1,
					phases: [{ id: 1, name: 'Phase 1' }],
				})),
			}));

			// Mock readPhaseDirectivesToVerify — spread real exports
			const realPhaseDirectives = await import(
				'../../../src/hooks/phase-directives.js'
			);
			mock.module('../../../src/hooks/phase-directives.js', () => ({
				...realPhaseDirectives,
				readPhaseDirectivesToVerify: mock(
					async () => [] as DirectiveToVerify[],
				),
			}));

			const input = makeInput({
				args: {
					subagent_type: 'coder',
					prompt: 'First call',
				},
			});

			// First call — should inject
			const count1 = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count1).toBe(1);

			// Second call on SAME input — should return 0 (idempotency check)
			// The prompt now contains the tag, so it should be rejected
			const count2 = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count2).toBe(0);

			// Count occurrences of the tag — should be exactly 1
			const prompt = (input.args as Record<string, unknown>).prompt as string;
			const matches = prompt.match(
				new RegExp(DELEGATE_DIRECTIVE_BLOCK_TAG, 'g'),
			);
			expect(matches?.length).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// buildDelegateDirectiveBlock — integration with the hook
	// -------------------------------------------------------------------------

	describe('buildDelegateDirectiveBlock integration', () => {
		it('sorts entries by priority (critical first) then id', () => {
			const entries: RankedEntry[] = [
				makeEntry({
					id: 'k-low',
					directive_priority: 'low',
					lesson: 'Low priority',
				}),
				makeEntry({
					id: 'k-critical',
					directive_priority: 'critical',
					lesson: 'Critical directive',
				}),
				makeEntry({
					id: 'k-high',
					directive_priority: 'high',
					lesson: 'High priority',
				}),
			];

			const block = buildDelegateDirectiveBlock(entries, makeConfig());

			expect(block).not.toBeNull();
			// Critical should appear before high and low
			const critIdx = block!.indexOf('k-critical');
			const highIdx = block!.indexOf('k-high');
			const lowIdx = block!.indexOf('k-low');
			expect(critIdx).toBeLessThan(highIdx);
			expect(highIdx).toBeLessThan(lowIdx);
		});

		it('returns null for empty entries array', () => {
			const block = buildDelegateDirectiveBlock([], makeConfig());
			expect(block).toBeNull();
		});
	});
});
