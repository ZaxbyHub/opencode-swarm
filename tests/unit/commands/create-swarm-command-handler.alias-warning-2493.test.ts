/**
 * Tool-routed alias deprecation warning (#2493 review F-07).
 *
 * The direct-execute path prepends `resolved.warning`, but the tool-routed
 * path (`routeToSwarmCommandTool`) silently dropped it — an agent typing
 * `/swarm plan` in chat got the canonical `swarm_command` routing message
 * with no signal that the typed form is deprecated.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSwarmCommandHandler } from '../../../src/commands/index.js';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-alias-')));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('tool-routed alias warning (#2493 review F-07)', () => {
	test('routing message for deprecated alias includes the warning text', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'plan' },
			output,
		);

		const text = (output.parts[0] as { text: string }).text;
		expect(text).toContain('swarm_command');
		expect(text.toLowerCase()).toContain('deprecated');
		// The routing still targets the canonical command.
		expect(text).toContain('show-plan');
	});

	test('routing message for a canonical command carries no alias warning', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'show-plan' },
			output,
		);

		const text = (output.parts[0] as { text: string }).text;
		expect(text).toContain('swarm_command');
		expect(text.toLowerCase()).not.toContain('deprecated');
	});
});
