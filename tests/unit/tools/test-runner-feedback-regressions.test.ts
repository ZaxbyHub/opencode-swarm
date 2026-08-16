import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	runTests,
	test_runner,
} from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalSpawn = _internals.bunSpawn;
const originalAvailable = _internals.isCommandAvailable;
const tempDirs: string[] = [];

function makeRoot(prefix: string): string {
	const root = canonicalMkdtemp(prefix);
	tempDirs.push(root);
	fs.mkdirSync(path.join(root, '.git'));
	return root;
}

function delayedStream(text: string, closeDelayMs: number) {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.length > 0) controller.enqueue(bytes);
			setTimeout(() => controller.close(), closeDelayMs);
		},
	});
}

function immediateStream(text: string) {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.length > 0) controller.enqueue(bytes);
			controller.close();
		},
	});
}

function installSpawnStub(
	calls: Array<{ cmd: string[]; options: unknown }>,
	stdout = '--- PASS: TestOnly (0.00s)',
) {
	_internals.bunSpawn = ((cmd: string[], options?: unknown) => {
		calls.push({ cmd, options });
		return {
			stdout: immediateStream(stdout),
			stderr: immediateStream(''),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => {},
			killTree: async () => {},
		};
	}) as typeof _internals.bunSpawn;
}

