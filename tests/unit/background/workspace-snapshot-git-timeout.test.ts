import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	resolveCurrentGitHeadAsync,
} from '../../../src/background/workspace-snapshot';
import type {
	BunCompatSpawnOptions,
	BunCompatStream,
	BunCompatSubprocess,
} from '../../../src/utils/bun-compat';

const originalBunSpawn = _internals.bunSpawn;
const originalGitTimeoutMs = _internals.gitTimeoutMs;

async function withTestDeadline<T>(promise: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error('test deadline exceeded')),
					500,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function neverEndingStream(): BunCompatStream {
	const stream = new ReadableStream<Uint8Array>();
	return {
		text: async () => '',
		bytes: async () => new Uint8Array(),
		getReader: () => stream.getReader(),
	};
}

afterEach(() => {
	_internals.bunSpawn = originalBunSpawn;
	_internals.gitTimeoutMs = originalGitTimeoutMs;
});

describe('workspace snapshot Git timeout cleanup (PRR-006)', () => {
	test('returns bounded and kills the complete process tree in finally', async () => {
		let spawnOptions: BunCompatSpawnOptions | undefined;
		const kill = mock(() => undefined);
		_internals.gitTimeoutMs = 20;
		_internals.bunSpawn = ((_cmd, options) => {
			spawnOptions = options;
			return {
				stdout: neverEndingStream(),
				stderr: neverEndingStream(),
				exited: new Promise<number>(() => undefined),
				exitCode: null,
				kill,
			} satisfies BunCompatSubprocess;
		}) as typeof _internals.bunSpawn;

		await expect(
			withTestDeadline(resolveCurrentGitHeadAsync(process.cwd())),
		).resolves.toBeNull();
		expect(spawnOptions).toMatchObject({
			cwd: process.cwd(),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 20,
			killProcessTree: true,
		});
		// Prior code called ChildProcess.kill(), which targets only the direct Git
		// PID on Windows. The tree-aware subprocess abstraction is now used for
		// both its timeout and the unconditional finally cleanup.
		expect(kill).toHaveBeenCalledWith('SIGKILL');
	});
});
