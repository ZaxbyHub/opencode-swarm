import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeSwarmCommand } from './command-dispatch';
import { createSwarmCommandHandler } from './index';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'first-run-test-')),
	);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('first-run sentinel behavior', () => {
	it('executor creates first-run sentinel only when welcome is requested', async () => {
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

	it('hook routing does not create .swarm side effects', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm-agents', arguments: '', sessionID: 's1' },
			output,
		);

		expect(existsSync(path.join(tempDir, '.swarm'))).toBe(false);
		expect((output.parts[0] as { text: string }).text).toContain(
			'swarm_command',
		);
	});
});