describe('test-runner feedback regressions', () => {
	afterEach(() => {
		_internals.bunSpawn = originalSpawn;
		_internals.isCommandAvailable = originalAvailable;
		delete process.env.SWARM_LANG_BACKEND;
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('FB-006 snapshots exit-before-timeout classification before bounded stream drains finish', async () => {
		// Previous code read the timeout flag after stream draining, so an exit that won
		// the race could still be reported as a timeout if the passive deadline fired later.
		const root = makeRoot('swarm-runner-fb006-');
		fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/fb006\n');
		_internals.isCommandAvailable = (() =>
			true) as typeof _internals.isCommandAvailable;
		_internals.bunSpawn = ((cmd: string[], options?: unknown) => {
			void cmd;
			void options;
			return {
				stdout: delayedStream('--- PASS: TestOnly (0.00s)', 15),
				stderr: delayedStream('', 15),
				exited: new Promise<number>((resolve) =>
					setTimeout(() => resolve(0), 1),
				),
				exitCode: 0,
				kill: () => {},
				killTree: async () => {},
			};
		}) as typeof _internals.bunSpawn;

		const result = await runTests(
			'go-test',
			'target',
			[],
			false,
			5,
			root,
			false,
			{ framework: 'go-test', name: 'TestOnly', path: '.' },
		);

		expect(result).toMatchObject({
			success: true,
			message: 'go-test tests passed (1/1)',
		});
	});

	it('FB-007 fails closed for target-scope files, coverage, bail, and absolute paths without spawning', async () => {
		// Previous direct runTests callers could hand invalid target-mode inputs to the
		// runtime body and still reach command construction or fallback behavior.
		const root = makeRoot('swarm-runner-fb007-');
		fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/fb007\n');
		fs.mkdirSync(path.join(root, 'pkg'));
		_internals.isCommandAvailable = (() =>
			true) as typeof _internals.isCommandAvailable;
		const calls: Array<{ cmd: string[]; options: unknown }> = [];
		installSpawnStub(calls);

		for (const invocation of [
			() =>
				runTests(
					'go-test',
					'target',
					['pkg/thing_test.go'],
					false,
					1_000,
					root,
					false,
					{
						framework: 'go-test',
						name: 'TestOnly',
						path: 'pkg',
					},
				),
			() =>
				runTests('go-test', 'target', [], true, 1_000, root, false, {
					framework: 'go-test',
					name: 'TestOnly',
					path: 'pkg',
				}),
			() =>
				runTests('go-test', 'target', [], false, 1_000, root, true, {
					framework: 'go-test',
					name: 'TestOnly',
					path: 'pkg',
				}),
			() =>
				runTests('go-test', 'target', [], false, 1_000, root, false, {
					framework: 'go-test',
					name: 'TestOnly',
					path: path.join(root, 'pkg'),
				}),
		]) {
			expect(await invocation()).toMatchObject({
				success: false,
				outcome: 'error',
			});
		}

		expect(calls).toHaveLength(0);
	});

	it('FB-001 rejects an absolute tool native_target.path before spawning', async () => {
		const root = makeRoot('swarm-runner-fb001-');
		fs.mkdirSync(path.join(root, 'build'));
		const calls: Array<{ cmd: string[]; options: unknown }> = [];
		installSpawnStub(calls);

		const raw = await test_runner.execute(
			{
				scope: 'target',
				native_target: {
					framework: 'ctest',
					name: 'x',
					path: path.join(root, 'build'),
				},
			},
			{ directory: root } as never,
		);

		expect(JSON.parse(raw as string)).toMatchObject({
			success: false,
			error: 'Invalid arguments',
		});
		expect(calls).toHaveLength(0);
	});

	it('FB-001/FB-007 rejects canonical symlink escapes in direct runTests target mode without spawning', async () => {
		// Previous safety checks were concentrated in execute(); direct runTests callers
		// needed the same canonical containment guard to reject symlink escapes.
		const root = makeRoot('swarm-runner-fb008-root-');
		const outside = makeRoot('swarm-runner-fb008-outside-');
		fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/fb008\n');
		fs.mkdirSync(path.join(outside, 'pkg'));
		fs.symlinkSync(
			outside,
			path.join(root, 'linked-pkg'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		_internals.isCommandAvailable = (() =>
			true) as typeof _internals.isCommandAvailable;
		const calls: Array<{ cmd: string[]; options: unknown }> = [];
		installSpawnStub(calls);

		const result = await runTests(
			'go-test',
			'target',
			[],
			false,
			1_000,
			root,
			false,
			{ framework: 'go-test', name: 'TestOnly', path: 'linked-pkg' },
		);

		expect(result).toMatchObject({
			success: false,
			error: 'Native target path escapes project root',
		});
		expect(calls).toHaveLength(0);
	});

	it('FB-012 reports all-skipped native-target success without claiming passes', async () => {
		// Previous success text said "passed (0/1)" for an exact skipped target, which
		// read like a false green even though the target only reported SKIP.
		const root = makeRoot('swarm-runner-fb010-');
		fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/fb010\n');
		_internals.isCommandAvailable = (() =>
			true) as typeof _internals.isCommandAvailable;
		const calls: Array<{ cmd: string[]; options: unknown }> = [];
		installSpawnStub(calls, '--- SKIP: TestOnly (0.00s)\nPASS');

		const result = await runTests(
			'go-test',
			'target',
			[],
			false,
			1_000,
			root,
			false,
			{ framework: 'go-test', name: 'TestOnly', path: '.' },
		);

		expect(result).toMatchObject({
			success: true,
			message: 'go-test tests completed with 1 skipped (1 total)',
		});
		expect(calls).toHaveLength(1);
	});

	it('AC-2174 reports a disabled exact CTest target as skipped in dispatch and legacy modes', async () => {
		const root = makeRoot('swarm-runner-ctest-disabled-');
		fs.mkdirSync(path.join(root, 'build'));
		fs.writeFileSync(path.join(root, 'build', 'CMakeCache.txt'), 'fixture');
		_internals.isCommandAvailable = (() =>
			true) as typeof _internals.isCommandAvailable;
		const output = [
			'Test project /fixture/build',
			'    Start 1: DisabledCase',
			'1/1 Test #1: DisabledCase .....................***Not Run (Disabled)  0.00 sec',
			'100% tests passed, 0 tests failed out of 0',
		].join('\n');

		for (const mode of ['dispatch', 'legacy'] as const) {
			process.env.SWARM_LANG_BACKEND = mode;
			const calls: Array<{ cmd: string[]; options: unknown }> = [];
			installSpawnStub(calls, output);

			const result = await runTests(
				'ctest',
				'target',
				[],
				false,
				1_000,
				root,
				false,
				{ framework: 'ctest', name: 'DisabledCase', path: 'build' },
			);

			expect(result).toMatchObject({
				success: true,
				totals: { total: 1, passed: 0, failed: 0, skipped: 1 },
				message: 'ctest tests completed with 1 skipped (1 total)',
			});
			expect(calls).toHaveLength(1);
		}
	});

	it('FB-013 formats native history keys deterministically and without path-name # collisions', () => {
		// Previous keys used `${path}#${name}`, so literal `#` characters could collide
		// across different path/name pairs and blur history attribution.
		const first = _internals.formatNativeHistoryTestFile(
			{ framework: 'ctest', name: 'suite', path: 'build#alpha' },
			'build#alpha',
		);
		const second = _internals.formatNativeHistoryTestFile(
			{ framework: 'ctest', name: 'alpha#suite', path: 'build' },
			'build',
		);

		expect(first).toBe('native:ctest:path=build%23alpha#name=suite');
		expect(second).toBe('native:ctest:path=build#name=alpha%23suite');
		expect(first).not.toBe(second);
	});

	it('FB-008 restores the tool metadata contract and appends exact native-target guidance', () => {
		expect(test_runner.description).toContain(
			'automatic framework detection for bun, vitest, jest, mocha, pytest, cargo, pester, go test, maven, gradle, dotnet test, ctest, swift test, dart test, rspec, minitest, pest, phpunit, or php-artisan',
		);
		expect(test_runner.description).toContain(
			'Returns JSON with success, framework, scope, command, timeout_ms, duration_ms, totals, outcome',
		);
		expect(test_runner.description).toContain(
			'Scope "target" runs one exact Go test/subtest or CTest name via native_target',
		);
		expect(test_runner.args.scope.description).toContain(
			'"all" runs the full suite, "convention"/"graph"/"impact" resolve files, and "target" runs one exact Go or CTest native name without file fallback',
		);
		expect(test_runner.args.native_target.description).toContain(
			'Absolute paths, traversal, coverage, bail, and broad fallback are rejected',
		);
	});
});
