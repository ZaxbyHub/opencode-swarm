import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeCompletionVerify } from '../../../src/tools/completion-verify.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';

afterEach(() => {
	if (directory) fs.rmSync(directory, { recursive: true, force: true });
	directory = '';
});

test('observational completion verification does not write evidence', async () => {
	directory = canonicalMkdtemp('completion-verify-observational-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			phases: [
				{
					id: 1,
					name: 'implementation',
					tasks: [
						{
							id: '1.1',
							description: 'Implement `observablePhaseGate`.',
							status: 'completed',
							files_touched: ['src/gate.ts'],
						},
					],
				},
			],
		}),
	);
	fs.writeFileSync(
		path.join(directory, 'src', 'gate.ts'),
		'export function observablePhaseGate() { return true; }\n',
	);

	const result = JSON.parse(
		await executeCompletionVerify(
			{ phase: 1, writeEvidence: false },
			directory,
		),
	);

	expect(result.status).toBe('passed');
	expect(
		fs.existsSync(
			path.join(directory, '.swarm', 'evidence', '1', 'completion-verify.json'),
		),
	).toBe(false);
});
