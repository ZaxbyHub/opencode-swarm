import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Same bundler-resolved version the export service embeds (#1662) — asserting
// against it keeps this test correct across future releases instead of
// pinning a literal that drifts.
import packageJson from '../../../package.json' with { type: 'json' };
import { handleExportCommand } from '../../../src/commands/export';

describe('handleExportCommand', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-export-test-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('Both files present', async () => {
		// Create both plan.md and context.md
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
- [x] Task 2

## Phase 2

- [ ] Task 3
`,
		);

		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`# Swarm Context

## Current State
Working on Phase 1

## Recent Decisions
- Decided to use TypeScript
- Chose Bun as runtime
`,
		);

		const result = await handleExportCommand(tempDir, []);

		expect(result).toContain('## Swarm Export');
		expect(result).toContain('```json');
		expect(result).toContain(`"version": "${packageJson.version}"`);
		expect(result).toContain('"plan":');
		expect(result).toContain('"context":');
		expect(result).toContain('```');

		// Verify plan content is in the JSON
		expect(result).toContain('## Phase 1');
		expect(result).toContain('Task 1');

		// Verify context content is in the JSON
		expect(result).toContain('Swarm Context');
		expect(result).toContain('Current State');
	});

	test('Plan missing', async () => {
		// Create only context.md
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`# Swarm Context

## Current State
Working on Phase 1
`,
		);

		const result = await handleExportCommand(tempDir, []);

		expect(result).toContain('## Swarm Export');
		expect(result).toContain('```json');
		expect(result).toContain('"plan": null');
		expect(result).toContain('"context":');
		expect(result).toContain('```');
	});

	test('structured export preserves the complete execution profile', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Export profile',
				swarm: 'export-profile',
				phases: [{ id: 1, name: 'One', status: 'pending', tasks: [] }],
				execution_profile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
					council_parallel: false,
					locked: true,
					auto_proceed: true,
					commit_after_each_completed_task: true,
				},
			}),
		);

		const result = await handleExportCommand(tempDir, []);
		expect(result).toContain('"auto_proceed": true');
		expect(result).toContain('"commit_after_each_completed_task": true');
	});

	test('Context missing', async () => {
		// Create only plan.md
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1

- [ ] Task 1
- [x] Task 2
`,
		);

		const result = await handleExportCommand(tempDir, []);

		expect(result).toContain('## Swarm Export');
		expect(result).toContain('```json');
		expect(result).toContain('"plan":');
		expect(result).toContain('"context": null');
		expect(result).toContain('```');
	});

	test('Both files missing', async () => {
		// Create empty .swarm directory
		const result = await handleExportCommand(tempDir, []);

		expect(result).toContain('## Swarm Export');
		expect(result).toContain('```json');
		expect(result).toContain('"plan": null');
		expect(result).toContain('"context": null');
		expect(result).toContain('```');
	});

	test('Output contains code fence', async () => {
		const result = await handleExportCommand(tempDir, []);

		expect(result).toContain('```json');
		expect(result).toContain('```');
	});

	test('JSON version field matches the plugin package version', async () => {
		const result = await handleExportCommand(tempDir, []);

		expect(result).toContain(`"version": "${packageJson.version}"`);
		// Regression guard for #1662: the field was previously a hardcoded
		// '4.5.0' literal that drifted from the real package version.
		expect(packageJson.version).not.toBe('4.5.0');
	});

	test('JSON includes exported timestamp', async () => {
		const result = await handleExportCommand(tempDir, []);

		// Should contain an ISO timestamp for exported field
		expect(result).toMatch(
			/"exported": "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/,
		);
	});
});
