import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	recordSessionWorkspaceRoot,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Issue #2002 — GUARDRAILS half. The tool-before handler is constructed ONCE
 * at plugin init with the plugin-root `ctx.directory` (src/index.ts:1072-1078)
 * but worktree-isolated coder children execute in a lane root. Every test here
 * constructs the hook with the PROJECT ROOT, mirroring production wiring — do
 * NOT "simplify" these tests by passing a lane as the hook directory, that
 * removes the only thing they are testing.
 *
 * Sibling test tests/unit/hooks/scope-guard-worktree-session-root.test.ts
 * covers the SAME regression for the scope-guard hook; this file covers the
 * guardrails toolBefore handler (src/hooks/guardrails/tool-before.ts).
 *
 * FIXTURE LAYOUT — deliberately mixed, do not collapse to one shape:
 *  - Tests 1-3 and 6 use SIBLING lanes: `<tmpRoot>/swarm-worktrees/<name>`,
 *    a sibling of `<tmpRoot>/project`. This mirrors the real default
 *    `resolveWorktreeBaseDir` shape (`dirname(directory)/.swarm-worktrees`,
 *    src/worktree/core.ts:499-506) and is required to reproduce the
 *    pre-fix containment bug: from a project-root cwd, an absolute sibling
 *    path resolves to `../swarm-worktrees/...`, which the "outside working
 *    directory" containment check rejects — exactly the pre-fix symptom.
 *  - Tests 4-5 use a NESTED lane (`<projectRoot>/<name>`), representing a
 *    `worktree_dir` config that places lanes under the project tree
 *    (`resolveWorktreeBaseDir` supports this explicitly). A nested lane is
 *    required to prove those two cases: a SIBLING lane target would already
 *    be blocked by plain containment under BOTH the buggy and fixed helper
 *    (both would reject "escapes cwd"), which would not distinguish the fix.
 *    Nesting the "other" lane inside the project root, while the acting
 *    session's OWN root is a sibling lane, makes the pre-fix bug concrete:
 *    with `cwd === effectiveDirectory` (the bug), the nested target does NOT
 *    escape `effectiveDirectory` and slips through; only re-rooting `cwd` to
 *    the session's own lane (the fix) rejects it.
 *
 * NOTE ON `<projectRoot>/.swarm/plan.json`: this file intentionally does NOT
 * assert that a lane coder cannot write `<projectRoot>/.swarm/plan.json` via
 * an absolute path, because that assertion cannot fail under the described
 * neutralization. `plan.json` is classified into the `config` zone purely by
 * its `.json` extension (src/context/zone-classifier.ts:83-98), which coder's
 * `blockedZones` rejects BEFORE any cwd-dependent check runs. And any
 * `<projectRoot>/.swarm/...` target normalizes to `.swarm/...` under the
 * pre-fix bug specifically BECAUSE the bug makes every session's cwd equal
 * `effectiveDirectory` (== projectRoot) — so it always coincidentally hits
 * blockedPrefix pre-fix too. There is no fixture that makes this
 * differentiate; test 5 below proves the equivalent (and strictly harder)
 * property using a non-`.json` path so the zone shortcut can't mask it.
 */

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

const TASK_FILE = 'src/allowed.ts';

