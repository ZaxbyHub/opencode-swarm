import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { resetSwarmState } from '../../../src/state';
import { createPluginHostProject } from '../../helpers/plugin-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import {
	createRetroBundle,
	createSwarmFiles,
	DEFAULT_PLUGIN_CONFIG,
	invokeHook,
} from '../../helpers/system-enhancer-test-helpers';

describe('System Enhancer - Coder retrospective cap', () => {
	let tempDir: string;
	const config: PluginConfig = DEFAULT_PLUGIN_CONFIG;

	beforeEach(() => {
		tempDir = createPluginHostProject('swarm-retro-coder-cap-');
		resetSwarmState();
	});

	afterEach(() => {
		safeRmRecursive(tempDir);
	});

	it('injects the condensed coder format rather than the full architect block', async () => {
		await createSwarmFiles(tempDir, 2);
		await createRetroBundle(
			tempDir,
			1,
			'pass',
			['lesson A', 'lesson B'],
			['reason X'],
			'Phase 1 completed successfully.',
		);

		const systemOutput = await invokeHook(
			config,
			tempDir,
			'swarm-retro-coder-format-session',
			'coder',
		);
		const coderRetro = systemOutput.find((text) =>
			text.includes('[SWARM RETROSPECTIVE] From Phase 1:'),
		);

		expect(coderRetro).toBeDefined();
		expect(coderRetro).toContain('Phase 1 completed successfully.');
		expect(coderRetro).toContain('lesson A');
		expect(coderRetro).toContain('lesson B');
		expect(
			systemOutput.some((text) =>
				text.includes('## Previous Phase Retrospective'),
			),
		).toBe(false);
	});

	it('does not inject a retrospective for coder in Phase 1', async () => {
		await createSwarmFiles(tempDir, 1);
		await createRetroBundle(tempDir, 2, 'pass', ['future phase lesson']);

		const systemOutput = await invokeHook(
			config,
			tempDir,
			'swarm-retro-coder-phase-one-session',
			'coder',
		);

		expect(
			systemOutput.some((text) => text.includes('[SWARM RETROSPECTIVE]')),
		).toBe(false);
	});

	it('keeps coder retrospective injection within the 400-character cap', async () => {
		await createSwarmFiles(tempDir, 2);
		const longLesson =
			'This is a very long lesson that adds many characters to test the 400 character cap for coder injection '.repeat(
				20,
			);
		await createRetroBundle(
			tempDir,
			1,
			'pass',
			[longLesson, longLesson, longLesson, longLesson, longLesson],
			[longLesson],
			'Phase 1 completed',
		);

		const systemOutput = await invokeHook(
			config,
			tempDir,
			'swarm-retro-coder-cap-session',
			'coder',
		);
		const coderRetro = systemOutput.find((text) =>
			text.includes('[SWARM RETROSPECTIVE]'),
		);

		expect(coderRetro).toBeDefined();
		expect(coderRetro!.length).toBeLessThanOrEqual(400);
	});
});
