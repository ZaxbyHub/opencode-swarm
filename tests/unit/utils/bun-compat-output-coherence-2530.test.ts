import { describe, expect, test } from 'bun:test';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	BunCompatOutputLimitError,
	type BunCompatSubprocess,
	bunSpawn,
	DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
} from '../../../src/utils/bun-compat';

const TEST_CWD = path.resolve(import.meta.dir, '../../..');
const TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024;

function resolveNodeExecutable(): string {
	const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!directory) continue;
		for (const name of names) {
			const candidate = path.resolve(directory, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	throw new Error('node executable not found on PATH');
}

const BUILD_EXECUTABLE = process.execPath;
const CHILD_EXECUTABLE = resolveNodeExecutable();

function runNodeProbe(makeProbe: (moduleUrl: string) => string) {
	const tempDir = realpathSync(
		mkdtempSync(
			path.join(realpathSync(os.tmpdir()), 'bun-compat-output-2530-'),
		),
	);
	const bundlePath = path.join(tempDir, 'bun-compat.mjs');
	try {
		const build = nodeSpawnSync(
			BUILD_EXECUTABLE,
			[
				'build',
				path.resolve(TEST_CWD, 'src/utils/bun-compat.ts'),
				'--target',
				'node',
				'--format',
				'esm',
				'--outfile',
				bundlePath,
			],
			{
				cwd: TEST_CWD,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: TIMEOUT_MS,
				maxBuffer: PROBE_OUTPUT_LIMIT_BYTES,
			},
		);
		expect(build.status).toBe(0);
		return nodeSpawnSync(
			CHILD_EXECUTABLE,
			[
				'--input-type=module',
				'--eval',
				makeProbe(pathToFileURL(bundlePath).href),
			],
			{
				cwd: TEST_CWD,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: TIMEOUT_MS,
				maxBuffer: PROBE_OUTPUT_LIMIT_BYTES,
			},
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function spawnNativeChild(
	script: string,
	maxBuffer?: number,
): BunCompatSubprocess {
	return bunSpawn([CHILD_EXECUTABLE, '--eval', script], {
		cwd: TEST_CWD,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: TIMEOUT_MS,
		...(maxBuffer === undefined ? {} : { maxBuffer }),
	});
}

describe('native bunSpawn buffered output coherence (#2530)', () => {
	test('shares one output-limit error across an overflowing pipe and its sibling', async () => {
		const limit = 64 * 1024;
		const overflowingBytes = limit + 1;
		const proc = spawnNativeChild(
			`process.stderr.write('below-limit'); process.stdout.write('O'.repeat(${overflowingBytes}))`,
			limit,
		);

		const stdout = proc.stdout.text();
		const stderr = proc.stderr.text();
		await proc.exited;
		const [stdoutResult, stderrResult] = await Promise.allSettled([
			stdout,
			stderr,
		]);

		expect(stdoutResult.status).toBe('rejected');
		expect(stderrResult.status).toBe('rejected');
		if (
			stdoutResult.status !== 'rejected' ||
			stderrResult.status !== 'rejected'
		) {
			throw new Error(
				'both buffered pipes must reject after one pipe overflows',
			);
		}
		expect(stderrResult.reason).toBe(stdoutResult.reason);
		expect(stdoutResult.reason).toBeInstanceOf(BunCompatOutputLimitError);
		expect(stdoutResult.reason).toMatchObject({
			limit,
			captured: limit,
			total: overflowingBytes,
		});
	});

	test('omitting maxBuffer uses the exact 5 MiB default for native Bun overflow', async () => {
		expect(DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES).toBe(5 * 1024 * 1024);
		const overflowingBytes = DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES + 1;
		const proc = spawnNativeChild(
			`process.stdout.write('O'.repeat(${overflowingBytes}))`,
		);
		const reads = await Promise.allSettled([
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		const exitCode = await proc.exited;

		expect(exitCode).not.toBe(0);
		expect(reads[0]?.status).toBe('rejected');
		expect(reads[1]?.status).toBe('rejected');
		if (reads[0]?.status !== 'rejected' || reads[1]?.status !== 'rejected') {
			throw new Error('both buffered pipes must reject after default overflow');
		}
		expect(reads[1].reason).toBe(reads[0].reason);
		expect(reads[0].reason).toBeInstanceOf(BunCompatOutputLimitError);
		expect(reads[0].reason).toMatchObject({
			limit: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
			captured: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
			total: overflowingBytes,
		});
	});

	test('plain Node preserves synchronous getReader ownership and exact output', () => {
		const expected = 'node reader ownership';
		const childScript = `process.stdout.write(${JSON.stringify(expected)})`;
		const result = runNodeProbe(
			(moduleUrl) => `
				const { bunSpawn } = await import(${JSON.stringify(moduleUrl)});
				const proc = bunSpawn([process.execPath, '--eval', ${JSON.stringify(childScript)}], {
					cwd: ${JSON.stringify(TEST_CWD)}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
					timeout: ${TIMEOUT_MS}, maxBuffer: ${DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES},
				});
				const reader = proc.stdout.getReader();
				const chunks = [];
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) chunks.push(value);
				}
				const output = new TextDecoder().decode(
					Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
				);
				console.log(JSON.stringify({ exitCode: await proc.exited, output }));
			`,
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			exitCode: 0,
			output: expected,
		});
	});

	test('plain Node shares overflow identity and exact byte accounting across pipes', () => {
		const limit = 32 * 1024;
		const overflowingBytes = limit + 1;
		const safeStderr = 'below-limit';
		const childScript = `process.stderr.write(${JSON.stringify(safeStderr)}); process.stdout.write("O".repeat(${overflowingBytes}))`;
		const result = runNodeProbe(
			(moduleUrl) => `
				const { bunSpawn, BunCompatOutputLimitError } = await import(${JSON.stringify(moduleUrl)});
				const proc = bunSpawn([process.execPath, '--eval', ${JSON.stringify(childScript)}], {
					cwd: ${JSON.stringify(TEST_CWD)}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
					timeout: ${TIMEOUT_MS}, maxBuffer: ${limit},
				});
				const reads = await Promise.allSettled([proc.stdout.text(), proc.stderr.text()]);
				const stdoutError = reads[0].status === 'rejected' ? reads[0].reason : null;
				const stderrError = reads[1].status === 'rejected' ? reads[1].reason : null;
				const describe = (error) => error instanceof BunCompatOutputLimitError
					? { name: error.name, limit: error.limit, captured: error.captured, total: error.total }
					: { name: error?.name ?? null };
				console.log(JSON.stringify({
					exitCode: await proc.exited,
					safeStderrBytes: Buffer.byteLength(${JSON.stringify(safeStderr)}),
					sameIdentity: stdoutError === stderrError,
					stdout: describe(stdoutError), stderr: describe(stderrError),
				}));
			`,
		);
		expect(result.status).toBe(0);
		const receipt = JSON.parse(result.stdout.trim()) as {
			safeStderrBytes: number;
		};
		expect(receipt.safeStderrBytes).toBeLessThan(limit);
		expect(receipt).toEqual({
			exitCode: expect.any(Number),
			safeStderrBytes: Buffer.byteLength(safeStderr),
			sameIdentity: true,
			stdout: {
				name: 'BunCompatOutputLimitError',
				limit,
				captured: limit,
				total: overflowingBytes,
			},
			stderr: {
				name: 'BunCompatOutputLimitError',
				limit,
				captured: limit,
				total: overflowingBytes,
			},
		});
	});

	test('plain Node applies the exact 5 MiB default when maxBuffer is omitted', () => {
		const overflowingBytes = DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES + 1;
		const childScript = `process.stdout.write("O".repeat(${overflowingBytes}))`;
		const result = runNodeProbe(
			(moduleUrl) => `
				const { bunSpawn, BunCompatOutputLimitError } = await import(${JSON.stringify(moduleUrl)});
				const proc = bunSpawn([process.execPath, '--eval', ${JSON.stringify(childScript)}], {
					cwd: ${JSON.stringify(TEST_CWD)}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
					timeout: ${TIMEOUT_MS},
				});
				const reads = await Promise.allSettled([proc.stdout.text(), proc.stderr.text()]);
				const describe = (read) => read.status === 'rejected'
					? { name: read.reason?.name, limit: read.reason?.limit,
						captured: read.reason?.captured, total: read.reason?.total,
						instanceOf: read.reason instanceof BunCompatOutputLimitError }
					: { status: 'fulfilled', value: read.value };
				console.log(JSON.stringify({ exitCode: await proc.exited,
					sameErrorIdentity: reads[0].status === 'rejected' && reads[1].status === 'rejected'
						&& reads[0].reason === reads[1].reason,
					reads: reads.map(describe) }));
			`,
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			exitCode: expect.any(Number),
			sameErrorIdentity: true,
			reads: [
				{
					name: 'BunCompatOutputLimitError',
					limit: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
					captured: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
					total: overflowingBytes,
					instanceOf: true,
				},
				{
					name: 'BunCompatOutputLimitError',
					limit: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
					captured: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
					total: overflowingBytes,
					instanceOf: true,
				},
			],
		});
	});

	test('plain Node normalizes invalid maxBuffer before exact default overflow', () => {
		expect(DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES).toBe(5 * 1024 * 1024);
		const overflowingBytes = DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES + 1;
		const childScript = `process.stdout.write("O".repeat(${overflowingBytes}))`;
		const result = runNodeProbe(
			(moduleUrl) => `
				const { bunSpawn, BunCompatOutputLimitError } = await import(${JSON.stringify(moduleUrl)});
				const proc = bunSpawn([process.execPath, '--eval', ${JSON.stringify(childScript)}], {
					cwd: ${JSON.stringify(TEST_CWD)}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
					timeout: ${TIMEOUT_MS}, maxBuffer: 0,
				});
				const reads = await Promise.allSettled([proc.stdout.text(), proc.stderr.text()]);
				const describe = (read) => read.status === 'rejected'
					? { name: read.reason?.name, limit: read.reason?.limit,
						captured: read.reason?.captured, total: read.reason?.total,
						instanceOf: read.reason instanceof BunCompatOutputLimitError }
					: { status: 'fulfilled', value: read.value };
				console.log(JSON.stringify({ exitCode: await proc.exited,
					sameErrorIdentity: reads[0].status === 'rejected' && reads[1].status === 'rejected'
						&& reads[0].reason === reads[1].reason,
					reads: reads.map(describe) }));
			`,
		);
		expect(result.status).toBe(0);
		const receipt = JSON.parse(result.stdout.trim()) as {
			exitCode: number;
			sameErrorIdentity: boolean;
		};
		expect(receipt.exitCode).not.toBe(0);
		expect(receipt).toMatchObject({
			sameErrorIdentity: true,
			reads: [
				{
					name: 'BunCompatOutputLimitError',
					limit: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
					captured: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
					total: overflowingBytes,
					instanceOf: true,
				},
				{
					name: 'BunCompatOutputLimitError',
					limit: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
					captured: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
					total: overflowingBytes,
					instanceOf: true,
				},
			],
		});
	});

	test('normalizes invalid maxBuffer values to the default without losing small output', async () => {
		const invalidMaxBuffers = [0, 1.5, Infinity];
		const expected = {
			stdout: 'exact stdout',
			stderr: 'exact stderr',
		};
		expect(DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES).toBeGreaterThan(
			new TextEncoder().encode(expected.stdout).byteLength,
		);

		for (const maxBuffer of invalidMaxBuffers) {
			let proc!: BunCompatSubprocess;
			expect(() => {
				proc = spawnNativeChild(
					`process.stdout.write(${JSON.stringify(expected.stdout)}); process.stderr.write(${JSON.stringify(expected.stderr)})`,
					maxBuffer,
				);
			}).not.toThrow();
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				proc.stdout.text(),
				proc.stderr.text(),
			]);
			expect({ exitCode, stdout, stderr }).toEqual({
				exitCode: 0,
				...expected,
			});
		}
	});

	test('normalizes an invalid maxBuffer to the exact default before overflow', async () => {
		const overflowingBytes = DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES + 1;
		const proc = spawnNativeChild(
			`process.stdout.write('O'.repeat(${overflowingBytes}))`,
			0,
		);
		const read = await Promise.allSettled([proc.stdout.text()]);
		const exitCode = await proc.exited;

		expect(exitCode).not.toBe(0);
		expect(read[0]?.status).toBe('rejected');
		if (read[0]?.status !== 'rejected') {
			throw new Error('invalid maxBuffer must still reject overflow');
		}
		expect(read[0].reason).toBeInstanceOf(BunCompatOutputLimitError);
		expect(read[0].reason).toMatchObject({
			limit: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
			captured: DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
			total: overflowingBytes,
		});
	});

	test('repeated text and bytes calls reuse the settled buffered result', async () => {
		const proc = spawnNativeChild(
			"process.stdout.write('repeatable output'); process.stderr.write('')",
			DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES,
		);
		const firstText = proc.stdout.text();
		const secondText = proc.stdout.text();
		const firstBytes = proc.stdout.bytes();
		const secondBytes = proc.stdout.bytes();
		const stderr = proc.stderr.text();
		const [exitCode, textA, textB, bytesA, bytesB, stderrText] =
			await Promise.all([
				proc.exited,
				firstText,
				secondText,
				firstBytes,
				secondBytes,
				stderr,
			]);

		expect({ exitCode, textA, textB, stderr: stderrText }).toEqual({
			exitCode: 0,
			textA: 'repeatable output',
			textB: 'repeatable output',
			stderr: '',
		});
		expect(bytesA).toEqual(new TextEncoder().encode('repeatable output'));
		expect(bytesB).toEqual(bytesA);
	});
});
