import { describe, expect, test } from 'bun:test';
import { _internals } from '../../../src/tools/prepare-pr-workflow-checkout.js';

const MAX_GIT_STDOUT_BYTES = 1024 * 1024;

describe('prepare_pr_workflow_checkout bounded Git stdout', () => {
	test('accepts the exact byte ceiling without invoking overflow termination', async () => {
		let overflowCalls = 0;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_GIT_STDOUT_BYTES));
				controller.close();
			},
		});

		const output = await _internals.readBoundedGitStdout(stream, () => {
			overflowCalls += 1;
		});
		expect(output.length).toBe(MAX_GIT_STDOUT_BYTES);
		expect(overflowCalls).toBe(0);
	});

	test('rejects one byte over the ceiling, terminates, and cancels the reader', async () => {
		let overflowCalls = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_GIT_STDOUT_BYTES));
				controller.enqueue(new Uint8Array(1));
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			_internals.readBoundedGitStdout(stream, () => {
				overflowCalls += 1;
			}),
		).rejects.toThrow('Git output exceeded the safe capture limit');
		expect(overflowCalls).toBe(1);
		expect(cancelled).toBe(true);
	});
});
