/**
 * Plugin restart roundtrip (issue #2472 W10 / AC-12): server() init → dispose →
 * re-init in ONE bun:test process.
 *
 * The defect class (fixed by workstream W9): every server() instance
 * registered its own process 'exit' listener and never removed it, so a plugin
 * restart (host re-init in the same process) accumulated listeners against
 * torn-down closures, and dispose left them stale. The once-guarded dispatcher
 * + per-instance registry must keep listener counts bounded across restarts.
 *
 * Observable seams used here (no mock.module, real boots):
 *  - `process.listenerCount('exit' | 'SIGINT' | 'SIGTERM')`: the shared
 *    dispatcher registers exactly one of each while any instance is live and
 *    removes them when the registry empties (src/index.ts — the ONLY
 *    process.on registration site in src/, verified by grep).
 *  - `hooks.dispose()` resolving without throwing: dispose invokes the
 *    idempotent cleanupAutomation (worker stops, durable-state closes) — a
 *    synchronous throw there would reject the promise.
 *  - the composed `tool.execute.after` handler completing on a read-tool call:
 *    proves the re-initialized plugin is functional, not just loadable.
 *
 * Timing: no latency assertions — only listener-count equality (stateless of
 * scheduling) and a generous poll nowhere needed here.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import OpenCodeSwarm from '../../../src/index';
import { resetTelemetryForTesting } from '../../../src/telemetry';
import {
	createIndexCommandsModuleGuards,
	type MockPluginInput,
} from '../../helpers/index-commands-shared.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// File-scoped guard (PR #2173 F-006 precedent from tests/unit/index.test.ts):
// neutralize the post-resolution task queue so background init work cannot
// fire after afterEach removed the temp dir and recreate it as an orphan.
// This stubs task SCHEDULING only — the full server() init and the entire
// composed tool.execute.after chain run for real.
const moduleGuards = createIndexCommandsModuleGuards();

beforeAll(moduleGuards.setUpAll);
afterAll(moduleGuards.tearDownAll);

type ToolAfterHandler = (
	input: unknown,
	output: unknown,
) => Promise<unknown> | unknown;

interface BootedPlugin {
	dispose: () => Promise<void>;
	'tool.execute.after'?: ToolAfterHandler;
}

function pluginInputFor(directory: string): MockPluginInput {
	return {
		client: {},
		project: {},
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {},
	};
}

/** Minimal project config: no version-check network calls, quiet stderr. */
function writeProjectConfig(directory: string): string {
	const opencodeDir = path.join(directory, '.opencode');
	mkdirSync(opencodeDir, { recursive: true });
	const configPath = path.join(opencodeDir, 'opencode-swarm.json');
	writeFileSync(
		configPath,
		JSON.stringify({ version_check: false, quiet: true }, null, 2),
	);
	return configPath;
}

async function bootPlugin(directory: string): Promise<BootedPlugin> {
	const result = await OpenCodeSwarm.server(pluginInputFor(directory) as any);
	return result as unknown as BootedPlugin;
}

/** Invoke the REAL composed tool.execute.after chain on a read-tool call. */
async function invokeReadToolAfter(
	plugin: BootedPlugin,
	sessionID: string,
	callID: string,
	filePath: string,
): Promise<void> {
	const handler = plugin['tool.execute.after'];
	if (typeof handler !== 'function') {
		throw new Error(
			'booted plugin result has no tool.execute.after handler surface',
		);
	}
	await handler(
		{
			tool: 'read',
			sessionID,
			callID,
			args: { file_path: filePath },
		},
		{ output: 'restart-roundtrip fixture output', metadata: {} },
	);
}

function listenerSnapshot(): {
	exit: number;
	sigint: number;
	sigterm: number;
} {
	return {
		exit: process.listenerCount('exit'),
		sigint: process.listenerCount('SIGINT'),
		sigterm: process.listenerCount('SIGTERM'),
	};
}

