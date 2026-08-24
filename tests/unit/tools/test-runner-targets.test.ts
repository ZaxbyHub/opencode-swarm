import { afterEach, describe, expect, test } from 'bun:test';

const testRunnerModule = await import('../../../src/tools/test-runner');
const { test_runner, runTests } = testRunnerModule;

describe('test-runner.ts — targets support', () => {
	test('allows targeted execution for go-test when targets are provided', async () => {
		const originalSpawn = Bun.spawn;
		const encoder = new TextEncoder();
		let spawnArgs: string[] = [];
		Bun.spawn = ((cmd: string[], options?: any) => {
			spawnArgs = cmd;
			return {
				stdout: new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode('ok  	pkg	0.001s'));
						controller.close();
					},
				}),
				stderr: new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
				exited: Promise.resolve(0),
				exitCode: 0,
				kill: () => {},
			};
		}) as unknown as typeof Bun.spawn;

		try {
			const result = await runTests(
				'go-test',
				'convention',
				['pkg/foo_test.go'],
				false,
				60_000,
				process.cwd(),
				false,
				['TestFoo'],
			);

			expect(result.success).toBe(true);
			expect(spawnArgs).toEqual(['go', 'test', '-run', 'TestFoo', './...']);
		} finally {
			Bun.spawn = originalSpawn;
		}
	});

	test('allows targeted execution for ctest when targets are provided', async () => {
		const originalSpawn = Bun.spawn;
		const encoder = new TextEncoder();
		let spawnArgs: string[] = [];
		Bun.spawn = ((cmd: string[], options?: any) => {
			spawnArgs = cmd;
			return {
				stdout: new ReadableStream({
					start(controller) {
						controller.enqueue(
							encoder.encode('100% tests passed, 0 tests failed out of 1'),
						);
						controller.close();
					},
				}),
				stderr: new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
				exited: Promise.resolve(0),
				exitCode: 0,
				kill: () => {},
			};
		}) as unknown as typeof Bun.spawn;

		try {
			const result = await runTests(
				'ctest',
				'convention',
				['tests/foo.cc'],
				false,
				60_000,
				process.cwd(),
				false,
				['auto-src-controller-stateManager'],
			);

			expect(result.success).toBe(true);
			expect(spawnArgs).toContain('ctest');
			expect(spawnArgs).toContain('-R');
			expect(spawnArgs).toContain('auto-src-controller-stateManager');
		} finally {
			Bun.spawn = originalSpawn;
		}
	});

	test('targets parameter survives Zod schema validation through tool execute path', async () => {
		const result = await test_runner.execute(
			{
				scope: 'all',
				targets: ['TestFoo', 'TestBar'],
			},
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.error).not.toBe('Invalid arguments');
	});

	test('empty string targets are rejected by validation', async () => {
		const result = await test_runner.execute(
			{
				scope: 'all',
				targets: [''],
			},
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.error).toBe('Invalid arguments');
	});

	test('targets with shell metacharacters are rejected', async () => {
		const result = await test_runner.execute(
			{
				scope: 'all',
				targets: ['TestFoo; rm -rf /'],
			},
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.error).toBe('Invalid arguments');
	});

	test('targets with regex metacharacters are allowed', async () => {
		const result = await test_runner.execute(
			{
				scope: 'all',
				targets: ['TestFoo.*', 'Test?Bar', 'A|B'],
			},
			{} as any,
		);
		const parsed = JSON.parse(result);
		expect(parsed.error).not.toBe('Invalid arguments');
	});
});
