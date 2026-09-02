import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyToolInvocationFailure } from '../../../src/failures/invocation-failure.js';

test('adversarial provider prose in shell output stays a shell exit', () => {
	const record = classifyToolInvocationFailure({
		tool: 'bash',
		args: { command: 'run-check' },
		output: `${'a'.repeat(100_000)} quota 429 temporarily unavailable`,
		error: 'command failed',
		metadata: { exit: 2 },
	});
	expect(record).toMatchObject({ source: 'shell', category: 'shell.exit' });
	expect(
		Buffer.byteLength(record?.evidence.display ?? '', 'utf8'),
	).toBeLessThanOrEqual(512);
});

test('guardrails contains no shared agent-model assignment', () => {
	const root = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		'../../..',
	);
	const source = readFileSync(
		path.join(root, 'src/hooks/guardrails/index.ts'),
		'utf8',
	);
	expect(source).not.toMatch(/swarmAgents\[[^\]]+\]\.model\s*=/);
});
