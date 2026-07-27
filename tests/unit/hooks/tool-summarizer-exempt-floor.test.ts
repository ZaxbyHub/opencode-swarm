/**
 * Floor-contract tests for `retrieve_lane_output` in createToolSummarizerHook.
 *
 * `SUMMARIZER_EXEMPT_TOOL_NAMES` (src/config/constants.ts) is applied as an
 * unconditional FLOOR: operator `exempt_tools` config can ADD names but can
 * no longer REMOVE a floor member by omitting it from the list.
 * `retrieve_lane_output` is a floor member — summarizing a lane payload
 * would destroy the `output_ref` that is its only recovery path, so it must
 * stay exempt regardless of what the operator's exempt_tools list contains.
 * See docs/releases/pending/pr-workflow-lane-output-context.md.
 *
 * Split out of tests/unit/hooks/tool-summarizer-exempt.adversarial.test.ts
 * (already over the 500-line FR-006 cap) per the test-file-split skill's
 * guidance to avoid growing an already over-cap file, matching the
 * precedent set by tests/unit/hooks/context-budget-recovery-hint.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SummaryConfig } from '../../../src/config/schema';
import {
	createToolSummarizerHook,
	resetSummaryIdCounter,
} from '../../../src/hooks/tool-summarizer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('createToolSummarizerHook - retrieve_lane_output exemption ratchet', () => {
	let tempDir: string;
	const largeOutput = 'x'.repeat(2000);

	beforeEach(() => {
		// The old suffix paired a frozen-clock stamp with Math.random(); the
		// stamp contributed nothing (a frozen clock returns a constant) and the
		// randomness is what mkdtemp now supplies natively, along with a
		// canonicalized path for the macOS /var symlink gap
		// (issues #1782, #1737).
		tempDir = canonicalMkdtemp('.swarm-test-');
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
		resetSummaryIdCounter();
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	/**
	 * Verify retrieve_lane_output is treated like retrieve_summary — exempt by
	 * default, not bypassable via suffix/prefix/case variations, and held as
	 * an unconditional floor even when the operator's exempt_tools list omits
	 * it entirely.
	 */
	it('should exempt retrieve_lane_output when in exempt list', async () => {
		const config: SummaryConfig = {
			enabled: true,
			threshold_bytes: 1024,
			max_summary_chars: 500,
			max_stored_bytes: 1024 * 1024,
			retention_days: 7,
			exempt_tools: [
				'retrieve_summary',
				'retrieve_lane_output',
				'task',
				'read',
			],
		};

		const hook = createToolSummarizerHook(config, tempDir);

		const output = {
			title: 'Test Tool',
			output: largeOutput,
			metadata: {},
		};

		await hook(
			{ tool: 'retrieve_lane_output', sessionID: 'test', callID: 'test' },
			output,
		);

		expect(output.output).toBe(largeOutput);
	});

	it('should NOT exempt retrieve_lane_output with suffix', async () => {
		const config: SummaryConfig = {
			enabled: true,
			threshold_bytes: 1024,
			max_summary_chars: 500,
			max_stored_bytes: 1024 * 1024,
			retention_days: 7,
			exempt_tools: [
				'retrieve_summary',
				'retrieve_lane_output',
				'task',
				'read',
			],
		};

		const hook = createToolSummarizerHook(config, tempDir);

		const output = {
			title: 'Test Tool',
			output: largeOutput,
			metadata: {},
		};

		await hook(
			{
				tool: 'retrieve_lane_output_extra',
				sessionID: 'test',
				callID: 'test',
			},
			output,
		);

		expect(output.output).not.toBe(largeOutput);
	});

	// Contract change: SUMMARIZER_EXEMPT_TOOL_NAMES (src/config/constants.ts)
	// is now an unconditional FLOOR, not a default operator config can
	// replace. `retrieve_lane_output` is a floor member — summarizing a lane
	// payload would destroy the `output_ref` that is its only recovery path,
	// so it must stay exempt even when the operator's exempt_tools list
	// omits it entirely. This test previously asserted the OLD replacement
	// semantics (missing from the list => summarized); it now asserts the
	// floor holds. See docs/releases/pending/pr-workflow-lane-output-context.md.
	it('should still exempt retrieve_lane_output (floor) even when missing from exempt list', async () => {
		const config: SummaryConfig = {
			enabled: true,
			threshold_bytes: 1024,
			max_summary_chars: 500,
			max_stored_bytes: 1024 * 1024,
			retention_days: 7,
			exempt_tools: ['retrieve_summary', 'task', 'read'],
		};

		const hook = createToolSummarizerHook(config, tempDir);

		const output = {
			title: 'Test Tool',
			output: largeOutput,
			metadata: {},
		};

		await hook(
			{ tool: 'retrieve_lane_output', sessionID: 'test', callID: 'test' },
			output,
		);

		// Floor exemption applies regardless of operator exempt_tools content.
		expect(output.output).toBe(largeOutput);
	});
});
