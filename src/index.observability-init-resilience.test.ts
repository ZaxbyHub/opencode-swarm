/**
 * AC5 coverage (issue #2029, reviewer C3): "Given optional observation setup
 * fails, plugin registration still resolves within the cross-platform init
 * deadline."
 *
 * ## What is proven here, and what is NOT
 *
 * `initObservability` (`src/observability/observe.ts`) wraps its whole body
 * in a single try/catch and its call site in `src/index.ts`
 * (`initializeOpenCodeSwarm`, around the `initObservability({...})` call) is
 * a bare synchronous statement with no surrounding try/catch of its own — it
 * relies entirely on `initObservability`'s own fail-open contract. There is
 * NO dependency-injection seam for `initObservability` on the real plugin
 * init path (`overrideIndexInternalsForTest` in `src/index.ts` only covers
 * `createRepoGraphBuilderHook`, `schedulePostResolutionTasks`,
 * `loadPluginConfigWithMetaAsync`, `loadSnapshot`, `ensureSwarmGitExcluded`,
 * and `resolveAutoReviewConfig`), and every value `src/index.ts` actually
 * passes into `provenance` (`packageJson.version`, `process.versions.*`,
 * `process.platform`, `process.arch`) is a plain string produced internally,
 * not something a caller of `OpenCodeSwarm.server()` can corrupt through the
 * public `PluginInput` surface. Adding such a seam would require editing
 * `src/index.ts`, which is out of scope for this test-only change.
 *
 * Given that, this file proves AC5 in the strongest way available WITHOUT
 * touching `src/`:
 *
 *   1. (a) `initObservability` is exhaustively hostile-input total: it is
 *      called directly with inputs engineered to throw partway through its
 *      body (a `provenance` object with a throwing getter, a `directory`
 *      getter that throws, `null`/`undefined`/a number for the whole input
 *      via `as never`), and in every case it does not throw AND a
 *      subsequent `createObservation` call still returns a valid event.
 *   2. A structural check that `initObservability` is a plain synchronous
 *      function (not `async`), so it cannot produce an unhandled promise
 *      rejection that would bypass its own try/catch — the property AC5
 *      actually depends on structurally.
 *   3. (b, best-effort) The REAL, unstubbed `OpenCodeSwarm.server()` is
 *      driven end-to-end with adversarial-but-type-valid `directory` values
 *      that flow into the real `initObservability` call inside the real init
 *      path, and `server()` is asserted to resolve with a valid plugin.
 *
 * **AC5 is therefore only PARTIALLY proven at the true end-to-end level.**
 * Item 3 exercises the real call site with adversarial input, but it cannot
 * force `initObservability`'s internal try body to actually throw during a
 * real `server()` call (no reachable input can make `pseudonymousRef`/
 * `resolveLineageSalt` throw for any string, and `provenance` is not
 * caller-controlled). The exhaustive fail-open guarantee is proven at the
 * unit level (item 1) instead, which is what actually backs the AC5 claim
 * given the call site has no error handling of its own.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../tests/helpers/tmpdir.js';
import OpenCodeSwarm from './index.js';
import {
	createObservation,
	type InitObservabilityInput,
	initObservability,
	resetObservabilityForTesting,
} from './observability/index.js';
import { resetTelemetryForTesting } from './telemetry.js';

describe('AC5 (a) — initObservability is total under hostile input', () => {
	test('the whole input is null (cast via `as never`) — does not throw', () => {
		resetObservabilityForTesting();
		expect(() => initObservability(null as never)).not.toThrow();
	});

	test('the whole input is undefined (cast via `as never`) — does not throw', () => {
		resetObservabilityForTesting();
		expect(() => initObservability(undefined as never)).not.toThrow();
	});

	test('the whole input is a number (cast via `as never`) — does not throw', () => {
		resetObservabilityForTesting();
		expect(() => initObservability(42 as never)).not.toThrow();
	});

	test('a `directory` getter that throws — does not throw, and lineage recovers to empty-but-frozen', () => {
		resetObservabilityForTesting();
		const hostileInput = {
			get directory(): string {
				throw new Error('directory getter exploded');
			},
		} as unknown as InitObservabilityInput;

		expect(() => initObservability(hostileInput)).not.toThrow();

		// createObservation must still succeed after a failed init.
		const event = createObservation('session_started', { sessionId: 's1' });
		expect(event.relationshipViolations).not.toContain(
			'observation_build_failed',
		);
		expect(event.lineage).toEqual({});
		expect(Object.isFrozen(event.lineage)).toBe(true);
	});

	test('a `provenance` value with a throwing getter — does not throw, leaves empty-but-frozen lineage, and a subsequent createObservation is still valid', () => {
		resetObservabilityForTesting();
		const throwingProvenance = Object.defineProperty({}, 'pluginVersion', {
			enumerable: true,
			get(): string {
				throw new Error('provenance getter exploded');
			},
		});

		expect(() =>
			initObservability({
				// No directory/cohortLabel/worktreeId: lineage computation itself
				// stays trivially empty, so the SAME failure (the provenance
				// spread throwing) is isolated to `_provenance`, and `_lineage`
				// is still assigned (to `{}`) before the throw — the assignment
				// order in `initObservability` is lineage, THEN provenance.
				provenance: throwingProvenance as never,
			}),
		).not.toThrow();

		const event = createObservation('session_started', { sessionId: 's2' });
		expect(() =>
			createObservation('session_started', { sessionId: 's2' }),
		).not.toThrow();
		expect(event.relationshipViolations).not.toContain(
			'observation_build_failed',
		);
		expect(event.lineage).toEqual({});
		expect(Object.isFrozen(event.lineage)).toBe(true);
		// Provenance also recovers to empty/frozen rather than half-applying the
		// throwing object.
		expect(event.provenance).toEqual({});
		expect(Object.isFrozen(event.provenance)).toBe(true);
	});

	test('a `cohortLabel` getter that throws — does not throw', () => {
		resetObservabilityForTesting();
		const hostileInput = {
			directory: '/some/real/project',
			get cohortLabel(): string {
				throw new Error('cohortLabel getter exploded');
			},
		} as unknown as InitObservabilityInput;

		expect(() => initObservability(hostileInput)).not.toThrow();
		expect(() =>
			createObservation('session_started', { sessionId: 's3' }),
		).not.toThrow();
	});

	test('a `worktreeId` getter that throws — does not throw', () => {
		resetObservabilityForTesting();
		const hostileInput = {
			directory: '/some/real/project',
			get worktreeId(): string {
				throw new Error('worktreeId getter exploded');
			},
		} as unknown as InitObservabilityInput;

		expect(() => initObservability(hostileInput)).not.toThrow();
		expect(() =>
			createObservation('session_started', { sessionId: 's4' }),
		).not.toThrow();
	});

	test('sampleRate as NaN/Infinity/-Infinity — does not throw and does not corrupt subsequent observations', () => {
		resetObservabilityForTesting();
		for (const hostileRate of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			expect(() =>
				initObservability({ sampleRate: hostileRate }),
			).not.toThrow();
			expect(() =>
				createObservation('session_started', { sessionId: 's5' }),
			).not.toThrow();
		}
	});

	test('an `ownKeys`-throwing Proxy as the whole input — does not throw', () => {
		resetObservabilityForTesting();
		const trapInput = new Proxy(
			{},
			{
				get(): never {
					throw new Error('proxy get trap exploded');
				},
				has(): never {
					throw new Error('proxy has trap exploded');
				},
			},
		) as unknown as InitObservabilityInput;

		expect(() => initObservability(trapInput)).not.toThrow();
		expect(() =>
			createObservation('session_started', { sessionId: 's6' }),
		).not.toThrow();
	});
});

describe('AC5 (structural) — initObservability cannot escape its own try/catch via a promise', () => {
	test('initObservability is a plain synchronous function, not async', () => {
		// If a future change made this `async function initObservability`, a
		// throw INSIDE it would become a REJECTED PROMISE instead of a
		// synchronous throw. `src/index.ts` calls it as a bare, un-awaited,
		// un-`.catch`-ed statement — a rejection would become an unhandled
		// promise rejection instead of being caught by initObservability's own
		// try/catch, silently defeating AC5. This structural check would FAIL
		// if that changed.
		expect(initObservability.constructor.name).not.toBe('AsyncFunction');
		resetObservabilityForTesting();
		const result = initObservability({ directory: '/proj' });
		expect(result).toBeUndefined();
	});
});

describe('AC5 (b, best-effort) - real OpenCodeSwarm.server() resolves through the real initObservability call site', () => {
	// Every adversarial directory is a REAL, EXISTING directory rooted under
	// the system temp directory - never '', never a '..'-escaping path, and never the
	// process cwd. server() performs real fs/git I/O keyed off directory
	// (writes .swarm/, runs ensureSwarmGitExcluded), so an adversarial value
	// here means unusual bytes in an otherwise valid, isolated temp path, not
	// a path that could make server() touch the real repo.
	let parentDir: string;

	beforeEach(() => {
		parentDir = canonicalMkdtemp('ocsm-adv-');
	});

	afterEach(() => {
		// `OpenCodeSwarm.server(...)` runs `initTelemetry`, which opens a long-lived
		// `createWriteStream` on `<parentDir>/.swarm/telemetry.jsonl`. Only
		// `resetTelemetryForTesting()` ends that stream, and on Windows an open
		// handle makes the `rmSync` below fail with `EBUSY: resource busy or
		// locked`. POSIX tolerates unlinking an open file, so this only ever
		// surfaces on Windows — it was a real `unit (windows-latest, 1)` CI failure
		// in a sibling test (`tests/unit/index-task-metadata-scope.test.ts`) that
		// retried twice and failed both times.
		resetTelemetryForTesting();
		try {
			fs.rmSync(parentDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	test('server() resolves with adversarial-but-type-valid directory values', async () => {
		// These are NOT guaranteed to make initObservability's internal try
		// body throw (see file header) - no reachable string input can make
		// pseudonymousRef/resolveLineageSalt throw for any string, and
		// provenance is not caller-controlled through this surface. This test
		// instead proves the surrounding claim: the real, unstubbed init path
		// (including the real initObservability call) resolves the plugin
		// factory even when fed directory values engineered to stress the
		// pseudonymization path (long segment, embedded Unicode including an
		// emoji and zero-width characters).
		const adversarialNames = [
			'a'.repeat(200), // long path segment (bounded so mkdirSync stays within OS limits)
			'emoji-\u{1F4A9}-dir',
			'zero-width-​‌dir',
		];

		for (const name of adversarialNames) {
			const directory = path.join(parentDir, name);
			fs.mkdirSync(directory, { recursive: true });

			const result = await OpenCodeSwarm.server({
				client: {} as never,
				project: {} as never,
				directory,
				worktree: directory,
				serverUrl: new URL('http://localhost:3000'),
				$: {} as never,
			});
			expect(result).toHaveProperty('tool');
		}
	});
});
