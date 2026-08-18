/**
 * Static-analysis wiring guard for the gate-denial tracker (issue #2063 B1).
 *
 * The tracker's behavior is unit-tested in `gate-denial-tracker.test.ts`, but
 * its CORRECTNESS depends on where it is called from inside the `src/index.ts`
 * `tool.execute.before` registration — and that handler is not directly
 * importable. This file reads the source, the same way
 * `hook-composition.test.ts` does, so a refactor that moves a call site fails
 * loudly at test time instead of silently disabling the containment.
 *
 * Each assertion below corresponds to a defect that was actually possible with
 * a plausible-looking arrangement of the same calls.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const indexPath = path.resolve(__dirname, '..', '..', '..', 'src', 'index.ts');
const source = fs.readFileSync(indexPath, 'utf-8');

const blockStart = source.indexOf("'tool.execute.before':");
const blockEnd = source.indexOf("'tool.execute.after':", blockStart);
const toolBeforeBlock = source.slice(blockStart, blockEnd);

describe('gate-denial tracker wiring in src/index.ts', () => {
	test('the tool.execute.before block is locatable', () => {
		expect(blockStart).toBeGreaterThan(0);
		expect(blockEnd).toBeGreaterThan(blockStart);
	});

	test('the fail-closed chain is wrapped in a try/catch that always rethrows', () => {
		expect(toolBeforeBlock).toMatch(/let failClosedRegionCompleted = false;/);
		expect(toolBeforeBlock).toMatch(/\}\s*catch\s*\(err\)\s*\{/);
		// The rethrow is what preserves the fail-closed contract. Without it the
		// wrapper would convert every gate denial into a silent pass.
		expect(toolBeforeBlock).toMatch(/throw err;/);
	});

	test('the streak reset runs AFTER the advisory tail, not at the fail-closed terminator', () => {
		// Regression: the reset originally sat at the fail-closed terminator, so a
		// throw from a LATER raw-awaited step (beginApprovedReviewerScopeLifecycle
		// does unguarded I/O) rejected the call while the counter had already been
		// cleared. A repeatable failure there would zero the streak on every
		// attempt and the escalation ladder would never climb.
		const resetIdx = toolBeforeBlock.indexOf('resetGateDenialStreaks(');
		const advisoryTailIdx = toolBeforeBlock.indexOf(
			'safeHook(activityHooks.toolBefore)',
		);
		const flagIdx = toolBeforeBlock.indexOf('failClosedRegionCompleted = true');

		expect(resetIdx).toBeGreaterThan(0);
		expect(advisoryTailIdx).toBeGreaterThan(0);
		expect(flagIdx).toBeGreaterThan(0);
		expect(resetIdx).toBeGreaterThan(advisoryTailIdx);
		// The counting boundary still ends where the fail-closed region ends, so
		// an advisory-tail throw is not miscounted as a gate denial.
		expect(flagIdx).toBeLessThan(advisoryTailIdx);
	});

	test('the reset is reached only on the success path, never from the catch', () => {
		const catchIdx = toolBeforeBlock.search(/\}\s*catch\s*\(err\)\s*\{/);
		expect(catchIdx).toBeGreaterThan(0);
		const catchBody = toolBeforeBlock.slice(catchIdx);
		expect(catchBody).not.toContain('resetGateDenialStreaks(');
		// Exactly one reset call site in the whole registration.
		expect(toolBeforeBlock.split('resetGateDenialStreaks(').length - 1).toBe(1);
	});

	test('the denial is recorded BEFORE it is decorated', () => {
		// noteGateDenial mutates err.message; recording afterwards would persist
		// our own advisory text into the trajectory instead of the gate's.
		const recordIdx = toolBeforeBlock.indexOf('recordDeniedToolCall(');
		const noteIdx = toolBeforeBlock.indexOf('noteGateDenial(');
		expect(recordIdx).toBeGreaterThan(0);
		expect(noteIdx).toBeGreaterThan(0);
		expect(recordIdx).toBeLessThan(noteIdx);
	});

	test('the tracker honours guardrails.enabled and the configured thresholds', () => {
		// The keys live in the guardrails config block, so `enabled: false` must
		// switch the ladder off rather than leaving it silently armed.
		expect(toolBeforeBlock).toMatch(/enabled:\s*guardrailsConfig\.enabled/);
		expect(toolBeforeBlock).toMatch(
			/warnThreshold:\s*guardrailsConfig\.gate_denial_warn_threshold/,
		);
		expect(toolBeforeBlock).toMatch(
			/stopThreshold:\s*guardrailsConfig\.gate_denial_stop_threshold/,
		);
	});

	test('abort errors are excluded before the denial is recorded', () => {
		expect(toolBeforeBlock).toMatch(/!isAbortLikeError\(err\)/);
	});

	test('the reset passes the resolved args so its discriminator is real', () => {
		// Reviewer round-4 REQUIRED 2: streaks are sub-scoped by dispatch target.
		// A reset that forgets the third argument silently falls back to the ''
		// bucket, which reinstates the exact over-wide reset the discriminator
		// exists to fix — and every unit test of the tracker would still pass,
		// because the tracker itself is correct. Only the wiring can be wrong.
		expect(toolBeforeBlock).toMatch(
			/resetGateDenialStreaks\(\s*input\.sessionID,\s*input\.tool,\s*toolBeforeArgs,?\s*\)/,
		);
	});

	test('the denial is counted with the resolved args of the DENIED call', () => {
		const catchIdx = toolBeforeBlock.search(/\}\s*catch\s*\(err\)\s*\{/);
		const catchBody = toolBeforeBlock.slice(catchIdx);
		// `toolBeforeArgs` is declared inside the try and is NOT in scope here, so
		// the args must be re-resolved in the catch...
		expect(catchBody).toMatch(/let deniedArgs/);
		expect(catchBody).toMatch(/resolveToolBeforeContext\(/);
		// ...inside its OWN try/catch. A throw escaping this catch block would
		// change WHICH error propagates, breaking the fail-closed contract.
		expect(catchBody).toMatch(
			/try\s*\{\s*deniedArgs\s*=[\s\S]*?\}\s*catch\s*\{\s*deniedArgs = undefined;\s*\}/,
		);
		// And they must actually reach the tracker.
		expect(catchBody).toMatch(/noteGateDenial\([\s\S]*?deniedArgs,?\s*\);/);
	});

	test('the tracker is imported from its own module, not re-implemented inline', () => {
		expect(source).toMatch(
			/import \{[^}]*noteGateDenial[^}]*\} from '\.\/hooks\/gate-denial-tracker\.js';/s,
		);
		expect(source).toMatch(
			/import \{[^}]*recordDeniedToolCall[^}]*\} from '\.\/hooks\/trajectory-logger';/s,
		);
	});

	// Issue #2214 denial rollback (F-003, PR #2223 review): a denied Task call
	// never fires toolAfter, so the catch must roll back any settlement the
	// delegation gate durably began. These assertions pin the wiring the same
	// way the tracker assertions above do — the runtime behavior is covered by
	// tests/unit/workflow/coder-settlement-2214*.test.ts against the hook
	// object; this guard proves src/index.ts actually calls it.
	test('the denial catch rolls back a begun settlement for denied Task calls', () => {
		const catchIdx = toolBeforeBlock.search(/\}\s*catch\s*\(err\)\s*\{/);
		const catchBody = toolBeforeBlock.slice(catchIdx);

		// The rollback must fire only for the fail-closed region's denials and
		// only for Task calls...
		expect(catchBody).toMatch(
			/if\s*\(\s*!failClosedRegionCompleted\s*&&\s*\(\s*normalizeToolName\(input\.tool\) === 'Task'\s*\|\|\s*normalizeToolName\(input\.tool\) === 'task'\s*\)\s*\)\s*\{/,
		);
		// ...and must call the delegation gate's rollback entry point from
		// inside its own try/catch so the original denial still propagates, with
		// the rethrow landing AFTER the rollback attempt.
		expect(catchBody).toMatch(
			/try\s*\{\s*await delegationGateHooks\.abortDeniedSettlementForCall\(\s*input\.callID,?\s*\);?\s*\}\s*catch\s*\{/,
		);
		const callIdx = catchBody.indexOf(
			'delegationGateHooks.abortDeniedSettlementForCall(',
		);
		expect(callIdx).toBeGreaterThan(0);
		const throwIdx = catchBody.indexOf('throw err;', callIdx);
		expect(throwIdx).toBeGreaterThan(callIdx);
	});
});
