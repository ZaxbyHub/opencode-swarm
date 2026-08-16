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

function stream(text: string) {
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
	kills = { direct: 0, tree: 0 },
	pending = false,
) {
	_internals.bunSpawn = ((cmd: string[], options?: unknown) => {
		calls.push({ cmd, options });
		let exitCode: number | null = pending ? null : 0;
		let resolveExited: (code: number) => void = () => {};
		const exited = pending
			? new Promise<number>((resolve) => {
					resolveExited = resolve;
				})
			: Promise.resolve(0);
		const subprocess = {
			stdout: stream(stdout),
			stderr: stream(''),
			exited,
			get exitCode() {
				return exitCode;
			},
			set exitCode(value: number | null) {
				exitCode = value;
			},
			kill: () => {
				kills.direct++;
				exitCode = -9;
				resolveExited(-9);
			},
			killTree: async () => {
				kills.tree++;
				exitCode = -9;
				resolveExited(-9);
			},
		};
		if (pending) {
			const timeout = (options as { timeout?: number } | undefined)?.timeout;
			if (timeout !== undefined) {
				setTimeout(() => void subprocess.killTree(), timeout);
			}
		}
		return subprocess;
	}) as typeof _internals.bunSpawn;
}

function makeRoot(): string {
	const root = canonicalMkdtemp('swarm-native-');
	tempDirs.push(root);
	fs.mkdirSync(path.join(root, '.git'));
	return root;
}

function makeGoRoot(packagePath = '.'): string {
	const root = makeRoot();
	fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/native\n');
	if (packagePath !== '.')
		fs.mkdirSync(path.join(root, packagePath), { recursive: true });
	_internals.isCommandAvailable = (() =>
		true) as typeof _internals.isCommandAvailable;
	return root;
}

function makeCTestRoot(buildPath = 'build'): string {
	const root = makeRoot();
	fs.mkdirSync(path.join(root, buildPath), { recursive: true });
	fs.writeFileSync(
		path.join(root, buildPath, 'CMakeCache.txt'),
		'# test cache\n',
	);
	_internals.isCommandAvailable = (() =>
		true) as typeof _internals.isCommandAvailable;
	return root;
}

