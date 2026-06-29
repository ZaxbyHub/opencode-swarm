/**
 * Edge case and malformed-payload tests for delegate-directive-injection hook (FR-012).
 * Tests outcome 3: Rejects malformed directive payloads (returns 0, never throws).
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
import { DELEGATE_DIRECTIVE_BLOCK_TAG } from '../../../src/hooks/knowledge-injector.js';
import {
	makeConfig,
	makeEntry,
	makeInput,
} from './delegate-directive-injection.fixtures.js';

describe('injectDelegateDirectivesBefore — malformed payload edge cases', () => {
	const testDir = path.join(os.tmpdir(), 'delegate-directive-test');

	// Save original _internals from knowledge-injector
	let originalSearchKnowledge: typeof import('../../../src/hooks/knowledge-injector.js')._internals.searchKnowledge;
	let originalRecordKnowledgeEvent: typeof import('../../../src/hooks/knowledge-injector.js')._internals.recordKnowledgeEvent;

	beforeEach(async () => {
		const ki = await import('../../../src/hooks/knowledge-injector.js');
		originalSearchKnowledge = ki._internals.searchKnowledge;
		originalRecordKnowledgeEvent = ki._internals.recordKnowledgeEvent;
		ki._internals.recordKnowledgeEvent = mock(async () => {});
	});

	afterEach(async () => {
		const ki = await import('../../../src/hooks/knowledge-injector.js');
		ki._internals.searchKnowledge = originalSearchKnowledge;
		ki._internals.recordKnowledgeEvent = originalRecordKnowledgeEvent;
		mock.restore();
	});

	describe('rejects malformed directive payloads', () => {
		it('returns 0 when config.enabled is false', async () => {
			const config = makeConfig({ enabled: false });

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Should not be called');
			});

			const input = makeInput();
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('returns 0 for non-Task tool', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Should not be called');
			});

			const input = makeInput({ tool: 'Edit' });
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('returns 0 when caller agent is not architect', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Should not be called');
			});

			const input = makeInput({ agent: 'mega_coder' });
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('returns 0 when args is not an object', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Should not be called');
			});

			const input = makeInput({ args: null });
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('returns 0 when prompt is not a string', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Should not be called');
			});

			const input = makeInput({
				args: { subagent_type: 'coder', prompt: 123 } as unknown as Record<
					string,
					unknown
				>,
			});
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('returns 0 when subagent_type is missing', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Should not be called');
			});

			const input = makeInput({
				args: { prompt: 'Do something' } as unknown as Record<string, unknown>,
			});
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('returns 0 when prompt already contains DELEGATE_DIRECTIVE_BLOCK_TAG', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Should not be called');
			});

			const input = makeInput({
				args: {
					subagent_type: 'coder',
					prompt: `<delegate_knowledge_directives>\n- id: k-already\n</delegate_knowledge_directives>\n\nTO: coder`,
				},
			});

			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('returns 0 when prompt already contains DIRECTIVES_TO_VERIFY_TAG', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Should not be called');
			});

			const input = makeInput({
				args: {
					subagent_type: 'reviewer',
					prompt: `<directives_to_verify>\n- id: existing\n</directives_to_verify>\n\nTO: reviewer`,
				},
			});

			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('fail-open: continues with undefined phase when loadPlan throws', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [makeEntry({ id: 'k-error', lesson: 'Test' })],
				trace_id: 'error-trace',
			}));

			// Mock loadPlan — spread real exports
			const realPlanManager = await import('../../../src/plan/manager.js');
			mock.module('../../../src/plan/manager.js', () => ({
				...realPlanManager,
				loadPlan: mock(async () => {
					throw new Error('Simulated plan load failure');
				}),
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

			const input = makeInput();
			// Should NOT throw — fail-open behavior. loadPlan rejection is caught and
			// returns null, so phaseLabel becomes undefined but injection still proceeds.
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			// The function still returns 1 because loadPlan failure is caught and
			// the rest of the injection path proceeds with phaseLabel = undefined.
			expect(count).toBe(1);
		});

		it('returns 0 and does not throw when injectForDelegate throws', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => {
				throw new Error('Simulated search failure');
			});

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

			const input = makeInput();
			// Should NOT throw — fail-open behavior
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('handles empty string prompt gracefully', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [],
				trace_id: 'empty-prompt-trace',
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
				args: { subagent_type: 'coder', prompt: '' },
			});

			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});

		it('handles missing sessionID gracefully', async () => {
			const config = makeConfig();

			const ki = await import('../../../src/hooks/knowledge-injector.js');
			ki._internals.searchKnowledge = mock(async () => ({
				results: [],
				trace_id: 'no-session-trace',
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

			const input = makeInput({ sessionID: undefined });
			const count = await injectDelegateDirectivesBefore(
				testDir,
				input,
				config,
			);
			expect(count).toBe(0);
		});
	});
});
