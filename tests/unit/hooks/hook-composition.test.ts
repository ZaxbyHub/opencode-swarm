/**
 * Hook composition fail-closed regression tests.
 *
 * The Full-Auto v2 control plane relies on `tool.execute.before` hooks to
 * propagate thrown errors to the OpenCode host so the host rejects the
 * tool call. If any pre-tool security hook were silently wrapped in
 * `safeHook` (or composed via `composeHandlers`, which wraps each handler
 * in `safeHook`), the throw would be downgraded to a warning and the
 * tool would execute anyway — a runtime fail-open.
 *
 * These tests lock the semantics in place:
 *   - `safeHook` swallows errors (advisory contract).
 *   - `composeHandlers` wraps every handler in `safeHook` (advisory chain).
 *   - `composeBlockingHandlers` does NOT wrap; throws propagate
 *     (fail-closed chain).
 *   - The actual `src/index.ts` `tool.execute.before` registration calls
 *     `fullAutoPermissionHook.toolBefore` and `fullAutoDelegationHook.toolBefore`
 *     via raw `await` (NOT through `safeHook`/`composeHandlers`).
 *
 * The static-analysis test reads `src/index.ts` directly so a future
 * refactor that wraps these hooks in `safeHook` will fail loudly at
 * test time rather than degrade silently at runtime.
 */
import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	composeBlockingHandlers,
	composeHandlers,
	safeHook,
} from '../../../src/hooks/utils';

describe('safeHook — advisory wrapper', () => {
	test('swallows thrown errors and resolves', async () => {
		const wrapped = safeHook(async () => {
			throw new Error('FULL_AUTO_DENY: example');
		});
		await expect(wrapped({}, {})).resolves.toBeUndefined();
	});

	test('passes through resolved promises', async () => {
		const fn = mock(async () => {});
		const wrapped = safeHook(fn);
		await wrapped({}, {});
		expect(fn).toHaveBeenCalled();
	});
});

describe('composeHandlers — advisory chain', () => {
	test('runs all handlers even after one throws', async () => {
		const a = mock(async () => {});
		const b = mock(async () => {
			throw new Error('FULL_AUTO_DENY: from b');
		});
		const c = mock(async () => {});
		const composed = composeHandlers(a, b, c);
		await expect(composed({}, {})).resolves.toBeUndefined();
		expect(a).toHaveBeenCalled();
		expect(b).toHaveBeenCalled();
		// c still runs because composeHandlers wraps every handler in safeHook.
		expect(c).toHaveBeenCalled();
	});

	test('empty composition resolves immediately', async () => {
		await expect(composeHandlers()({}, {})).resolves.toBeUndefined();
	});
});

describe('composeBlockingHandlers — fail-closed chain', () => {
	test('propagates the first thrown error and stops the chain', async () => {
		const a = mock(async () => {});
		const b = mock(async () => {
			throw new Error('FULL_AUTO_DENY: blocked');
		});
		const c = mock(async () => {});
		const composed = composeBlockingHandlers(a, b, c);
		await expect(composed({}, {})).rejects.toThrow(/FULL_AUTO_DENY: blocked/);
		expect(a).toHaveBeenCalled();
		expect(b).toHaveBeenCalled();
		// c MUST NOT run after the throw — that's the entire point.
		expect(c).not.toHaveBeenCalled();
	});

	test('runs all handlers when none throw', async () => {
		const a = mock(async () => {});
		const b = mock(async () => {});
		const composed = composeBlockingHandlers(a, b);
		await expect(composed({}, {})).resolves.toBeUndefined();
		expect(a).toHaveBeenCalled();
		expect(b).toHaveBeenCalled();
	});

	test('empty composition resolves immediately', async () => {
		await expect(composeBlockingHandlers()({}, {})).resolves.toBeUndefined();
	});

	test('preserves the original error type and message', async () => {
		const composed = composeBlockingHandlers(async () => {
			const e = new Error(
				'FULL_AUTO_DENY [path_out_of_root]: write outside project root',
			);
			throw e;
		});
		await expect(composed({}, {})).rejects.toThrow(
			/FULL_AUTO_DENY \[path_out_of_root\]/,
		);
	});
});

