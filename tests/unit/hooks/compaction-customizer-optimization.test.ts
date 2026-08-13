import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createCompactionCustomizerHook } from '../../../src/hooks/compaction-customizer';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const defaultConfig: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

async function compact(directory: string): Promise<string> {
	const hook = createCompactionCustomizerHook(defaultConfig, directory);
	const handler = hook['experimental.session.compacting'] as Function;
	const output = { context: [] as string[] };
	await handler({ sessionID: 'test-session' }, output);
	return output.context.at(-1) ?? '';
}

describe('compaction stored-output facts', () => {
	let tempDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: tempDir, cleanup } = createSafeTestDir('swarm-compaction-output-'));
		const swarmDir = join(tempDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		writeFileSync(join(swarmDir, 'plan.md'), '');
		writeFileSync(join(swarmDir, 'context.md'), '');
	});

	afterEach(() => {
		cleanup();
	});

	it('records optimization and stored-output facts when summaries exist', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		mkdirSync(summariesDir, { recursive: true });
		writeFileSync(join(summariesDir, 'summary-1.md'), 'Summary 1');
		writeFileSync(join(summariesDir, 'summary-2.md'), 'Summary 2');

		const block = await compact(tempDir);

		expect(block).toContain('[CONTEXT OPTIMIZATION STATE]');
		expect(block).toContain('[STORED OUTPUTS]\n2 tool outputs');
		expect(block).toContain('retrievable through /swarm retrieve <id>');
	});

	it('uses singular grammar for one stored output', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		mkdirSync(summariesDir, { recursive: true });
		writeFileSync(join(summariesDir, 'summary-1.md'), 'Summary 1');

		expect(await compact(tempDir)).toContain(
			'[STORED OUTPUTS]\n1 tool output ',
		);
	});

	it('counts all stored outputs', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		mkdirSync(summariesDir, { recursive: true });
		for (let index = 1; index <= 3; index += 1) {
			writeFileSync(
				join(summariesDir, `summary-${index}.md`),
				`Summary ${index}`,
			);
		}

		expect(await compact(tempDir)).toContain(
			'[STORED OUTPUTS]\n3 tool outputs',
		);
	});

	it('omits stored-output facts when the summaries directory is absent', async () => {
		rmSync(join(tempDir, '.swarm', 'summaries'), {
			recursive: true,
			force: true,
		});

		const block = await compact(tempDir);

		expect(block).not.toContain('[CONTEXT OPTIMIZATION STATE]');
		expect(block).not.toContain('[STORED OUTPUTS]');
	});

	it('omits stored-output facts when the summaries directory is empty', async () => {
		mkdirSync(join(tempDir, '.swarm', 'summaries'), { recursive: true });

		const block = await compact(tempDir);

		expect(block).not.toContain('[CONTEXT OPTIMIZATION STATE]');
		expect(block).not.toContain('[STORED OUTPUTS]');
	});
});
