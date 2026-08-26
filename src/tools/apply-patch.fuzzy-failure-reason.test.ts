/**
 * Issue #2349 sweep — `swarm_apply_patch` forwards WHY the fuzzy fallback failed.
 *
 * `fuzzy.error` used to be read only as `=== null` and its value discarded, so a
 * caller learned the fuzzy fallback had been attempted and failed but never why.
 * The reason now rides into the `context-mismatch` message.
 *
 * Split into its own file rather than added to `apply-patch.test.ts`: that file
 * is 1088 lines, far over the FR-006 500-line cap, and the no-growth ratchet
 * (`bun run check:test-file-cap`) forbids adding even 8 lines to it. Note the
 * ratchet is diff-scoped against the COMMITTED tree, so a pre-commit run reports
 * the old state — it must be re-run after committing.
 *
 * The fixture deliberately runs with fuzzy ENABLED and context_aware OFF, which
 * is the state where the fallback actually runs and fails. With fuzzy disabled
 * the branch is never reached and the assertion cannot bite.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import type { ApplyPatchResult } from './apply-patch';
import { _internals, swarmApplyPatch } from './apply-patch';

const TEST_TIMEOUT_MS = 15_000;

let workspace = '';
const originalLoadConfig = _internals.loadPluginConfigWithMeta;

beforeEach(() => {
	// FR-011: canonicalMkdtemp closes the macOS /var -> /private/var symlink gap.
	workspace = canonicalMkdtemp('apply-patch-fuzzy-reason-');
});

afterEach(() => {
	_internals.loadPluginConfigWithMeta = originalLoadConfig;
	try {
		rmSync(workspace, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors.
	}
});

describe('swarm_apply_patch — fuzzy failure reason (issue #2349)', () => {
	test(
		'a failed fuzzy fallback names its reason in the context-mismatch message',
		async () => {
			// Fuzzy ON, context_aware OFF — strategies 1-8 run and reject, so the
			// fallback genuinely fails and `fuzzy.error` is populated.
			_internals.loadPluginConfigWithMeta = (() => ({
				config: {
					apply_patch: {
						fuzzy_match: true,
						fuzzy_match_context_aware: false,
					},
				},
				loadedFromFile: true,
				configHadErrors: false,
			})) as typeof _internals.loadPluginConfigWithMeta;

			const targetFile = 'ctx.txt';
			writeFileSync(
				path.join(workspace, targetFile),
				'def foo():\n    x = 1\n    return x\n',
				'utf-8',
			);
			const oldBlock = 'def foo():\n    y = 2\n    return y';
			const newBlock = 'def foo():\n    x = 1\n    return x';
			const patch = `--- ${targetFile}\n+++ ${targetFile}\n@@ -1,3 +1,3 @@\n-${oldBlock
				.split('\n')
				.join('\n-')}\n+${newBlock.split('\n').join('\n+')}\n`;

			const result = JSON.parse(
				await swarmApplyPatch.execute({ patch, files: [targetFile] }, {
					directory: workspace,
				} as never),
			) as ApplyPatchResult;

			expect(result.success).toBe(false);
			expect(result.files[0]?.errors?.[0]?.type).toBe('context-mismatch');
			// The pin: without the interpolation this assertion is the only thing
			// that fails — every other patch test stays green.
			expect(result.files[0]?.errors?.[0]?.message).toContain(
				'fuzzy fallback:',
			);
		},
		TEST_TIMEOUT_MS,
	);
});