describe('static-analysis: src/index.ts tool.execute.before registration', () => {
	const indexPath = path.resolve(
		__dirname,
		'..',
		'..',
		'..',
		'src',
		'index.ts',
	);
	const source = fs.readFileSync(indexPath, 'utf-8');

	// Locate the tool.execute.before block so the assertions only inspect
	// that single registration path. The block ends where
	// `tool.execute.after` begins.
	const blockStart = source.indexOf("'tool.execute.before':");
	const blockEnd = source.indexOf("'tool.execute.after':", blockStart);
	const toolBeforeBlock = source.slice(blockStart, blockEnd);

	test('the registration block is locatable', () => {
		expect(blockStart).toBeGreaterThan(0);
		expect(blockEnd).toBeGreaterThan(blockStart);
		expect(toolBeforeBlock.length).toBeGreaterThan(100);
	});

	test('fullAutoPermissionHook.toolBefore is invoked via raw await (NOT safeHook/composeHandlers)', () => {
		// Must contain a raw `await fullAutoPermissionHook.toolBefore(`
		expect(toolBeforeBlock).toMatch(
			/await\s+fullAutoPermissionHook\.toolBefore\(/,
		);
		// Must NOT contain `safeHook(fullAutoPermissionHook.toolBefore`
		expect(toolBeforeBlock).not.toMatch(
			/safeHook\(\s*fullAutoPermissionHook\.toolBefore/,
		);
		// Must NOT be composed via composeHandlers(...) inside the chain.
		expect(toolBeforeBlock).not.toMatch(
			/composeHandlers\([^)]*fullAutoPermissionHook\.toolBefore/,
		);
	});

	test('fullAutoDelegationHook.toolBefore is invoked via raw await (NOT safeHook/composeHandlers)', () => {
		expect(toolBeforeBlock).toMatch(
			/await\s+fullAutoDelegationHook\.toolBefore\(/,
		);
		expect(toolBeforeBlock).not.toMatch(
			/safeHook\(\s*fullAutoDelegationHook\.toolBefore/,
		);
		expect(toolBeforeBlock).not.toMatch(
			/composeHandlers\([^)]*fullAutoDelegationHook\.toolBefore/,
		);
	});

	test('existing fail-closed hooks (guardrails / scope-guard / delegation-gate) are not safe-wrapped either', () => {
		expect(toolBeforeBlock).toMatch(/await\s+guardrailsHooks\.toolBefore\(/);
		expect(toolBeforeBlock).not.toMatch(
			/safeHook\(\s*guardrailsHooks\.toolBefore/,
		);
		expect(toolBeforeBlock).toMatch(/await\s+scopeGuardHook\.toolBefore\(/);
		expect(toolBeforeBlock).not.toMatch(
			/safeHook\(\s*scopeGuardHook\.toolBefore/,
		);
		expect(toolBeforeBlock).toMatch(
			/await\s+delegationGateHooks\.toolBefore\(/,
		);
		expect(toolBeforeBlock).not.toMatch(
			/safeHook\(\s*delegationGateHooks\.toolBefore/,
		);
	});

	test('advisory toolBefore (activity tracker) IS safe-wrapped (intentional)', () => {
		// Documents the intentional asymmetry: activityHooks.toolBefore is
		// observer-only and may safely swallow errors.
		expect(toolBeforeBlock).toMatch(/safeHook\(\s*activityHooks\.toolBefore/);
	});
});

describe('runtime contract: composed Full-Auto-style handler chain blocks tool execution on deny', () => {
	test('a deny in the second handler stops execution and surfaces FULL_AUTO_DENY', async () => {
		// Simulate the actual src/index.ts tool.execute.before chain shape:
		// guardrails -> scope-guard -> delegation-gate -> fullAutoDelegation
		// -> fullAutoPermission -> activity (advisory).
		const ordered: string[] = [];
		const guardrails = async () => {
			ordered.push('guardrails');
		};
		const scopeGuard = async () => {
			ordered.push('scope-guard');
		};
		const delegationGate = async () => {
			ordered.push('delegation-gate');
		};
		const fullAutoDelegation = async () => {
			ordered.push('fullAutoDelegation');
			throw new Error('FULL_AUTO_DELEGATION_DENY: unknown subagent');
		};
		const fullAutoPermission = async () => {
			ordered.push('fullAutoPermission');
		};
		const activity = async () => {
			ordered.push('activity');
		};

		const blockingChain = composeBlockingHandlers(
			guardrails,
			scopeGuard,
			delegationGate,
			fullAutoDelegation,
			fullAutoPermission,
		);
		const advisoryTail = safeHook(activity);

		const toolBefore = async (input: unknown, output: unknown) => {
			await blockingChain(input, output);
			await advisoryTail(input, output);
		};

		await expect(toolBefore({}, {})).rejects.toThrow(
			/FULL_AUTO_DELEGATION_DENY/,
		);
		// Permission and activity must NOT have run after delegation deny.
		expect(ordered).toEqual([
			'guardrails',
			'scope-guard',
			'delegation-gate',
			'fullAutoDelegation',
		]);
	});

	test('a deny in fullAutoPermission propagates FULL_AUTO_DENY and skips the advisory tail', async () => {
		const ordered: string[] = [];
		const blockingChain = composeBlockingHandlers(async () => {
			ordered.push('fullAutoPermission');
			throw new Error('FULL_AUTO_DENY [path_out_of_root]');
		});
		const advisoryTail = safeHook(async () => {
			ordered.push('activity');
		});
		const toolBefore = async (i: unknown, o: unknown) => {
			await blockingChain(i, o);
			await advisoryTail(i, o);
		};
		await expect(toolBefore({}, {})).rejects.toThrow(/FULL_AUTO_DENY/);
		expect(ordered).toEqual(['fullAutoPermission']);
	});
});
