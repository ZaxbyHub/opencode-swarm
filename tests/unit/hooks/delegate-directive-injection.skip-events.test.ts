/**
 * Delegate-path `injection_skip` telemetry tests (mirrors the #1768 architect
 * hardening — see tests/unit/hooks/knowledge-injector-skip-telemetry.test.ts).
 *
 * Every per-delegation silent early-return in `injectDelegateDirectivesBefore`
 * now emits a structured `injection_skip` event to
 * `.swarm/knowledge-events.jsonl` so the reason a real deployment went dark is
 * diagnosable. `knowledge_disabled` and `not_task_tool` are deliberately
 * excluded (they fire on every non-Task tool call — event flood) and stay
 * log-only.
 *
 * Pattern (AGENTS.md invariant 7): bun:test, real mkdtemp temp dirs (real
 * `recordKnowledgeEvent` writes — the event helper is a direct import, not
 * routed through knowledge-injector's `_internals` seam, so it cannot be
 * mocked via that seam). `ki._internals.searchKnowledge` is mocked only for
 * cases that must reach `injectForDelegate` (success / no-directives / error).
 *
 * Fire-and-forget writes go through `mkdir` -> `proper-lockfile.lock` ->
 * `appendFile`, so positive assertions poll (bounded) for the expected event
 * count instead of sleeping a fixed duration, which can flake under
 * cold-filesystem CI latency (Windows/macOS). Negative assertions (an event
 * must NOT appear) cannot be proven by polling for absence, so those use one
 * bounded settle window instead — see `settle()`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { injectDelegateDirectivesBefore } from '../../../src/hooks/delegate-directive-injection.js';
import type { KnowledgeEvent } from '../../../src/hooks/knowledge-events.js';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';
import {
	makeConfig,
	makeEntry,
	makeInput,
} from './delegate-directive-injection.fixtures.js';

let dir: string;
let cleanup: () => void;
let originalSearchKnowledge: typeof import('../../../src/hooks/knowledge-injector.js')._internals.searchKnowledge;

beforeEach(async () => {
	({ dir, cleanup } = createSafeTestDir('delegate-skip-events-'));
	const ki = await import('../../../src/hooks/knowledge-injector.js');
	originalSearchKnowledge = ki._internals.searchKnowledge;
});

afterEach(async () => {
	const ki = await import('../../../src/hooks/knowledge-injector.js');
	ki._internals.searchKnowledge = originalSearchKnowledge;
	mock.restore();
	cleanup();
});

function skipEventsOf(
	events: KnowledgeEvent[],
): Extract<KnowledgeEvent, { type: 'injection_skip' }>[] {
	return events.filter(
		(e): e is Extract<KnowledgeEvent, { type: 'injection_skip' }> =>
			e.type === 'injection_skip',
	);
}

/**
 * Polls `.swarm/knowledge-events.jsonl` (bounded) until at least
 * `expectedCount` `injection_skip` events are present, then returns them.
 * Avoids a fixed-duration sleep race against the fire-and-forget
 * mkdir/lock/appendFile write path under cold-filesystem CI latency.
 */
async function waitForSkipEvents(
	expectedCount: number,
	maxAttempts = 50,
	intervalMs = 20,
): Promise<Extract<KnowledgeEvent, { type: 'injection_skip' }>[]> {
	let skips = skipEventsOf(await readKnowledgeEvents(dir));
	for (let i = 0; i < maxAttempts && skips.length < expectedCount; i++) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		skips = skipEventsOf(await readKnowledgeEvents(dir));
	}
	return skips;
}

