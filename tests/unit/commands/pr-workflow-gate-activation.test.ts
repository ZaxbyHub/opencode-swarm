import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSwarmCommandHandler } from '../../../src/commands/index.js';
import {
	_test_exports,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-command-')),
	);
	_test_exports.resetTrackedStateCache();
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR command workflow-gate activation', () => {
	test('activates durable PR_REVIEW and PR_FEEDBACK state from command routing', async () => {
		const handler = createSwarmCommandHandler(directory, {});
		const output = { parts: [] as unknown[] };

		await handler(
			{
				command: 'swarm-pr-review',
				sessionID: 'session-a',
				arguments: 'owner/repo#42',
			},
			output,
		);
		expect(await readPrWorkflowGateState(directory, 'session-a')).toMatchObject(
			{
				mode: 'PR_REVIEW',
			},
		);

		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: 'session-b',
				arguments: 'owner/repo#42',
			},
			output,
		);
		expect(await readPrWorkflowGateState(directory, 'session-b')).toMatchObject(
			{
				mode: 'PR_FEEDBACK',
			},
		);
	});

	test('does not erase an active PR gate when another MODE command runs', async () => {
		const handler = createSwarmCommandHandler(directory, {});
		const output = { parts: [] as unknown[] };
		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: 'session-a',
				arguments: '',
			},
			output,
		);
		await handler(
			{
				command: 'swarm-brainstorm',
				sessionID: 'session-a',
				arguments: 'new objective',
			},
			output,
		);

		expect(await readPrWorkflowGateState(directory, 'session-a')).toMatchObject(
			{
				mode: 'PR_FEEDBACK',
			},
		);
	});

	test('blocks switching PR workflow modes before terminal completion', async () => {
		const handler = createSwarmCommandHandler(directory, {});
		const output = { parts: [] as unknown[] };
		await handler(
			{
				command: 'swarm-pr-review',
				sessionID: 'session-a',
				arguments: 'owner/repo#42',
			},
			output,
		);
		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: 'session-a',
				arguments: 'owner/repo#42',
			},
			output,
		);
		expect(await readPrWorkflowGateState(directory, 'session-a')).toMatchObject(
			{
				mode: 'PR_REVIEW',
			},
		);
	});
});
