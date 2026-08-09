import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSwarmCommandHandler } from '../../../src/commands/index.js';

let directory = '';
const sessionID = 'swarm-issue-shortcut-session';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'swarm-issue-shortcut-')),
	);
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

async function runIssue(arguments_: string): Promise<string> {
	const handler = createSwarmCommandHandler(directory, {});
	const output = { parts: [] as unknown[] };
	await handler(
		{ command: 'swarm-issue', arguments: arguments_, sessionID },
		output,
	);
	expect(output.parts).toHaveLength(1);
	return (output.parts[0] as { text: string }).text;
}

describe('swarm-issue shortcut routing', () => {
	test('returns usage text when no arguments are provided', async () => {
		const text = await runIssue('');
		expect(text).toContain('Usage: /swarm issue');
		expect(text).toContain('--plan');
		expect(text).toContain('--trace');
		expect(text).toContain('--no-repro');
		expect(text).not.toContain('## Swarm Commands');
	});

	test('returns a mode signal for a valid GitHub issue URL', async () => {
		const text = await runIssue('https://github.com/owner/repo/issues/42');
		expect(text).toContain('[MODE: ISSUE_INGEST');
		expect(text).toContain('github.com/owner/repo/issues/42');
		expect(text).not.toContain('## Swarm Commands');
	});

	test('returns usage text for an invalid issue URL', async () => {
		const text = await runIssue('not-a-valid-issue');
		expect(text).toContain('Error:');
		expect(text).toContain('Usage: /swarm issue');
	});

	test('forwards the plan and trace flags', async () => {
		const planned = await runIssue(
			'https://github.com/owner/repo/issues/42 --plan',
		);
		expect(planned).toContain('[MODE: ISSUE_INGEST');
		expect(planned).toContain('plan=true');
		const traced = await runIssue(
			'https://github.com/owner/repo/issues/42 --trace',
		);
		expect(traced).toContain('[MODE: ISSUE_INGEST');
		expect(traced).toContain('trace=true');
	});

	test('accepts owner/repo#N shorthand format', async () => {
		const text = await runIssue('owner/repo#42');
		expect(text).toContain('[MODE: ISSUE_INGEST');
		expect(text).toContain('github.com/owner/repo/issues/42');
	});
});