describe('guardrails toolBefore resolves the executing session workspace root (#2002)', () => {
	let projectRoot: string;
	let laneBase: string;
	let cleanup: () => void;

	function makeHooks(): ReturnType<typeof createGuardrailsHooks> {
		// Production call convention: createGuardrailsHooks(ctx.directory, undefined, guardrailsCfg, authorityCfg, worktreeBaseDirOverrides)
		return createGuardrailsHooks(
			projectRoot,
			undefined,
			defaultConfig(),
			undefined,
			[],
		);
	}

	/** Sibling lane: `<tmpRoot>/swarm-worktrees/<name>` — the default worktree shape. */
	function provisionSiblingLane(name: string, childSessionId: string): string {
		const lane = path.join(laneBase, name);
		fs.mkdirSync(lane, { recursive: true });
		// ORDER AND CALL SHAPE ARE LOAD-BEARING — mirrors worktree-isolation.ts
		// exactly: ensureAgentSession(id, 'coder', worktreePath) registers the
		// child session with its real agent name FIRST, THEN
		// recordSessionWorkspaceRoot records the lane root.
		// recordSessionWorkspaceRoot deliberately refuses to create a session
		// (src/state.ts), so calling it before registration — or registering
		// via a bare startAgentSession call that omits the directory — is not
		// the same production path.
		ensureAgentSession(childSessionId, 'coder', lane);
		installActiveScopeBinding({
			directory: lane,
			childSessionId,
			taskId: '1.1',
			files: [TASK_FILE],
		});
		recordSessionWorkspaceRoot(childSessionId, lane);
		return lane;
	}

	/** Nested lane: `<projectRoot>/<name>` — a custom worktree_dir-under-project shape. */
	function provisionNestedLane(
		name: string,
		childSessionId: string,
		files: string[] = [TASK_FILE],
	): string {
		const lane = path.join(projectRoot, name);
		fs.mkdirSync(lane, { recursive: true });
		// Mirrors production ordering — see provisionSiblingLane above.
		ensureAgentSession(childSessionId, 'coder', lane);
		installActiveScopeBinding({
			directory: lane,
			childSessionId,
			taskId: '1.1',
			files,
		});
		recordSessionWorkspaceRoot(childSessionId, lane);
		return lane;
	}

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('guardrails-worktree-root-');
		projectRoot = path.join(created.dir, 'project');
		laneBase = path.join(created.dir, 'swarm-worktrees');
		fs.mkdirSync(projectRoot, { recursive: true });
		fs.mkdirSync(laneBase, { recursive: true });
		cleanup = created.cleanup;
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('1. REGRESSION: lane coder shell write to an in-scope lane file is allowed', async () => {
		const hooks = makeHooks();
		provisionSiblingLane('lane-shell-ok', 'child-shell-ok');

		// Pre-fix this threw SCOPE_NOT_DECLARED: the scope binding was registered
		// against the lane's workspaceIdentity, but resolveActiveScopeBinding
		// looked it up against effectiveDirectory (the project root) — a mismatch
		// that made declaredScope resolve to null.
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'child-shell-ok', callID: 'sh1' },
				{ args: { command: 'echo hi > src/allowed.ts' } },
			),
		).resolves.toBeUndefined();
	});

	test('2. lane coder shell write outside declared scope is still blocked', async () => {
		const hooks = makeHooks();
		provisionSiblingLane('lane-shell-oos', 'child-shell-oos');

		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'child-shell-oos', callID: 'sh2' },
				{ args: { command: 'echo hi > src/forbidden.ts' } },
			),
		).rejects.toThrow('bash write detected outside declared scope:');
	});

	test('3. lane coder direct write with an absolute lane path is allowed when in scope', async () => {
		const hooks = makeHooks();
		const lane = provisionSiblingLane('lane-abs-ok', 'child-abs-ok');

		// Pre-fix: containment resolved the absolute lane path against the
		// project root. Since the lane is a SIBLING of the project root, the
		// resolved relative path starts with ".." and the write was rejected
		// with "resolves outside the working directory".
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'child-abs-ok', callID: 'w1' },
				{
					args: {
						filePath: path.join(lane, 'src', 'allowed.ts'),
						content: 'ok',
					},
				},
			),
		).resolves.toBeUndefined();
	});

	test('4. lane coder direct write to an absolute path in another (nested) lane is blocked', async () => {
		const hooks = makeHooks();
		provisionSiblingLane('lane-x', 'child-x');
		// The "other" lane is nested under the project root (a worktree_dir
		// config that places lanes inside the project tree). From child-x's
		// own sibling lane this is still fully outside its authorized root.
		const laneY = provisionNestedLane('nested-lane-y', 'child-y');

		// Pre-fix: cwd === projectRoot for every session. nested-lane-y is a
		// child of projectRoot, so the target does NOT escape cwd and the
		// write was incorrectly ALLOWED — a cross-lane write leak.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'child-x', callID: 'w2' },
				{
					args: {
						filePath: path.join(laneY, 'src', 'allowed.ts'),
						content: 'no',
					},
				},
			),
		).rejects.toThrow(/resolves outside the working directory/);
	});

	test('5. nested-lane coder cannot bypass blockedPrefix on its own lane .swarm/ tree', async () => {
		const hooks = makeHooks();
		// A non-.json write target avoids the extension-based `config` zone
		// classification (zone-classifier.ts:83-98), which would block the
		// write regardless of cwd and mask the containment-anchoring bug.
		const lane = provisionNestedLane(
			'nested-lane-swarm',
			'child-nested-swarm',
			['.swarm/outputs/report.md'],
		);

		// Pre-fix: cwd === projectRoot. The target normalizes to
		// "nested-lane-swarm/.swarm/outputs/report.md", which does NOT start
		// with the literal blockedPrefix ".swarm/" (it starts with the lane
		// name), so the coder blockedPrefix rule ['.swarm/'] never matched and
		// the write was incorrectly ALLOWED.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'child-nested-swarm', callID: 'w3' },
				{
					args: {
						filePath: path.join(lane, '.swarm', 'outputs', 'report.md'),
						content: 'x',
					},
				},
			),
		).rejects.toThrow(/WRITE BLOCKED.*under \.swarm\//);
	});

	test('6a. BASELINE: non-worktree coder in-scope write is unchanged (no recorded root)', async () => {
		const hooks = makeHooks();
		const id = 'root-coder-ok';
		startAgentSession(id, 'coder');
		installActiveScopeBinding({
			directory: projectRoot,
			childSessionId: id,
			taskId: '1.1',
			files: [TASK_FILE],
		});
		expect(
			swarmState.agentSessions.get(id)?.workspaceDirectory,
		).toBeUndefined();

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'w4' },
				{ args: { filePath: TASK_FILE, content: 'ok' } },
			),
		).resolves.toBeUndefined();
	});

	test('6b. BASELINE: non-worktree coder out-of-scope shell write is unchanged (still blocked)', async () => {
		const hooks = makeHooks();
		const id = 'root-coder-oos';
		startAgentSession(id, 'coder');
		installActiveScopeBinding({
			directory: projectRoot,
			childSessionId: id,
			taskId: '1.1',
			files: [TASK_FILE],
		});

		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: id, callID: 'sh3' },
				{ args: { command: 'echo hi > src/forbidden.ts' } },
			),
		).rejects.toThrow('bash write detected outside declared scope:');
	});

	test('7a. BASELINE: direct write with no active agent registered fails closed', async () => {
		const hooks = makeHooks();

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'never-registered-direct', callID: 'w5' },
				{ args: { filePath: 'src/x.ts', content: 'x' } },
			),
		).rejects.toThrow(/No active agent registered/);
	});

	test('7b. BASELINE: shell write with no active agent registered fails closed', async () => {
		const hooks = makeHooks();

		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'never-registered-shell', callID: 'sh4' },
				{ args: { command: 'echo hi > src/x.ts' } },
			),
		).rejects.toThrow(/No active agent registered/);
	});

	test('8. REGRESSION #2002: a lane root recorded for an unregistered session must not fail-open the write gate', async () => {
		// Simulates a caller that calls recordSessionWorkspaceRoot WITHOUT
		// registering the session first — the exact shape of the prior bug
		// (recordSessionWorkspaceRoot used to call ensureAgentSession(sessionId)
		// with no agent name, silently creating an 'unknown'-agent session).
		// 'unknown' is truthy, so it used to clear the "No active agent
		// registered" guard below and let the write proceed unenforced. Unlike
		// tests 1-7 above, this test does NOT pre-register the session — it
		// exercises recordSessionWorkspaceRoot's own no-op contract, not just
		// call ordering.
		const hooks = makeHooks();
		const id = 'phantom-lane-child';
		const lane = path.join(laneBase, 'lane-phantom');
		fs.mkdirSync(lane, { recursive: true });

		recordSessionWorkspaceRoot(id, lane);
		expect(swarmState.agentSessions.has(id)).toBe(false);
		expect(swarmState.activeAgent.get(id)).toBeUndefined();

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'w-phantom' },
				{ args: { filePath: 'src/anything.ts', content: 'no' } },
			),
		).rejects.toThrow(/No active agent registered/);
	});
});
