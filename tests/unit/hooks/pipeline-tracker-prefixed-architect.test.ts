/**
 * Issue #3320 AC5: prefixed architect identities must receive the
 * ARCHITECT WORKFLOW REMINDER from the pipeline tracker hook.
 *
 * The hook (src/hooks/pipeline-tracker.ts) gates injection on the LAST user
 * message's `info.agent`. In a multi-swarm install the agent name is prefixed
 * (e.g. `mega_architect`), and every other identity-aware surface in the
 * plugin normalizes it through `stripKnownSwarmPrefix` before comparing to
 * `'architect'`. The pipeline tracker compares the RAW name, so a prefixed
 * architect never receives the reminder — the exact defect this file pins.
 *
 * Discriminating rows (mega_architect / local_architect) are RED at base,
 * GREEN after the fix. Negative controls (build / plan) are GREEN at base
 * and head: non-architect agents must never receive the reminder.
 *
 * NOTE: the undefined-agent case (last user message with no `info.agent`) is
 * PINNED as injects-by-design by tests/unit/hooks/pipeline-tracker.test.ts
 * ("injects when agent is undefined (main session)") and is deliberately NOT
 * re-tested here.
 */

import { describe, expect, it } from 'bun:test';
import { createPipelineTrackerHook } from '../../../src/hooks/pipeline-tracker';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

/**
 * Drives the real `experimental.chat.messages.transform` hook the same way
 * tests/unit/hooks/pipeline-tracker.test.ts does: mutate `output.messages`
 * in place via the transform, then inspect the last user message's first
 * text part.
 */
async function runTransformWithLastUserAgent(
	agent: string | undefined,
): Promise<string> {
	const config = {
		inject_phase_reminders: true,
		max_iterations: 5,
		qa_retry_limit: 3,
	};
	// A real directory keeps loadPlan off the repository working tree; with no
	// .swarm/plan.json in it the reminder falls back to the base compliance
	// text, exactly like the pinned pipeline-tracker tests.
	const directory = canonicalMkdtemp('pipeline-prefixed-arch-');
	try {
		const hook = createPipelineTrackerHook(config, directory);
		const transform = hook['experimental.chat.messages.transform'] as (
			input: Record<string, never>,
			output: {
				messages: Array<{
					info: { role: string; agent?: string };
					parts: Array<{ type: string; text?: string }>;
				}>;
			},
		) => Promise<void>;

		const output = {
			messages: [
				{
					info: { role: 'assistant', agent: 'coder' },
					parts: [{ type: 'text', text: 'Previous assistant message' }],
				},
				{
					info: { role: 'user', ...(agent ? { agent } : {}) },
					parts: [{ type: 'text', text: 'Last user message' }],
				},
			],
		};

		await transform({}, output);
		return output.messages[1].parts[0].text ?? '';
	} finally {
		removeTreeWithRetry(directory);
	}
}

describe('Pipeline Tracker — prefixed architect identity (issue #3320 AC5)', () => {
	describe('prefixed architect receives the reminder (RED at base, GREEN after the fix)', () => {
		it('injects ARCHITECT WORKFLOW REMINDER for mega_architect', async () => {
			// Base: `agent !== 'architect'` is true for 'mega_architect', so the
			// hook returns early and the reminder is never injected.
			const text = await runTransformWithLastUserAgent('mega_architect');
			expect(text).toContain('<swarm_reminder>');
			expect(text).toContain('ARCHITECT WORKFLOW REMINDER');
			expect(text).toContain('Last user message');
		});

		it('injects ARCHITECT WORKFLOW REMINDER for local_architect', async () => {
			const text = await runTransformWithLastUserAgent('local_architect');
			expect(text).toContain('<swarm_reminder>');
			expect(text).toContain('ARCHITECT WORKFLOW REMINDER');
		});

		it('keeps the original user text after the injected reminder for a prefixed architect', async () => {
			const text = await runTransformWithLastUserAgent('mega_architect');
			expect(text).toContain('\n\n---\n\n');
			expect(text).toEndWith('Last user message');
		});
	});

	describe('non-architect agents still receive nothing (GREEN at base and head)', () => {
		it('does NOT inject for build', async () => {
			const text = await runTransformWithLastUserAgent('build');
			expect(text).toBe('Last user message');
			expect(text).not.toContain('<swarm_reminder>');
			expect(text).not.toContain('ARCHITECT WORKFLOW REMINDER');
		});

		it('does NOT inject for plan', async () => {
			const text = await runTransformWithLastUserAgent('plan');
			expect(text).toBe('Last user message');
			expect(text).not.toContain('<swarm_reminder>');
			expect(text).not.toContain('ARCHITECT WORKFLOW REMINDER');
		});
	});

	describe('unprefixed architect baseline (GREEN at base and head)', () => {
		it('still injects for the plain architect name', async () => {
			const text = await runTransformWithLastUserAgent('architect');
			expect(text).toContain('<swarm_reminder>');
			expect(text).toContain('ARCHITECT WORKFLOW REMINDER');
		});
	});
});