describe('plugin restart roundtrip (issue #2472 W10 / AC-12)', () => {
	let tempDir = '';
	let cleanupIsolatedEnv: () => void = () => {};

	beforeEach(() => {
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
		tempDir = canonicalMkdtemp('swarm-restart-');
		writeProjectConfig(tempDir);
	});

	afterEach(() => {
		// End the telemetry append stream BEFORE removing the temp dir — an
		// open stream handle makes Windows rmSync fail EBUSY.
		resetTelemetryForTesting();
		safeRmRecursive(tempDir);
		cleanupIsolatedEnv();
		cleanupIsolatedEnv = () => {};
	});

	test('init → dispose → re-init keeps process listeners bounded, re-init is functional, double-dispose is safe', async () => {
		const baseline = listenerSnapshot();
		const configPath = path.join(tempDir, '.opencode', 'opencode-swarm.json');

		// --- first init: the shared once-guarded dispatcher registers
		// exactly one 'exit' + SIGINT + SIGTERM listener.
		const first = await bootPlugin(tempDir);
		expect(
			typeof first['tool.execute.after'],
			'first boot must expose the composed tool.execute.after handler',
		).toBe('function');
		expect(typeof first.dispose).toBe('function');

		const afterFirstInit = listenerSnapshot();
		expect(
			afterFirstInit.exit,
			`after first init: expected exactly one shared 'exit' listener (baseline ${baseline.exit} + 1), got ${afterFirstInit.exit} — per-instance registration is accumulating`,
		).toBe(baseline.exit + 1);
		expect(
			afterFirstInit.sigint,
			`after first init: expected exactly one SIGINT listener (baseline ${baseline.sigint} + 1), got ${afterFirstInit.sigint}`,
		).toBe(baseline.sigint + 1);
		expect(
			afterFirstInit.sigterm,
			`after first init: expected exactly one SIGTERM listener (baseline ${baseline.sigterm} + 1), got ${afterFirstInit.sigterm}`,
		).toBe(baseline.sigterm + 1);

		// --- dispose: workers stopped via the idempotent cleanup (a
		// synchronous failure would reject this promise), and the shared
		// process listeners are removed once the registry empties.
		await expect(first.dispose()).resolves.toBeUndefined();

		const afterFirstDispose = listenerSnapshot();
		expect(
			afterFirstDispose.exit,
			`after dispose: 'exit' listeners must return to baseline ${baseline.exit}, got ${afterFirstDispose.exit} — dispose left the shared dispatcher registered`,
		).toBe(baseline.exit);
		expect(afterFirstDispose.sigint).toBe(baseline.sigint);
		expect(afterFirstDispose.sigterm).toBe(baseline.sigterm);

		// --- re-init (plugin restart in the same process).
		const second = await bootPlugin(tempDir);
		const afterSecondInit = listenerSnapshot();
		expect(
			afterSecondInit.exit,
			`after re-init: 'exit' listeners must not grow vs the first init (${afterFirstInit.exit}), got ${afterSecondInit.exit} — restart is accumulating listeners`,
		).toBe(afterFirstInit.exit);
		expect(afterSecondInit.exit).toBe(baseline.exit + 1);
		expect(afterSecondInit.sigint).toBe(afterFirstInit.sigint);
		expect(afterSecondInit.sigterm).toBe(afterFirstInit.sigterm);

		// --- re-init is functional: the REAL composed chain completes on a
		// read-tool call without throwing.
		await invokeReadToolAfter(
			second,
			'restart-roundtrip-session',
			'restart-roundtrip-call-1',
			configPath,
		);

		// --- double dispose is safe (idempotent cleanup, no throw).
		await expect(second.dispose()).resolves.toBeUndefined();
		await expect(second.dispose()).resolves.toBeUndefined();

		const afterSecondDispose = listenerSnapshot();
		expect(afterSecondDispose.exit).toBe(baseline.exit);
		expect(afterSecondDispose.sigint).toBe(baseline.sigint);
		expect(afterSecondDispose.sigterm).toBe(baseline.sigterm);
	}, 60_000);
});
