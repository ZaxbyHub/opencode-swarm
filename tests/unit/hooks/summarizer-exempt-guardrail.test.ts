/**
 * Recurrence guardrail for the defect class: "a payload carrying a
 * retrieval ref gets rewritten by a generic context layer."
 *
 * Prior to the fix, `SUMMARIZER_EXEMPT_TOOL_NAMES` had THREE independent
 * hardcoded copies (tool-summarizer.ts, context-budget.ts, and the
 * `defaultTruncatableTools` allowlist in index.ts implicitly needed to stay
 * clear of them) and one of them was missed, letting a generic
 * summarizer/masker rewrite `dispatch_lanes`/`collect_lane_results` output
 * and destroy the `output_ref` a caller needed to retrieve the real content.
 *
 * This file must fail if:
 *   1. A new ref-carrying tool is added without adding it to the exempt floor.
 *   2. A second hardcoded copy of the exempt list reappears in a consumer file.
 *   3. A ref-carrying tool leaks into the unrelated line-truncation allowlist.
 *   4. Operator config narrows `exempt_tools` and the floor tool stops being exempt.
 *   5. The summarizer hook itself stops running (making the exemption meaningless).
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUMMARIZER_EXEMPT_TOOL_NAMES } from '../../../src/config/constants';
import type { SummaryConfig } from '../../../src/config/schema';
import { createToolSummarizerHook } from '../../../src/hooks/tool-summarizer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Explicit, manually-maintained list of tool names whose SUCCESS payload can
 * carry an `output_ref` / retrieval ref that a generic context layer must
 * never rewrite.
 *
 * MAINTAINERS: if you add a new tool whose output can carry a retrieval ref
 * (an `output_ref`, `L1:<hex>:<hex>:<hex>` lane ref, or an `S<n>` summary
 * id that must survive verbatim), you MUST add it to BOTH this list AND
 * `SUMMARIZER_EXEMPT_TOOL_NAMES` in `src/config/constants.ts`. Adding it only
 * here (and not to the source floor) is what this test is designed to catch.
 */
const REF_CARRYING_TOOL_NAMES = [
	'dispatch_lanes',
	'dispatch_lanes_async',
	'collect_lane_results',
	'parse_lane_candidates',
	'retrieve_lane_output',
	'retrieve_summary',
] as const;

/**
 * The four names that were duplicated verbatim across tool-summarizer.ts and
 * context-budget.ts before the fix. Kept as a private constant (not exported)
 * so this test's regex reasoning is legible without re-deriving it.
 */
const ORIGINAL_FOUR_EXEMPT_NAMES = [
	'retrieve_summary',
	'retrieve_lane_output',
	'task',
	'read',
] as const;

