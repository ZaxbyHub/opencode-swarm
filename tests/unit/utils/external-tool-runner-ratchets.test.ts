import { afterEach, describe, expect, test } from 'bun:test';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import {
	_internals,
	runExternalTool,
} from '../../../src/utils/external-tool-runner';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const originalBunSpawn = _internals.bunSpawn;
const originalWarn = _internals.warn;

function stream(text: string): BunCompatSubprocess['stdout'] {
	const bytes = new TextEncoder().encode(text);
	return {
		text: async () => text,
		bytes: async () => bytes,
		getReader: () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}).getReader(),
	};
}

afterEach(() => {
	_internals.bunSpawn = originalBunSpawn;
	_internals.warn = originalWarn;
});

describe('external-tool-runner authority ratchets — issue #1248/#2479', () => {
	test('bounds multibyte output by UTF-8 bytes without emitting a split code point', async () => {
		_internals.bunSpawn = (() => ({
			stdout: stream('é'.repeat(20)),
			stderr: stream(''),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => undefined,
		})) as typeof originalBunSpawn;
		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: canonicalTmpDir(),
			timeoutMs: 1_000,
			maxStdoutBytes: 9,
			maxStderrBytes: 10,
		});
		expect(result.stdoutTruncated).toBe(true);
		expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(9);
		expect(result.stdout).toBe('éééé');
	});

	test('logs non-ESRCH kill failures but keeps already-gone processes quiet', async () => {
		for (const [code, expectedWarnings] of [
			['EPERM', 3],
			['ESRCH', 0],
		] as const) {
			const warnings: string[] = [];
			_internals.warn = (message) => warnings.push(message);
			_internals.bunSpawn = (() => {
				const error = Object.assign(new Error(code), { code });
				return {
					stdout: stream(''),
					stderr: stream(''),
					exited: new Promise<number>(() => undefined),
					exitCode: null,
					kill: () => {
						throw error;
					},
				};
			}) as typeof originalBunSpawn;
			await runExternalTool({
				executable: 'fake-tool',
				args: [],
				cwd: canonicalTmpDir(),
				timeoutMs: 1,
				maxStdoutBytes: 10,
				maxStderrBytes: 10,
			});
			expect(warnings).toHaveLength(expectedWarnings);
			expect(warnings.every((message) => message.includes('kill failed'))).toBe(
				true,
			);
		}
	});
});
