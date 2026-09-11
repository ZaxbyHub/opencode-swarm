import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { handleResetSessionCommand } from '../../../src/commands/reset-session';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('/swarm reset-session footer disclosure (issue #2703)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('reset-sb-footer-'));
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('no longer claims ALL circuit breakers were cleared', async () => {
		const output = await handleResetSessionCommand(directory, [], 'sess-1');
		expect(output).not.toContain(
			'All circuit breakers and revision limits have been cleared',
		);
	});

	test('discloses that durable per-task retry gates survive the reset', async () => {
		const output = await handleResetSessionCommand(directory, [], 'sess-1');
		expect(output).toMatch(/In-memory circuit breakers/i);
		expect(output).toMatch(/durable per-task retry gates/i);
		expect(output).toMatch(/intentionally survive this reset/i);
	});

	test('points a TASK_RETRY_CRITIC_REQUIRED-blocked task at the recovery tool', async () => {
		const output = await handleResetSessionCommand(directory, [], 'sess-1');
		expect(output).toContain('TASK_RETRY_CRITIC_REQUIRED');
		expect(output).toContain('approve_retry_sounding_board');
	});
});