/**
 * Strip block and line comments so prose mentions of tool names (which are
 * expected and harmless — they document the exemption) don't produce false
 * positives when checking for a hardcoded re-declaration of the list.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('SUMMARIZER_EXEMPT_TOOL_NAMES guardrail', () => {
	describe('1. Ref-carrying tools are exempt', () => {
		it('every documented ref-carrying tool is present in the exempt floor', () => {
			const exemptSet = new Set(
				SUMMARIZER_EXEMPT_TOOL_NAMES as readonly string[],
			);
			for (const toolName of REF_CARRYING_TOOL_NAMES) {
				expect(exemptSet.has(toolName)).toBe(true);
			}
		});

		it('lists at least the minimum set — dispatch_lanes, dispatch_lanes_async, collect_lane_results, parse_lane_candidates', () => {
			// These four are the specific S1.1 lane-tool additions; assert them
			// individually (not just via the loop above) so a diff that removes
			// one from REF_CARRYING_TOOL_NAMES cannot silently defeat coverage.
			expect(SUMMARIZER_EXEMPT_TOOL_NAMES).toContain('dispatch_lanes');
			expect(SUMMARIZER_EXEMPT_TOOL_NAMES).toContain('dispatch_lanes_async');
			expect(SUMMARIZER_EXEMPT_TOOL_NAMES).toContain('collect_lane_results');
			expect(SUMMARIZER_EXEMPT_TOOL_NAMES).toContain('parse_lane_candidates');
			expect(SUMMARIZER_EXEMPT_TOOL_NAMES).toContain('retrieve_lane_output');
			expect(SUMMARIZER_EXEMPT_TOOL_NAMES).toContain('retrieve_summary');
		});
	});

	describe('2. Single definition — no consumer re-declares its own copy', () => {
		it('tool-summarizer.ts imports the constant and does not hardcode the original four names', () => {
			const source = fs.readFileSync(
				path.join(REPO_ROOT, 'src/hooks/tool-summarizer.ts'),
				'utf-8',
			);
			expect(source).toContain(
				"import { SUMMARIZER_EXEMPT_TOOL_NAMES } from '../config/constants'",
			);
			const stripped = stripComments(source);
			for (const name of ORIGINAL_FOUR_EXEMPT_NAMES) {
				// After stripping comments, the tool name string literals should
				// appear nowhere in code — the only runtime reference is the
				// imported constant. A reintroduced hardcoded array (e.g.
				// `['retrieve_summary', 'retrieve_lane_output', 'task', 'read']`)
				// would leave these quoted literals in the stripped source.
				expect(stripped).not.toContain(`'${name}'`);
				expect(stripped).not.toContain(`"${name}"`);
			}
		});

		it('context-budget.ts imports the constant and does not hardcode the original four names', () => {
			const source = fs.readFileSync(
				path.join(REPO_ROOT, 'src/hooks/context-budget.ts'),
				'utf-8',
			);
			expect(source).toContain(
				"import { SUMMARIZER_EXEMPT_TOOL_NAMES } from '../config/constants'",
			);
			const stripped = stripComments(source);
			for (const name of ORIGINAL_FOUR_EXEMPT_NAMES) {
				expect(stripped).not.toContain(`'${name}'`);
				expect(stripped).not.toContain(`"${name}"`);
			}
		});
	});

	describe('3. Truncation allowlist safety', () => {
		it('defaultTruncatableTools in src/index.ts never contains a ref-carrying tool name', () => {
			const source = fs.readFileSync(
				path.join(REPO_ROOT, 'src/index.ts'),
				'utf-8',
			);
			const startMarker = 'const defaultTruncatableTools = new Set([';
			const startIdx = source.indexOf(startMarker);
			expect(startIdx).toBeGreaterThan(-1);
			const endIdx = source.indexOf(']);', startIdx);
			expect(endIdx).toBeGreaterThan(startIdx);
			const arrayLiteral = source.slice(startIdx + startMarker.length, endIdx);
			for (const toolName of REF_CARRYING_TOOL_NAMES) {
				expect(arrayLiteral).not.toContain(`'${toolName}'`);
			}
		});
	});

	describe('4. Operator config cannot remove the floor', () => {
		it('a narrowed exempt_tools config still exempts a ref-carrying tool', async () => {
			const directory = fs.mkdtempSync(
				path.join(os.tmpdir(), 'summarizer-guardrail-'),
			);
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 200,
				max_stored_bytes: 1_000_000,
				retention_days: 7,
				// Operator attempts to narrow exempt_tools to exclude every
				// lane tool — the floor in tool-summarizer.ts must still win.
				exempt_tools: ['something_else'],
			};
			const hook = createToolSummarizerHook(config, directory);

			const oversizedOutput = 'x'.repeat(5000);
			const output = {
				title: 'collect_lane_results',
				output: oversizedOutput,
				metadata: {},
			};
			await hook(
				{ tool: 'collect_lane_results', sessionID: 's1', callID: 'c1' },
				output,
			);

			expect(output.output).toBe(oversizedOutput);
		});
	});

	describe('5. The bug reproduces without the fix — the hook is live', () => {
		it('a non-exempt tool with an equally oversized output IS summarized', async () => {
			const directory = fs.mkdtempSync(
				path.join(os.tmpdir(), 'summarizer-guardrail-'),
			);
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 200,
				max_stored_bytes: 1_000_000,
				retention_days: 7,
				exempt_tools: ['something_else'],
			};
			const hook = createToolSummarizerHook(config, directory);

			const oversizedOutput = 'x'.repeat(5000);
			const output = {
				title: 'bash',
				output: oversizedOutput,
				metadata: {},
			};
			await hook({ tool: 'bash', sessionID: 's1', callID: 'c2' }, output);

			// Proves the hook is live: a non-exempt tool's oversized output is
			// rewritten, so test #4 above is validating a real exemption path,
			// not a hook that never runs.
			expect(output.output).not.toBe(oversizedOutput);
			expect(output.output).toContain('[SUMMARY');
		});
	});
});
