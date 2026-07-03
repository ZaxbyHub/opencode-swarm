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
	test('executor does not emit a welcome message or create a first-run sentinel', async () => {
		// The welcome/first-run-sentinel feature (and `includeWelcome` on
		// `executeSwarmCommand`) was intentionally removed in
		// fix(config-doctor) #1347 (commit 8c2940de). `executeSwarmCommand`
		// no longer accepts an `includeWelcome` option, and `/swarm help`
		// returns plain help text with no side effects on `.swarm/`.
		const result = await executeSwarmCommand({
			directory: tempDir,
			agents: {},
			sessionID: 's1',
			tokens: ['help'],
		});

		expect(result.text).toContain('## Swarm Commands');
		expect(result.text).not.toContain('Welcome to OpenCode Swarm!');
		expect(
			existsSync(path.join(tempDir, '.swarm', '.first-run-complete')),
		).toBe(false);
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
