import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, test_runner } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * TDD spec: gradle mirrors maven. `scope: 'convention'` derives
 * `--tests <Class>` from resolved test files (R1), and a nested
 * `<module>/build.gradle` project is detected and executed in the module
 * directory (G-nested). Spawn is mocked.
 */

const originalBunSpawn = _internals.bunSpawn;
const originalIsCommandAvailable = _internals.isCommandAvailable;

let spawnCalls: Array<{ cmd: string[]; opts: { cwd?: string } }> = [];

function mockBunSpawn(
	cmd: string[],
	opts: { cwd?: string },
): ReturnType<typeof _internals.bunSpawn> {
	spawnCalls.push({ cmd, opts });
	const closed = () =>
		new ReadableStream({
			start(controller) {
				controller.close();
			},
		});
	return {
		stdout: closed(),
		stderr: closed(),
		exited: Promise.resolve(0),
		exitCode: 0,
		kill: () => {},
	} as unknown as ReturnType<typeof _internals.bunSpawn>;
}

function createFile(dir: string, filePath: string, content = ''): void {
	const fullPath = path.join(dir, filePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
}

describe('gradle convention scope — derived --tests targets', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('test-runner-gradle-derived-');
		spawnCalls = [];
		_internals.bunSpawn = mockBunSpawn;
		_internals.isCommandAvailable = () => true;
	});

	afterEach(() => {
		_internals.bunSpawn = originalBunSpawn;
		_internals.isCommandAvailable = originalIsCommandAvailable;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	const run = (args: Record<string, unknown>) =>
		test_runner.execute(args as never, { directory: tempDir });

	test('R1 root build.gradle: direct test file runs gradle test --tests FooTest', async () => {
		createFile(tempDir, 'build.gradle', '');
		createFile(tempDir, 'src/test/java/com/x/FooTest.java', 'class FooTest {}');

		await run({
			scope: 'convention',
			files: ['src/test/java/com/x/FooTest.java'],
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['gradle', 'test', '--tests', 'FooTest']);
		expect(spawnCalls[0].opts.cwd).toBe(tempDir);
	});

	test('G-nested: backend/build.gradle is detected and run in backend/', async () => {
		createFile(tempDir, 'backend/build.gradle', '');
		createFile(
			tempDir,
			'backend/src/test/java/com/x/FooTest.java',
			'class FooTest {}',
		);

		await run({
			scope: 'convention',
			files: ['backend/src/test/java/com/x/FooTest.java'],
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['gradle', 'test', '--tests', 'FooTest']);
		expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
	});

	test('R2 nested module: source file discovers backend/src/test/java sibling', async () => {
		createFile(tempDir, 'backend/build.gradle', '');
		createFile(tempDir, 'backend/src/main/java/com/x/Foo.java', 'class Foo {}');
		createFile(
			tempDir,
			'backend/src/test/java/com/x/FooTest.java',
			'class FooTest {}',
		);

		await run({
			scope: 'convention',
			files: ['backend/src/main/java/com/x/Foo.java'],
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['gradle', 'test', '--tests', 'FooTest']);
		expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
	});

	test('fail-closed: a non-JVM file in the selection preserves the structured error and spawns nothing', async () => {
		createFile(tempDir, 'build.gradle', '');
		createFile(tempDir, 'src/test/java/com/x/FooTest.java', 'class FooTest {}');
		createFile(tempDir, 'src/test/resources/fixture.json', '{}');

		const result = await run({
			scope: 'convention',
			files: [
				'src/test/java/com/x/FooTest.java',
				'src/test/resources/fixture.json',
			],
		});
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(
			'Framework "gradle" does not support targeted test-file execution',
		);
		expect(spawnCalls.length).toBe(0);
	});

	test('explicit targets still win over derivation (regression guard)', async () => {
		createFile(tempDir, 'build.gradle', '');
		createFile(tempDir, 'src/test/java/com/x/FooTest.java', 'class FooTest {}');

		await run({
			scope: 'convention',
			files: ['src/test/java/com/x/FooTest.java'],
			targets: ['BarTest'],
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['gradle', 'test', '--tests', 'BarTest']);
	});
});