/**
 * A bounded settle window for negative assertions ("this event must NOT
 * appear"). Polling cannot prove absence, so this is the one place a fixed
 * delay is intentional — long enough for the fire-and-forget write to have
 * landed if it were going to.
 */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('injectDelegateDirectivesBefore — injection_skip telemetry', () => {
	it('caller_not_allowed: emits injection_skip with reason + agent attribution', async () => {
		const input = makeInput({ agent: 'coder' });
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);

		const skips = await waitForSkipEvents(1);
		expect(skips).toHaveLength(1);
		expect(skips[0].reason).toBe('delegate_caller_not_allowed');
		expect(skips[0].agent).toBe('coder');
		expect(skips[0].detail).toMatchObject({ caller_role: 'coder' });
		expect(skips[0].session_id).toBe('test-session');
	});

	it('missing_args: emits injection_skip attributed to the caller agent', async () => {
		const input = makeInput({ args: null });
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);

		const skips = await waitForSkipEvents(1);
		expect(skips).toHaveLength(1);
		expect(skips[0].reason).toBe('delegate_missing_args');
		expect(skips[0].agent).toBe('architect');
	});

	it('missing_prompt: emits injection_skip attributed to the caller agent', async () => {
		const input = makeInput({
			args: { subagent_type: 'coder', prompt: 123 } as unknown as Record<
				string,
				unknown
			>,
		});
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);

		const skips = await waitForSkipEvents(1);
		expect(skips).toHaveLength(1);
		expect(skips[0].reason).toBe('delegate_missing_prompt');
		expect(skips[0].agent).toBe('architect');
	});

	it('unparseable_delegation_args: emits injection_skip', async () => {
		// Both subagent_type and prompt must be empty/absent for parseDelegationArgs
		// to return null — a non-empty prompt falls back to using its first line as
		// the target agent (backward-compat path), landing in
		// target_not_delegated_agent instead.
		const input = makeInput({
			args: { prompt: '' } as unknown as Record<string, unknown>,
		});
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);

		const skips = await waitForSkipEvents(1);
		expect(skips).toHaveLength(1);
		expect(skips[0].reason).toBe('delegate_unparseable_delegation_args');
		expect(skips[0].agent).toBe('architect');
	});

	it('target_not_delegated_agent: emits injection_skip with the target agent', async () => {
		const input = makeInput({
			args: { subagent_type: 'unrecognized_agent', prompt: 'Do something' },
		});
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);

		const skips = await waitForSkipEvents(1);
		expect(skips).toHaveLength(1);
		expect(skips[0].reason).toBe('delegate_target_not_delegated_agent');
		expect(skips[0].agent).toBe('unrecognized_agent');
		expect(skips[0].detail).toMatchObject({
			target_agent: 'unrecognized_agent',
		});
	});

	it('already_injected: emits injection_skip with the target agent', async () => {
		const input = makeInput({
			args: {
				subagent_type: 'coder',
				prompt: `<delegate_knowledge_directives>\n- id: k-already\n</delegate_knowledge_directives>\n\nTO: coder`,
			},
		});
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);

		const skips = await waitForSkipEvents(1);
		expect(skips).toHaveLength(1);
		expect(skips[0].reason).toBe('delegate_already_injected');
		expect(skips[0].agent).toBe('coder');
	});

	it('no_directives_to_inject: emits injection_skip with the target agent', async () => {
		const ki = await import('../../../src/hooks/knowledge-injector.js');
		ki._internals.searchKnowledge = mock(async () => ({
			results: [],
			trace_id: 'empty-trace',
		}));

		// subagent_type 'coder' — non-reviewer, so no compliance block fallback
		// either; prefixParts stays empty and the branch fires.
		const input = makeInput({
			args: { subagent_type: 'coder', prompt: 'Do something' },
		});
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);

		const skips = await waitForSkipEvents(1);
		expect(skips).toHaveLength(1);
		expect(skips[0].reason).toBe('delegate_no_directives_to_inject');
		expect(skips[0].agent).toBe('coder');
	});

	it('injection_error: outer-catch emits injection_skip with the error message', async () => {
		// injectForDelegate fail-opens INTERNALLY around searchKnowledge (its own
		// try/catch returns { entries: [], trace_id: '' } on failure), so a
		// throwing searchKnowledge lands on `no_directives_to_inject`, not the
		// outer catch — covered by the case above. To reach the outer catch we
		// need a throw from a call site with NO local try/catch:
		// `readPhaseDirectivesToVerify`, reached only for a reviewer target.
		const ki = await import('../../../src/hooks/knowledge-injector.js');
		ki._internals.searchKnowledge = mock(async () => ({
			results: [makeEntry({ id: 'k-review', lesson: 'Verify carefully' })],
			trace_id: 'review-trace',
		}));

		const realPhaseDirectives = await import(
			'../../../src/hooks/phase-directives.js'
		);
		mock.module('../../../src/hooks/phase-directives.js', () => ({
			...realPhaseDirectives,
			readPhaseDirectivesToVerify: mock(async () => {
				throw new Error('boom');
			}),
		}));

		const input = makeInput({
			args: { subagent_type: 'reviewer', prompt: 'Review the change' },
		});
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);

		const skips = await waitForSkipEvents(1);
		expect(skips).toHaveLength(1);
		expect(skips[0].reason).toBe('delegate_injection_error');
		expect(skips[0].detail).toMatchObject({
			message: expect.stringContaining('boom'),
		});
		expect(skips[0].session_id).toBe('test-session');
	});

	it('not_task_tool: emits NOTHING to knowledge-events.jsonl', async () => {
		const input = makeInput({ tool: 'Edit' });
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(0);
		await settle();

		expect(skipEventsOf(await readKnowledgeEvents(dir))).toHaveLength(0);
	});

	it('knowledge_disabled: emits NOTHING to knowledge-events.jsonl', async () => {
		const input = makeInput();
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig({ enabled: false }),
		);
		expect(count).toBe(0);
		await settle();

		expect(skipEventsOf(await readKnowledgeEvents(dir))).toHaveLength(0);
	});

	it('successful injection emits NO injection_skip event', async () => {
		const ki = await import('../../../src/hooks/knowledge-injector.js');
		ki._internals.searchKnowledge = mock(async () => ({
			results: [makeEntry({ id: 'k-success', lesson: 'Do the thing well' })],
			trace_id: 'success-trace',
		}));

		const input = makeInput({
			args: { subagent_type: 'coder', prompt: 'Implement the feature' },
		});
		const count = await injectDelegateDirectivesBefore(
			dir,
			input,
			makeConfig(),
		);
		expect(count).toBe(1);
		await settle();

		expect(skipEventsOf(await readKnowledgeEvents(dir))).toHaveLength(0);
	});
});
