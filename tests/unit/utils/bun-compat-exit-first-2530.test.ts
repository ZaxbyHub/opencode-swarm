import { describe, expect, test } from 'bun:test';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as bunCompat from '../../../src/utils/bun-compat';

const PROBE_TIMEOUT_MS = 5_000;
const LARGE_OUTPUT_BYTES = 128 * 1024;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const CAPTURE_BUFFER_BYTES = 512 * 1024;

type SpawnWithOutputLimit = Parameters<typeof bunCompat.bunSpawn>[1] & {
	maxBuffer?: number;
};

const nativeSpawn = bunCompat.bunSpawn as unknown as (
	command: string[],
	options?: SpawnWithOutputLimit,
) => bunCompat.BunCompatSubprocess;

function runNodeProbe(
	makeProbe: (moduleUrl: string) => string,
	sourcePath = path.resolve('src/utils/bun-compat.ts'),
) {
	const tempDir = realpathSync(
		mkdtempSync(path.join(realpathSync(os.tmpdir()), 'bun-compat-2530-')),
	);
	const bundlePath = path.join(tempDir, 'bun-compat.mjs');
	try {
		const build = nodeSpawnSync(
			process.execPath,
			[
				'build',
				sourcePath,
				'--target',
				'node',
				'--format',
				'esm',
				'--outfile',
				bundlePath,
			],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: PROBE_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
			},
		);
		expect(build.status).toBe(0);
		return nodeSpawnSync(
			'node',
			[
				'--input-type=module',
				'--eval',
				makeProbe(pathToFileURL(bundlePath).href),
			],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: PROBE_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
			},
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

const MATRIX_CASES = [
	{
		name: 'empty',
		script: 'process.exit(0)',
		expectedCode: 0,
		expectedStdout: '',
		expectedStderr: '',
	},
	{
		name: 'small',
		script:
			"process.stdout.write('small-out'); process.stderr.write('small-err')",
		expectedCode: 0,
		expectedStdout: 'small-out',
		expectedStderr: 'small-err',
	},
	{
		name: 'large-dual',
		script: `const p = 'L'.repeat(${LARGE_OUTPUT_BYTES}); process.stdout.write(p); process.stderr.write(p)`,
		expectedCode: 0,
		expectedStdout: 'L'.repeat(LARGE_OUTPUT_BYTES),
		expectedStderr: 'L'.repeat(LARGE_OUTPUT_BYTES),
	},
	{
		name: 'nonzero-dual',
		script: `const p = 'N'.repeat(${LARGE_OUTPUT_BYTES}); process.stdout.write(p); process.stderr.write(p); process.exitCode = 7`,
		expectedCode: 7,
		expectedStdout: 'N'.repeat(LARGE_OUTPUT_BYTES),
		expectedStderr: 'N'.repeat(LARGE_OUTPUT_BYTES),
	},
] as const;

function assertOutputMatrix(receipt: unknown) {
	expect(receipt).toEqual(
		MATRIX_CASES.map((item) => ({
			name: item.name,
			exitCode: item.expectedCode,
			stdoutLength: item.expectedStdout.length,
			stderrLength: item.expectedStderr.length,
			stdoutMatches: true,
			stderrMatches: true,
		})),
	);
}

async function runNativeMatrix() {
	const results = [];
	for (const item of MATRIX_CASES) {
		const proc = nativeSpawn([process.execPath, '--eval', item.script], {
			cwd: process.cwd(),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 3_000,
			maxBuffer: CAPTURE_BUFFER_BYTES,
		});
		const exitCode = await proc.exited;
		const [stdout, stderr] = await Promise.all([
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		results.push({
			name: item.name,
			exitCode,
			stdoutLength: stdout.length,
			stderrLength: stderr.length,
			stdoutMatches: stdout === item.expectedStdout,
			stderrMatches: stderr === item.expectedStderr,
		});
	}
	return results;
}

async function readNativeReader(proc: bunCompat.BunCompatSubprocess) {
	const reader = proc.stdout.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	const bytes = new Uint8Array(
		chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function nativeOutputLimitProbe() {
	const outputLimitError = (
		bunCompat as typeof bunCompat & {
			BunCompatOutputLimitError?: typeof Error;
		}
	).BunCompatOutputLimitError;
	const describeError = (error: unknown) => ({
		ok: false as const,
		name: error instanceof Error ? error.name : typeof error,
		instanceOf:
			typeof outputLimitError === 'function' &&
			error instanceof outputLimitError,
		limit: (error as { limit?: number }).limit,
		captured: (error as { captured?: number }).captured,
		total: (error as { total?: number }).total,
	});
	const proc = nativeSpawn(
		[
			process.execPath,
			'--eval',
			`const p = 'O'.repeat(${LARGE_OUTPUT_BYTES * 2}); process.stdout.write(p); process.stderr.write(p)`,
		],
		{
			cwd: process.cwd(),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 3_000,
			maxBuffer: OUTPUT_LIMIT_BYTES,
		},
	);
	const stdout = proc.stdout
		.text()
		.then(
			(value) => ({ ok: true as const, length: value.length }),
			describeError,
		);
	const stderr = proc.stderr
		.text()
		.then(
			(value) => ({ ok: true as const, length: value.length }),
			describeError,
		);
	const exitCode = await proc.exited;
	return {
		outputLimitErrorExported: typeof outputLimitError === 'function',
		exitCode,
		signalCode: proc.signalCode ?? null,
		stdout: await stdout,
		stderr: await stderr,
	};
}

async function nativeTimeoutProbe() {
	const proc = nativeSpawn(
		[
			process.execPath,
			'--eval',
			"process.stdout.write('partial-out'); process.stderr.write('partial-err'); setInterval(() => {}, 1000)",
		],
		{
			cwd: process.cwd(),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 250,
			maxBuffer: CAPTURE_BUFFER_BYTES,
		},
	);
	const exitCode = await proc.exited;
	const [stdout, stderr] = await Promise.all([
		proc.stdout.text(),
		proc.stderr.text(),
	]);
	return {
		exitCode,
		signalCode: proc.signalCode ?? null,
		stdoutLength: stdout.length,
		stderrLength: stderr.length,
	};
}

function assertTimeoutReceipt(receipt: unknown) {
	const result = receipt as {
		exitCode: number;
		signalCode: string | null;
		stdoutLength: number;
		stderrLength: number;
	};
	expect(result.stdoutLength).toBeGreaterThan(0);
	expect(result.stderrLength).toBeGreaterThan(0);
	expect(result.exitCode !== 0 || result.signalCode !== null).toBe(true);
}

function runPublicCleanProbe() {
	const repo = realpathSync(
		mkdtempSync(path.join(realpathSync(os.tmpdir()), 'is-clean-2530-')),
	);
	const entryDir = realpathSync(
		mkdtempSync(path.join(realpathSync(os.tmpdir()), 'is-clean-entry-2530-')),
	);
	const entryPath = path.join(entryDir, 'entry.ts');
	try {
		const gitOptions = {
			cwd: repo,
			encoding: 'utf8' as const,
			stdio: ['ignore', 'pipe', 'pipe'] as const,
			timeout: PROBE_TIMEOUT_MS,
			maxBuffer: CAPTURE_BUFFER_BYTES,
		};
		for (const args of [
			['init', '-b', 'main'],
			['config', 'user.email', 'test@example.com'],
			['config', 'user.name', 'Test User'],
			['commit', '--allow-empty', '-m', 'init'],
		]) {
			expect(nodeSpawnSync('git', args, gitOptions).status).toBe(0);
		}
		writeFileSync(
			entryPath,
			`export { isCleanWorktree } from ${JSON.stringify(path.resolve('src/worktree/core.ts'))};`,
		);
		return runNodeProbe(
			(moduleUrl) => `
				const { isCleanWorktree } = await import(${JSON.stringify(moduleUrl)});
				console.log(JSON.stringify({ clean: await isCleanWorktree(${JSON.stringify(repo)}) }));
			`,
			entryPath,
		);
	} finally {
		rmSync(entryDir, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
}

describe('bunSpawn Node fallback exit-first output consumption (#2530)', () => {
	test('Node fallback preserves empty, small, large, and nonzero dual-stream outcomes', () => {
		const result = runNodeProbe(
			(moduleUrl) => `
			const { bunSpawn } = await import(${JSON.stringify(moduleUrl)});
			const cases = ${JSON.stringify(
				MATRIX_CASES.map(({ name, script, expectedCode }) => ({
					name,
					script,
					expectedCode,
				})),
			)};
			const receipts = [];
			const read = (stream) => Promise.race([
				stream.text(),
				new Promise((resolve) => setTimeout(() => resolve(null), 500)),
			]);
			for (const item of cases) {
				const proc = bunSpawn([process.execPath, '--eval', item.script], {
					cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
					timeout: 3000, maxBuffer: ${CAPTURE_BUFFER_BYTES},
				});
				const exitCode = await proc.exited;
				const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
				receipts.push({
					name: item.name,
					exitCode,
					stdoutLength: typeof stdout === 'string' ? stdout.length : -1,
					stderrLength: typeof stderr === 'string' ? stderr.length : -1,
					stdoutMatches: item.name === 'empty'
						? stdout === ''
						: item.name === 'small'
							? stdout === 'small-out'
							: stdout === (item.name === 'large-dual' ? 'L' : 'N').repeat(${LARGE_OUTPUT_BYTES}),
					stderrMatches: item.name === 'empty'
						? stderr === ''
						: item.name === 'small'
							? stderr === 'small-err'
							: stderr === (item.name === 'large-dual' ? 'L' : 'N').repeat(${LARGE_OUTPUT_BYTES}),
				});
			}
			console.log(JSON.stringify(receipts));
		`,
		);
		expect(result.status).toBe(0);
		const receipt = JSON.parse(result.stdout.trim()) as Array<{
			name: string;
			exitCode: number;
			stdoutLength: number;
			stderrLength: number;
			stdoutMatches: boolean | string;
		}>;
		expect(receipt[0]).toMatchObject({
			name: 'empty',
			exitCode: 0,
			stdoutLength: 0,
		});
		expect(receipt[1]).toMatchObject({
			name: 'small',
			exitCode: 0,
			stdoutLength: 9,
		});
		assertOutputMatrix(receipt);
	});

	test('native Bun preserves empty, small, large, and nonzero dual-stream outcomes', async () => {
		expect(await runNativeMatrix()).toEqual(
			MATRIX_CASES.map((item) => ({
				name: item.name,
				exitCode: item.expectedCode,
				stdoutLength: item.expectedStdout.length,
				stderrLength: item.expectedStderr.length,
				stdoutMatches: true,
				stderrMatches: true,
			})),
		);
	});

	test('native Bun immediate getReader retains stdout ownership', async () => {
		const proc = nativeSpawn(
			[process.execPath, '--eval', "process.stdout.write('reader-ready')"],
			{
				cwd: process.cwd(),
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 3000,
			},
		);
		const text = await readNativeReader(proc);
		const exitCode = await proc.exited;
		expect({ exitCode, text }).toEqual({ exitCode: 0, text: 'reader-ready' });
	});

	test('Node fallback reports bounded output overflow and terminates the child', () => {
		const result = runNodeProbe(
			(moduleUrl) => `
			const { bunSpawn, BunCompatOutputLimitError } = await import(${JSON.stringify(moduleUrl)});
			const proc = bunSpawn([process.execPath, '--eval',
				"const p = 'O'.repeat(${LARGE_OUTPUT_BYTES * 2}); process.stdout.write(p); process.stderr.write(p)"
			], { cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 3000, maxBuffer: ${OUTPUT_LIMIT_BYTES} });
			const describe = (promise) => Promise.race([
				promise.then(
					(value) => ({ ok: true, length: value.length }),
					(error) => ({ ok: false, name: error?.name, instanceOf: error instanceof BunCompatOutputLimitError,
						limit: error?.limit, captured: error?.captured, total: error?.total }),
				),
				new Promise((resolve) => setTimeout(() => resolve({ ok: false, name: 'ReadTimeout' }), 500)),
			]);
			const exitCode = await proc.exited;
			console.log(JSON.stringify({ exported: typeof BunCompatOutputLimitError === 'function', exitCode,
				signalCode: proc.signalCode ?? null, stdout: await describe(proc.stdout.text()), stderr: await describe(proc.stderr.text()) }));
		`,
		);
		expect(result.status).toBe(0);
		const receipt = JSON.parse(result.stdout.trim()) as {
			exported: boolean;
			exitCode: number;
			signalCode: string | null;
			stdout: {
				ok: boolean;
				name?: string;
				instanceOf?: boolean;
				limit?: number;
				captured?: number;
				total?: number;
			};
			stderr: {
				ok: boolean;
				name?: string;
				instanceOf?: boolean;
				limit?: number;
				captured?: number;
				total?: number;
			};
		};
		expect(receipt.exported).toBe(true);
		expect(receipt.exitCode !== 0 || receipt.signalCode !== null).toBe(true);
		const errors = [receipt.stdout, receipt.stderr].filter((item) => !item.ok);
		expect(errors.length).toBeGreaterThan(0);
		for (const error of errors) {
			expect(error).toMatchObject({
				name: 'BunCompatOutputLimitError',
				instanceOf: true,
				limit: OUTPUT_LIMIT_BYTES,
			});
			expect(error.captured).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
			expect(error.total).toBeGreaterThan(OUTPUT_LIMIT_BYTES);
		}
	});

	test('native Bun reports bounded output overflow and terminates the child', async () => {
		const receipt = await nativeOutputLimitProbe();
		expect(receipt.outputLimitErrorExported).toBe(true);
		expect(receipt.exitCode !== 0 || receipt.signalCode !== null).toBe(true);
		const errors = [receipt.stdout, receipt.stderr].filter((item) => !item.ok);
		expect(errors.length).toBeGreaterThan(0);
		for (const error of errors) {
			expect(error).toMatchObject({
				name: 'BunCompatOutputLimitError',
				instanceOf: true,
				limit: OUTPUT_LIMIT_BYTES,
			});
			expect(error.captured).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
			expect(error.total).toBeGreaterThan(OUTPUT_LIMIT_BYTES);
		}
	});

	test('Node fallback timeout preserves partial output and termination outcome', () => {
		const result = runNodeProbe(
			(moduleUrl) => `
			const { bunSpawn } = await import(${JSON.stringify(moduleUrl)});
			const proc = bunSpawn([process.execPath, '--eval',
				"process.stdout.write('partial-out'); process.stderr.write('partial-err'); setInterval(() => {}, 1000)"
			], { cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
				timeout: 250, maxBuffer: ${CAPTURE_BUFFER_BYTES} });
			const exitCode = await proc.exited;
			const read = (stream) => Promise.race([
				stream.text(),
				new Promise((resolve) => setTimeout(() => resolve(''), 500)),
			]);
			const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
			console.log(JSON.stringify({ exitCode, signalCode: proc.signalCode ?? null,
				stdoutLength: stdout.length, stderrLength: stderr.length }));
		`,
		);
		expect(result.status).toBe(0);
		assertTimeoutReceipt(JSON.parse(result.stdout.trim()));
	});

	test('native Bun timeout preserves partial output and termination outcome', async () => {
		assertTimeoutReceipt(await nativeTimeoutProbe());
	});

	test('plain-Node built public isCleanWorktree path handles a clean Git repo', () => {
		const result = runPublicCleanProbe();
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({ clean: true });
	});
});
