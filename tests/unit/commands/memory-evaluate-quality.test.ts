import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { handleMemoryEvaluateCommand } from '../../../src/commands/memory';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let projectDir: string;
const extraDirectories: string[] = [];

beforeEach(async () => {
	projectDir = canonicalMkdtemp('swarm-memory-evaluate-command-');
});

afterEach(async () => {
	await fs.rm(projectDir, { recursive: true, force: true });
	for (const directory of extraDirectories.splice(0)) {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

describe('/swarm memory evaluate retrieval-quality wiring', () => {
	test('manifest selects the held-out corpus instead of legacy fixtures', async () => {
		const manifest = path.resolve(
			'tests/fixtures/memory-recall-heldout/manifest.json',
		);
		const output = await handleMemoryEvaluateCommand(projectDir, [
			'--json',
			'--profiles',
			'lexical',
			'--manifest',
			manifest,
		]);
		const report = JSON.parse(output) as {
			summary: { fixture_count: number; run_count: number };
			runs: Array<{ fixture: string; scenario?: { index_state: string } }>;
		};
		expect(report.summary.fixture_count).toBe(20);
		expect(report.summary.run_count).toBe(20);
		expect(report.runs.every((run) => run.fixture.startsWith('heldout:'))).toBe(
			true,
		);
		expect(
			report.runs.every((run) => run.scenario?.index_state === 'not-measured'),
		).toBe(true);
	});

	test('manifest rejects a custom filename instead of silently using manifest.json', async () => {
		const sourceCorpus = path.resolve('tests/fixtures/memory-recall-heldout');
		const copiedCorpus = path.join(projectDir, 'heldout-corpus');
		await fs.cp(sourceCorpus, copiedCorpus, { recursive: true });
		const customManifest = path.join(copiedCorpus, 'custom.json');
		await fs.copyFile(path.join(copiedCorpus, 'manifest.json'), customManifest);

		const output = await handleMemoryEvaluateCommand(projectDir, [
			'--json',
			'--manifest',
			customManifest,
		]);
		expect(output).toContain('--manifest <file> must be named manifest.json');
	});

	test('manifest rejects a symlink whose canonical target escapes the project', async () => {
		const outside = canonicalMkdtemp('swarm-memory-manifest-outside-');
		extraDirectories.push(outside);
		await fs.writeFile(path.join(outside, 'manifest.json'), '{}');
		const link = path.join(projectDir, 'manifest-link');
		try {
			await fs.symlink(
				outside,
				link,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		} catch {
			// File-system policy may disable links in a local checkout; the
			// canonical-containment path remains covered on link-capable CI hosts.
			return;
		}
		const output = await handleMemoryEvaluateCommand(projectDir, [
			'--manifest',
			path.join(link, 'manifest.json'),
		]);
		expect(output).toContain('escaped the allowed roots');
	});
});
