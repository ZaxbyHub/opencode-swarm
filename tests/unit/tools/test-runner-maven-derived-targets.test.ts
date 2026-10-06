import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, test_runner } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * TDD spec: for maven, `scope: 'convention'` must run
 * the resolved test classes instead of returning the class-based
 * "does not support targeted test-file execution" error.
 *
 *  R1: derive `-Dtest=<Class>` from the resolved test files when the caller
 *      passes no `targets` (class name == file basename).
 *  R2: source -> sibling-test discovery must also work for a nested module
 *      (`<module>/src/main/java` -> `<module>/src/test/java`).
 *
 * Spawn is mocked: these tests pin the command and cwd, not Maven itself.
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

describe('maven convention scope — derived -Dtest targets', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('test-runner-maven-derived-');
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

	test('R1 nested module: direct test file runs mvn test -Dtest=FooTest in backend/', async () => {
		createFile(tempDir, 'backend/pom.xml', '<project/>');
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
		expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', '-Dtest=FooTest']);
		expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
	});

	test('R1 root pom: direct test file runs mvn test -Dtest=FooTest in the root', async () => {
		createFile(tempDir, 'pom.xml', '<project/>');
		createFile(tempDir, 'src/test/java/com/x/FooTest.java', 'class FooTest {}');

		await run({
			scope: 'convention',
			files: ['src/test/java/com/x/FooTest.java'],
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', '-Dtest=FooTest']);
		expect(spawnCalls[0].opts.cwd).toBe(tempDir);
	});

	test('R1 two test files derive a comma-separated -Dtest', async () => {
		createFile(tempDir, 'backend/pom.xml', '<project/>');
		createFile(
			tempDir,
			'backend/src/test/java/com/x/FooTest.java',
			'class FooTest {}',
		);
		createFile(
			tempDir,
			'backend/src/test/java/com/x/BarTest.java',
			'class BarTest {}',
		);

		await run({
			scope: 'convention',
			files: [
				'backend/src/test/java/com/x/FooTest.java',
				'backend/src/test/java/com/x/BarTest.java',
			],
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual([
			'mvn',
			'test',
			'-Dtest=FooTest,BarTest',
		]);
		expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
	});

	test('R1 root pom: source file discovers its sibling test and derives -Dtest', async () => {
		createFile(tempDir, 'pom.xml', '<project/>');
		createFile(tempDir, 'src/main/java/com/x/Foo.java', 'class Foo {}');
		createFile(tempDir, 'src/test/java/com/x/FooTest.java', 'class FooTest {}');

		await run({
			scope: 'convention',
			files: ['src/main/java/com/x/Foo.java'],
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', '-Dtest=FooTest']);
	});

	test('R2 nested module: source file discovers backend/src/test/java sibling', async () => {
		createFile(tempDir, 'backend/pom.xml', '<project/>');
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
		expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', '-Dtest=FooTest']);
		expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
	});

	test('explicit targets still win over derivation (regression guard)', async () => {
		createFile(tempDir, 'backend/pom.xml', '<project/>');
		createFile(
			tempDir,
			'backend/src/test/java/com/x/FooTest.java',
			'class FooTest {}',
		);

		await run({
			scope: 'convention',
			files: ['backend/src/test/java/com/x/FooTest.java'],
			targets: ['BarTest'],
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', '-Dtest=BarTest']);
	});

	test('fail-closed: a non-JVM file in the selection preserves the structured error and spawns nothing', async () => {
		createFile(tempDir, 'backend/pom.xml', '<project/>');
		createFile(
			tempDir,
			'backend/src/test/java/com/x/FooTest.java',
			'class FooTest {}',
		);
		createFile(tempDir, 'backend/src/test/resources/fixture.json', '{}');

		const result = await run({
			scope: 'convention',
			files: [
				'backend/src/test/java/com/x/FooTest.java',
				'backend/src/test/resources/fixture.json',
			],
		});
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(
			'Framework "maven" does not support targeted test-file execution',
		);
		expect(spawnCalls.length).toBe(0);
	});

	test('coverage=true adds no maven coverage argument (regression guard)', async () => {
		createFile(tempDir, 'backend/pom.xml', '<project/>');
		createFile(
			tempDir,
			'backend/src/test/java/com/x/FooTest.java',
			'class FooTest {}',
		);

		await run({
			scope: 'convention',
			files: ['backend/src/test/java/com/x/FooTest.java'],
			targets: ['FooTest'],
			coverage: true,
		});

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', '-Dtest=FooTest']);
	});
});
