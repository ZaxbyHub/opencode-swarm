import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	_test_exports,
	createCompactionCustomizerHook,
} from '../../../src/hooks/compaction-customizer';
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

describe('ADVERSARIAL: compaction summaries directory', () => {
	let tempDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: tempDir, cleanup } = createSafeTestDir('swarm-compaction-fs-'));
		const swarmDir = join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(join(swarmDir, 'plan.md'), '');
		fs.writeFileSync(join(swarmDir, 'context.md'), '');
	});

	afterEach(() => {
		cleanup();
	});

	it('does not expose filenames or contents from a symlink target', async () => {
		const external = createSafeTestDir('swarm-compaction-external-');
		fs.writeFileSync(join(external.dir, 'secret-file.md'), 'SECRET DATA');
		const summariesPath = join(tempDir, '.swarm', 'summaries');

		try {
			try {
				await fs.promises.symlink(external.dir, summariesPath, 'dir');
			} catch {
				// Windows installations without developer mode cannot create this
				// symlink. The remaining adversarial cases still cover name leakage.
				return;
			}

			const block = await compact(tempDir);
			expect(block).not.toContain('[STORED OUTPUTS]');
			expect(block).not.toContain('SECRET DATA');
			expect(block).not.toContain('secret-file.md');
		} finally {
			external.cleanup();
		}
	});

	it('reports only a count and does not expose stored-output filenames', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		fs.mkdirSync(summariesDir, { recursive: true });
		fs.writeFileSync(join(summariesDir, 'secret-filename.md'), 'secret');
		fs.writeFileSync(join(summariesDir, '${env.SECRET}.md'), 'secret');

		expect(await _test_exports.countStoredOutputs(tempDir)).toEqual({
			count: 2,
			truncated: false,
		});
		const block = await compact(tempDir);
		expect(block).toContain('[STORED OUTPUTS]\n2 tool outputs');
		expect(block).not.toContain('secret-filename.md');
		expect(block).not.toContain('${env.SECRET}');
	});

	it('bounds stored-output enumeration and context growth', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		fs.mkdirSync(summariesDir, { recursive: true });
		for (let index = 0; index < 300; index += 1) {
			fs.writeFileSync(join(summariesDir, `output-${index}.md`), 'content');
		}

		const block = await compact(tempDir);

		expect(block).toContain('[STORED OUTPUTS]\nAt least 256 tool outputs');
		expect(block.length).toBeLessThanOrEqual(8_000);
	});

	it('fails open when summaries metadata is unreadable', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		fs.mkdirSync(summariesDir, { recursive: true });
		const original = _test_exports.compactionFs.lstat;
		_test_exports.compactionFs.lstat = (async () => {
			const error = new Error('Permission denied') as NodeJS.ErrnoException;
			error.code = 'EPERM';
			throw error;
		}) as typeof original;

		try {
			const block = await compact(tempDir);
			expect(block).toContain('[KNOWLEDGE STATE]');
			expect(block).not.toContain('[STORED OUTPUTS]');
		} finally {
			_test_exports.compactionFs.lstat = original;
		}
	});

	it('fails open on a bounded deadline when directory opening stalls', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		fs.mkdirSync(summariesDir, { recursive: true });
		const original = _test_exports.compactionFs.opendir;
		_test_exports.compactionFs.opendir = (() =>
			new Promise(() => {})) as typeof original;

		try {
			const outcome = await Promise.race([
				compact(tempDir).then((block) => ({
					kind: 'completed' as const,
					block,
				})),
				Bun.sleep(2_000).then(() => ({ kind: 'watchdog' as const })),
			]);
			expect(outcome.kind).toBe('completed');
			if (outcome.kind === 'completed') {
				expect(outcome.block).toContain('[KNOWLEDGE STATE]');
				expect(outcome.block).not.toContain('[STORED OUTPUTS]');
			}
		} finally {
			_test_exports.compactionFs.opendir = original;
		}
	});

	it('fails open when summaries is a file instead of a directory', async () => {
		fs.writeFileSync(
			join(tempDir, '.swarm', 'summaries'),
			'I am a file, not a directory',
		);

		const block = await compact(tempDir);

		expect(block).toContain('[KNOWLEDGE STATE]');
		expect(block).not.toContain('[CONTEXT OPTIMIZATION STATE]');
		expect(block).not.toContain('[STORED OUTPUTS]');
	});

	it('fails open when the summaries directory disappears before opening', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		fs.mkdirSync(summariesDir, { recursive: true });
		const original = _test_exports.compactionFs.opendir;
		let opendirCalls = 0;
		_test_exports.compactionFs.opendir = (async () => {
			opendirCalls += 1;
			const error = new Error('Missing') as NodeJS.ErrnoException;
			error.code = 'ENOENT';
			throw error;
		}) as typeof original;

		try {
			const block = await compact(tempDir);
			expect(opendirCalls).toBe(1);
			expect(block).toContain('[KNOWLEDGE STATE]');
			expect(block).not.toContain('[STORED OUTPUTS]');
		} finally {
			_test_exports.compactionFs.opendir = original;
		}
	});
});
