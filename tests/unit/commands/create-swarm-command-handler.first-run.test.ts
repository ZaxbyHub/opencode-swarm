import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createSwarmCommandHandler,
	executeSwarmCommand,
} from '../../../src/commands/index.js';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-first-')));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('first-run sentinel', () => {
	test('executor can include welcome and create sentinel explicitly', async () => {
		const result = await executeSwarmCommand({
			directory: tempDir,
			agents: {},
			sessionID: 's1',
			tokens: ['help'],
			includeWelcome: true,
		});

		expect(result.text).toContain('Welcome to OpenCode Swarm!');
		expect(
			existsSync(path.join(tempDir, '.swarm', '.first-run-complete')),
		).toBe(true);
	});

	test('command hook routing does not create first-run side effects', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const output = { parts: [] as unknown[] };

		await handler({ command: 'swarm', sessionID: 's1', arguments: '' }, output);

		expect(existsSync(path.join(tempDir, '.swarm'))).toBe(false);
		expect((output.parts[0] as { text: string }).text).toContain(
			'## Swarm Commands',
		);
	});
});
