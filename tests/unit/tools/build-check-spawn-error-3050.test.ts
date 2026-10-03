/**
 * Issue #3050 — `build_check` must surface the `bunSpawn` `spawnError` value
 * contract so a process-creation failure is distinguishable from a build that
 * ran and exited non-zero.
 *
 * The distinction matters because `spawnError` and `exitCode` are mutually
 * exclusive in the contract (`src/utils/bun-compat.ts:1048`, `:1247-1253`): a
 * failed spawn leaves `exitCode` null and resolves `exited` to the sentinel 1,
 * so `exit_code: exitCode ?? -1` records "exit 1" for both a launch failure and
 * a genuine build error. Without the extra field the verdict is still right
 * (`failed_count` still fires) but the persisted evidence cannot tell an
 * operator which happened — and a wrong fix that recorded `exit_code: 0` on a
 * launch failure would flip the verdict to `pass`.
 *
 * The suite deliberately asserts BOTH sides: the launch-failure row must carry
 * the reason, and the two control rows must NOT be labelled as launch failures.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, runBuildCheck } from '../../../src/tools/build-check';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** The sentinel `bunSpawn` resolves `exited` to on a creation failure. */
const SPAWN_CREATION_FAILURE_EXIT_CODE = 1;
const FAKE_REASON = 'spawn ENOENT definitely-missing-build-binary-3050';

const realSpawn = _internals.bunSpawn;
let tempDir: string;

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

function fakeProc(opts: {
	exitCode: number | null;
	exited: number;
	stdout?: string;
	spawnError?: Error;
}): ReturnType<typeof _internals.bunSpawn> {
	const enc = new TextEncoder();
	const stdout = opts.stdout ?? '';
	return {
		stdout: new ReadableStream({
			start(controller) {
				if (stdout) controller.enqueue(enc.encode(stdout));
				controller.close();
			},
		}),
		stderr: emptyStream(),
		exited: Promise.resolve(opts.exited),
		exitCode: opts.exitCode,
		...(opts.spawnError ? { spawnError: opts.spawnError } : {}),
		kill: () => {},
		killTree: async () => {},
	} as unknown as ReturnType<typeof _internals.bunSpawn>;
}

async function runWith(proc: ReturnType<typeof _internals.bunSpawn>) {
	_internals.bunSpawn = (() => proc) as typeof _internals.bunSpawn;
	try {
		return await runBuildCheck(tempDir, { scope: 'all', mode: 'build' });
	} finally {
		_internals.bunSpawn = realSpawn;
	}
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('build-check-spawn-3050-');
	// A Node project so discovery yields exactly one run. The php-composer
	// ecosystem requires `composer` on PATH, which is absent on many hosts and
	// would leave zero runs and make every assertion below vacuous. The spawn
	// itself is faked, so the discovered command never executes.
	fs.writeFileSync(
		path.join(tempDir, 'package.json'),
		JSON.stringify({
			name: 'build-check-3050-fixture',
			version: '1.0.0',
			scripts: { build: 'true' },
		}),
	);
});

afterEach(() => {
	_internals.bunSpawn = realSpawn;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('#3050: build_check reports a launch failure distinctly', () => {
	test('a process-creation failure carries spawn_error with the reason', async () => {
		const result = await runWith(
			fakeProc({
				exitCode: null,
				exited: SPAWN_CREATION_FAILURE_EXIT_CODE,
				spawnError: new Error(FAKE_REASON),
			}),
		);

		expect(result.runs.length).toBe(1);
		const run = result.runs[0]!;
		expect('spawn_error' in run).toBe(true);
		// Containment, not mere non-emptiness: a hardcoded 'spawn failed' string
		// would otherwise satisfy the test.
		expect(run.spawn_error).toContain('ENOENT');
		expect(run.spawn_error).toContain('definitely-missing-build-binary-3050');
	});

	test('the exit code and verdict are unchanged by the new field', async () => {
		const result = await runWith(
			fakeProc({
				exitCode: null,
				exited: SPAWN_CREATION_FAILURE_EXIT_CODE,
				spawnError: new Error(FAKE_REASON),
			}),
		);

		const run = result.runs[0]!;
		// Exactly the sentinel, not merely non-zero: a wrong fix recording 0 here
		// would flip the whole verdict to `pass` on a launch failure.
		expect(run.exit_code).toBe(SPAWN_CREATION_FAILURE_EXIT_CODE);
		expect(result.verdict).toBe('fail');
		expect(result.summary.failed_count).toBeGreaterThan(0);
	});
});

describe('#3050: build_check does not overcorrect', () => {
	test('a build that ran and exited non-zero keeps its exit code and gains no field', async () => {
		const result = await runWith(
			fakeProc({ exitCode: 2, exited: 2, stdout: 'build broke' }),
		);

		const run = result.runs[0]!;
		expect(run.exit_code).toBe(2);
		expect(run.spawn_error).toBeUndefined();
		// Absent, not present-but-null: "no launch failure" must stay
		// distinguishable from "field present but empty".
		expect('spawn_error' in run).toBe(false);
		expect(result.verdict).toBe('fail');
	});

	test('a successful build gains no field', async () => {
		const result = await runWith(fakeProc({ exitCode: 0, exited: 0 }));

		const run = result.runs[0]!;
		expect(run.exit_code).toBe(0);
		expect('spawn_error' in run).toBe(false);
		expect(result.verdict).toBe('pass');
	});

	test('a spawn error with an empty message emits no field', async () => {
		// The writer guards on the message, not merely on the Error being
		// truthy. Without this case a regression to `!== undefined` would emit
		// `spawn_error: ''` — a present-but-blank field, which is exactly the
		// state the field's own doc comment says must not happen.
		const result = await runWith(
			fakeProc({
				exitCode: null,
				exited: SPAWN_CREATION_FAILURE_EXIT_CODE,
				spawnError: new Error(''),
			}),
		);

		const run = result.runs[0]!;
		expect('spawn_error' in run).toBe(false);
		expect(run.exit_code).toBe(SPAWN_CREATION_FAILURE_EXIT_CODE);
	});
});