describe('test_runner native targets', () => {
	afterEach(() => {
		delete process.env.SWARM_LANG_BACKEND;
		_internals.bunSpawn = originalSpawn;
		_internals.isCommandAvailable = originalAvailable;
		for (const dir of tempDirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});

	it('builds an exact Go test/subtest selector without broad fallback', () => {
		expect(
			_internals.buildNativeTargetCommand({
				framework: 'go-test',
				name: 'TestThing/case[1]',
				path: 'pkg/thing',
			}),
		).toEqual([
			'go',
			'test',
			'-v',
			'-run',
			'^TestThing$/^case\\[1\\]$',
			'./pkg/thing',
		]);
	});

	it('builds an exact CTest selector without broad fallback', () => {
		expect(
			_internals.buildNativeTargetCommand({
				framework: 'ctest',
				name: 'suite[1].case',
				path: 'build',
			}),
		).toEqual(['ctest', '--test-dir', 'build', '-R', '^suite\\[1\\]\\.case$']);
	});

	it('publishes target scope and native_target in the tool schema', () => {
		expect(test_runner.args.scope.safeParse('target').success).toBe(true);
		expect(
			test_runner.args.native_target.safeParse({
				framework: 'ctest',
				name: 'exact',
				path: 'build',
			}).success,
		).toBe(true);
	});

	for (const mode of ['dispatch', 'legacy'] as const) {
		it(`executes the exact Go selector in ${mode} mode with bounded spawn options`, async () => {
			const root = makeGoRoot('pkg/a');
			const calls: Array<{ cmd: string[]; options: unknown }> = [];
			const kills = { direct: 0, tree: 0 };
			installSpawnStub(
				calls,
				'--- PASS: TestA (0.00s)\n    --- PASS: TestA/sub.* (0.00s)',
				kills,
			);
			if (mode === 'legacy') process.env.SWARM_LANG_BACKEND = 'legacy';
			const result = await runTests(
				'go-test',
				'target',
				[],
				false,
				1_000,
				root,
				false,
				{ framework: 'go-test', name: 'TestA/sub.*', path: 'pkg/a' },
			);
			expect(result.success).toBe(true);
			expect(calls).toHaveLength(1);
			expect(calls[0].cmd).toEqual([
				'go',
				'test',
				'-v',
				'-run',
				'^TestA$/^sub\\.\\*$',
				'./pkg/a',
			]);
			expect(calls[0].options).toMatchObject({
				cwd: root,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 1_000,
				killProcessTree: true,
			});
			expect(kills).toEqual({ direct: 0, tree: 0 });
		});

		it(`executes the exact CTest selector in ${mode} mode`, async () => {
			const root = makeCTestRoot();
			const calls: Array<{ cmd: string[]; options: unknown }> = [];
			installSpawnStub(
				calls,
				'1/1 Test #1: suite[1].case ........ Passed\n100% tests passed, 0 tests failed out of 1',
			);
			if (mode === 'legacy') process.env.SWARM_LANG_BACKEND = 'legacy';
			const result = await runTests(
				'ctest',
				'target',
				[],
				false,
				1_000,
				root,
				false,
				{ framework: 'ctest', name: 'suite[1].case', path: 'build' },
			);
			expect(result.success).toBe(true);
			expect(calls[0].cmd).toEqual([
				'ctest',
				'--test-dir',
				'build',
				'-R',
				'^suite\\[1\\]\\.case$',
			]);
		});
	}

	it('fails closed when Go or CTest reports no matching native target', async () => {
		for (const testCase of [
			{
				framework: 'go-test' as const,
				name: 'TestMissing',
				path: '.',
				output:
					'testing: warning: no tests to run\nPASS\nok example.test 0.001s [no tests to run]',
			},
			{
				framework: 'ctest' as const,
				name: 'MissingCTest',
				path: 'build',
				output: 'No tests were found!!!',
			},
		]) {
			const root =
				testCase.framework === 'go-test' ? makeGoRoot() : makeCTestRoot();
			const calls: Array<{ cmd: string[]; options: unknown }> = [];
			installSpawnStub(calls, testCase.output);
			const result = await runTests(
				testCase.framework,
				'target',
				[],
				false,
				1_000,
				root,
				false,
				testCase,
			);
			expect(result).toMatchObject({
				success: false,
				error: `Native target "${testCase.name}" did not execute`,
			});
		}
	});

	it('fails closed for invalid runTests target pairing without spawning', async () => {
		const calls: Array<{ cmd: string[]; options: unknown }> = [];
		installSpawnStub(calls);
		for (const invocation of [
			() =>
				runTests('go-test', 'target', [], false, 1_000, process.cwd(), false),
			() =>
				runTests(
					'go-test',
					'convention',
					[],
					false,
					1_000,
					process.cwd(),
					false,
					{
						framework: 'go-test',
						name: 'TestOnly',
						path: '.',
					},
				),
			() =>
				runTests('ctest', 'target', [], false, 1_000, process.cwd(), false, {
					framework: 'go-test',
					name: 'TestOnly',
					path: '.',
				}),
		]) {
			expect(await invocation()).toMatchObject({
				success: false,
				error: 'Invalid native target pairing; refusing broad test fallback',
			});
		}
		expect(calls).toHaveLength(0);
	});

	it('classifies only the pending stub as timed out and never kills a normally exited stub', async () => {
		const root = makeGoRoot();
		const normalKills = { direct: 0, tree: 0 };
		installSpawnStub([], '--- PASS: TestOnly (0.00s)', normalKills);
		await runTests('go-test', 'target', [], false, 50, root, false, {
			framework: 'go-test',
			name: 'TestOnly',
			path: '.',
		});
		expect(normalKills).toEqual({ direct: 0, tree: 0 });

		const timeoutKills = { direct: 0, tree: 0 };
		installSpawnStub([], '', timeoutKills, true);
		const timedOut = await runTests(
			'go-test',
			'target',
			[],
			false,
			5,
			root,
			false,
			{ framework: 'go-test', name: 'TestOnly', path: '.' },
		);
		expect(timedOut).toMatchObject({
			success: false,
			error: 'Tests timed out after 5ms',
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(timeoutKills.tree).toBe(1);
	});

	it('classifies bun-compat timeouts without issuing an extra local kill', async () => {
		const root = makeGoRoot();
		_internals.bunSpawn = ((_cmd, options) =>
			originalSpawn(
				[process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
				options,
			)) as typeof _internals.bunSpawn;
		const result = await runTests(
			'go-test',
			'target',
			[],
			false,
			100,
			root,
			false,
			{ framework: 'go-test', name: 'TestOnly', path: '.' },
		);
		expect(result).toMatchObject({
			success: false,
			error: 'Tests timed out after 100ms',
		});
	});

	it('wires target execution and writes one aggregate history record with no changed files', async () => {
		const root = makeRoot();
		fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/native\n');
		fs.mkdirSync(path.join(root, 'pkg'));
		_internals.isCommandAvailable = (() =>
			true) as typeof _internals.isCommandAvailable;
		installSpawnStub([]);
		const raw = await test_runner.execute(
			{
				scope: 'target',
				native_target: {
					framework: 'go-test',
					name: 'TestOnly',
					path: 'pkg',
				},
			},
			{ directory: root } as never,
		);
		expect(JSON.parse(raw as string).success).toBe(true);
		const historyPath = path.join(
			root,
			'.swarm',
			'cache',
			'test-history.jsonl',
		);
		const records = fs
			.readFileSync(historyPath, 'utf8')
			.trim()
			.split(/\r?\n/)
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			testFile: 'native:go-test:path=pkg#name=TestOnly',
			testName: '(aggregate)',
			changedFiles: [],
		});
	});

	it('rejects incompatible, escaping, and unmarked native targets before spawning', async () => {
		const root = makeRoot();
		fs.mkdirSync(path.join(root, 'build'));
		_internals.isCommandAvailable = (() =>
			true) as typeof _internals.isCommandAvailable;
		const calls: Array<{ cmd: string[]; options: unknown }> = [];
		installSpawnStub(calls);
		for (const args of [
			{
				scope: 'target',
				files: ['x'],
				native_target: { framework: 'ctest', name: 'x', path: 'build' },
			},
			{
				scope: 'target',
				coverage: true,
				native_target: { framework: 'ctest', name: 'x', path: 'build' },
			},
			{
				scope: 'target',
				bail: true,
				native_target: { framework: 'ctest', name: 'x', path: 'build' },
			},
			{
				scope: 'target',
				native_target: { framework: 'go-test', name: 'TestA//sub', path: '.' },
			},
			{
				scope: 'target',
				native_target: { framework: 'ctest', name: 'x', path: '../outside' },
			},
			{
				scope: 'target',
				native_target: { framework: 'ctest', name: 'x', path: 'build' },
			},
		]) {
			const raw = await test_runner.execute(args, { directory: root } as never);
			expect(JSON.parse(raw as string).success).toBe(false);
		}
		expect(calls).toHaveLength(0);
	});

	it('rejects a native target whose canonical path escapes through a symlink', async () => {
		const root = makeRoot();
		fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/native\n');
		const outside = makeRoot();
		const link = path.join(root, 'linked-package');
		fs.symlinkSync(
			outside,
			link,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		_internals.isCommandAvailable = (() =>
			true) as typeof _internals.isCommandAvailable;
		const calls: Array<{ cmd: string[]; options: unknown }> = [];
		installSpawnStub(calls);
		const raw = await test_runner.execute(
			{
				scope: 'target',
				native_target: {
					framework: 'go-test',
					name: 'TestOnly',
					path: 'linked-package',
				},
			},
			{ directory: root } as never,
		);
		expect(JSON.parse(raw as string)).toMatchObject({
			success: false,
			error: 'Native target path escapes project root',
		});
		expect(calls).toHaveLength(0);
	});

	for (const workspace of ['nested-module', 'root-go-work'] as const) {
		it(`runs a Go package from a ${workspace}`, async () => {
			const root = makeRoot();
			const moduleRoot = path.join(root, 'services', 'api');
			const packageDir = path.join(moduleRoot, 'pkg');
			fs.mkdirSync(packageDir, { recursive: true });
			fs.writeFileSync(
				path.join(moduleRoot, 'go.mod'),
				'module example.test/api\n',
			);
			if (workspace === 'root-go-work') {
				fs.writeFileSync(
					path.join(root, 'go.work'),
					'go 1.22\nuse ./services/api\n',
				);
			}
			_internals.isCommandAvailable = (() =>
				true) as typeof _internals.isCommandAvailable;
			const calls: Array<{ cmd: string[]; options: unknown }> = [];
			installSpawnStub(calls);
			const raw = await test_runner.execute(
				{
					scope: 'target',
					native_target: {
						framework: 'go-test',
						name: 'TestOnly',
						path: 'services/api/pkg',
					},
				},
				{ directory: root } as never,
			);
			expect(JSON.parse(raw as string).success).toBe(true);
			expect(calls[0].options).toMatchObject({
				cwd: workspace === 'root-go-work' ? root : moduleRoot,
			});
			expect(calls[0].cmd.at(-1)).toBe(
				workspace === 'root-go-work' ? './services/api/pkg' : './pkg',
			);
		});
	}
});
