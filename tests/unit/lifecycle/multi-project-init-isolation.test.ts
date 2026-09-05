/**
 * Multi-project init isolation (issue #2472 W10 / AC-13): two project
 * directories initialized in ONE bun:test process must not steal each other's
 * process-global ownership.
 *
 * The defect class (fixed by workstream W9): several module-level slots
 * (telemetry's latched project directory, the PR-subscriber lazy-start
 * callback, the shared provider pool) were process-global with first-writer
 * semantics, so the second project's init silently orphaned the first
 * project's handles. The three obligations pinned here:
 *
 *  (a) telemetry ownership — after init A + init B + an emitted event, BOTH
 *      A/.swarm/telemetry.jsonl and B/.swarm/telemetry.jsonl exist and B's
 *      stream receives the event emitted after B's init (re-home contract).
 *  (b) subscription retain-and-invoke — setOnSubscriptionCreated returns the
 *      PREVIOUS callback so re-registration can retain and invoke it (direct
 *      unit assertion, mirroring frozen check-c10 part ii).
 *  (c) scoped teardown — disposing project B's plugin leaves project A's
 *      plugin functional (its composed tool.execute.after still completes)
 *      and evicts ONLY B's pooled provider entry (dispose routes through the
 *      scoped evictAndClose, never the process-wide clearPool). The pool has
 *      no size/introspection export, so scoping is observed behaviorally:
 *      re-acquiring B's provider yields a NEW object (entry was evicted) while
 *      re-acquiring A's yields the SAME object (entry survived B's dispose).
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setOnSubscriptionCreated } from '../../../src/background/pr-subscriptions';
import OpenCodeSwarm from '../../../src/index';
import { DEFAULT_MEMORY_CONFIG } from '../../../src/memory/config';
import {
	evictAndClose,
	getOrCreateProvider,
} from '../../../src/memory/provider-pool';
import { emit, resetTelemetryForTesting } from '../../../src/telemetry';
import {
	createIndexCommandsModuleGuards,
	type MockPluginInput,
} from '../../helpers/index-commands-shared.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// File-scoped guard (PR #2173 F-006): stop post-resolution background tasks
// from re-creating removed temp dirs. Init and the composed hook chain run for
// real; only task SCHEDULING is neutralized.
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
		{ output: 'multi-project fixture output', metadata: {} },
	);
}

/** Generous poll for filesystem observations (async append streams). */
async function pollUntil(
	predicate: () => boolean,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const start = performance.now();
	while (performance.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!predicate()) {
		throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
	}
}

function readOrEmpty(filePath: string): string {
	try {
		return readFileSync(filePath, 'utf-8');
	} catch {
		return '';
	}
}

describe('multi-project init isolation (issue #2472 W10 / AC-13)', () => {
	let dirA = '';
	let dirB = '';
	let cleanupIsolatedEnv: () => void = () => {};

	beforeEach(() => {
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
		dirA = canonicalMkdtemp('swarm-multi-a-');
		dirB = canonicalMkdtemp('swarm-multi-b-');
		writeProjectConfig(dirA);
		writeProjectConfig(dirB);
	});

	afterEach(() => {
		resetTelemetryForTesting();
		safeRmRecursive(dirA);
		safeRmRecursive(dirB);
		cleanupIsolatedEnv();
		cleanupIsolatedEnv = () => {};
	});

	test('(a) telemetry re-homes per project: both telemetry.jsonl files exist and the post-B event lands in B', async () => {
		resetTelemetryForTesting();
		const pluginA = await bootPlugin(dirA);
		const pluginB = await bootPlugin(dirB);

		const marker = `multi-project-isolation-${performance.now()}`;
		emit('session_started', { sessionId: marker });

		const telemetryA = path.join(dirA, '.swarm', 'telemetry.jsonl');
		const telemetryB = path.join(dirB, '.swarm', 'telemetry.jsonl');

		// Append streams open asynchronously; poll generously for BOTH files.
		await pollUntil(
			() => existsSync(telemetryA) && existsSync(telemetryB),
			5_000,
			`both projects' telemetry files to exist (A: ${telemetryA}, B: ${telemetryB})`,
		);
		// B owns the active stream after its init — the emitted event must
		// land in B's file (the base bug latched A forever and B's file was
		// never even created).
		await pollUntil(
			() => readOrEmpty(telemetryB).includes(marker),
			5_000,
			`the event emitted after init B to be written to ${telemetryB}`,
		);

		// Hygiene: dispose BOTH instances so the exit-cleanup registry
		// empties and the shared process listeners are removed — otherwise
		// this file leaks a live dispatcher into any later test file that
		// runs in the same bun process (observed in the 4-file combined
		// run: the restart-roundtrip listener baseline shifted).
		await expect(pluginA.dispose()).resolves.toBeUndefined();
		await expect(pluginB.dispose()).resolves.toBeUndefined();
	}, 60_000);

	test('(b) setOnSubscriptionCreated returns the previous callback (retain-and-invoke contract)', () => {
		const sentinelFirst = () => {};
		const sentinelSecond = () => {};
		const neutral = () => {};
		setOnSubscriptionCreated(sentinelFirst);
		const previous = setOnSubscriptionCreated(sentinelSecond);
		// Restore a neutral callback regardless of the assertion outcome so
		// this direct module-state poke cannot leak into other tests.
		setOnSubscriptionCreated(neutral);
		expect(
			previous,
			`setOnSubscriptionCreated must return the previously-registered callback on re-registration so the new instance can retain-and-invoke it (got ${String(previous)})`,
		).toBe(sentinelFirst);
	});

	test('(c) disposing project B leaves project A functional and evicts only B\u2019s pooled provider', async () => {
		resetTelemetryForTesting();
		const pluginA = await bootPlugin(dirA);
		const pluginB = await bootPlugin(dirB);

		// Seed pooled providers for BOTH directories. The pool constructor
		// performs no I/O (config stored only), so this is a cheap, real
		// acquisition through the production path.
		const memoryConfig = { ...DEFAULT_MEMORY_CONFIG };
		const providerA1 = getOrCreateProvider(dirA, memoryConfig);
		const providerB1 = getOrCreateProvider(dirB, memoryConfig);

		// Dispose ONLY project B's plugin instance.
		await expect(pluginB.dispose()).resolves.toBeUndefined();

		// A's composed chain still completes after B's teardown.
		await invokeReadToolAfter(
			pluginA,
			'multi-project-isolation-a',
			'multi-project-call-a-1',
			path.join(dirA, '.opencode', 'opencode-swarm.json'),
		);

		// Scoped eviction, observed behaviorally: re-acquiring A's
		// provider returns the SAME (surviving) entry; re-acquiring B's
		// returns a NEW object because B's entry was evicted by its
		// dispose. If dispose had used the process-wide clearPool, A's
		// re-acquisition would ALSO be a new object.
		const providerA2 = getOrCreateProvider(dirA, memoryConfig);
		expect(
			providerA2,
			"project A's pooled provider must survive project B's dispose (dispose must use scoped evictAndClose, never clearPool)",
		).toBe(providerA1);
		const providerB2 = getOrCreateProvider(dirB, memoryConfig);
		expect(
			providerB2,
			"project B's pooled provider must be evicted by B's own dispose",
		).not.toBe(providerB1);

		// Teardown: release the test-seeded pool entries and dispose A so
		// the exit-cleanup registry empties for subsequent test files.
		evictAndClose(dirA);
		evictAndClose(dirB);
		await expect(pluginA.dispose()).resolves.toBeUndefined();
	}, 60_000);
});
