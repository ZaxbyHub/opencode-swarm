import { afterEach, describe, expect, test } from 'bun:test';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import {
	_internals,
	runExternalTool,
} from '../../../src/utils/external-tool-runner';

const originalBunSpawn = _internals.bunSpawn;

function emptyStream(): BunCompatSubprocess['stdout'] {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
	return {
		getReader: () => stream.getReader(),
		text: async () => '',
		bytes: async () => new Uint8Array(),
	};
}

afterEach(() => {
	_internals.bunSpawn = originalBunSpawn;
});

describe('external tool signal termination', () => {
	test('returns a typed abnormal outcome for a naturally signaled child', async () => {
		_internals.bunSpawn = (() => ({
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited: Promise.resolve(-1),
			exitCode: null,
			signalCode: 'SIGKILL',
			kill: () => undefined,
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 1_000,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		expect(result).toMatchObject({
			status: 'spawn-error',
			exitCode: -1,
			message: 'external tool terminated by signal SIGKILL',
		});
	});
});
