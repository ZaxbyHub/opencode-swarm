import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	invokeHook,
	setupTempDir,
} from '../../helpers/system-enhancer-test-helpers';

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
	const temp = await setupTempDir('system-enhancer-reflection-');
	root = await realpath(temp.tempDir);
	cleanup = temp.cleanup;
	const reflectionDir = join(root, '.swarm', 'reflections');
	await mkdir(reflectionDir, { recursive: true });
	await writeFile(
		join(reflectionDir, 'lessons.json'),
		JSON.stringify({
			preferred: [
				{
					memoryId: 'mem_preferred',
					text: 'Use the bounded parser.',
					anchor: { file: 'src/parser.ts', symbol: 'parse' },
				},
			],
			deadEnds: [
				{ memoryId: 'mem_dead', text: 'Do not use the legacy parser.' },
			],
			corrections: [
				{ memoryId: 'mem_corrected', correction: 'The loader is async.' },
			],
		}),
		'utf-8',
	);
});

afterEach(async () => {
	await cleanup();
});

function reflectionConfig(
	enabled: boolean,
	scoringEnabled = false,
	maxInjectionTokens = 4000,
): PluginConfig {
	return {
		memory: {
			enabled,
			reflection: { enabled: true, halfLifeDays: 30 },
		},
		context_budget: {
			max_injection_tokens: maxInjectionTokens,
			scoring: { enabled: scoringEnabled },
		},
	} as PluginConfig;
}

describe('system enhancer reflection injection', () => {
	test('does not inject a persisted digest while memory is disabled', async () => {
		const output = await invokeHook(reflectionConfig(false), root);

		expect(output.join('\n')).not.toContain('SWARM MEMORY REFLECTION');
	});

	test.each([
		false,
		true,
	])('injects through the shared budget path when scoring=%s', async (scoringEnabled) => {
		const output = await invokeHook(
			reflectionConfig(true, scoringEnabled),
			root,
		);
		const rendered = output.join('\n');

		expect(rendered).toContain('SWARM MEMORY REFLECTION');
		expect(rendered).toContain('Use the bounded parser.');
		expect(rendered).toContain('Do not use the legacy parser.');
		expect(rendered).toContain('The loader is async.');
	});

	test('skips the digest when the system-enhancer allocation is exhausted', async () => {
		const output = await invokeHook(reflectionConfig(true, false, 1), root);

		expect(output.join('\n')).not.toContain('SWARM MEMORY REFLECTION');
	});
});
