import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// #3601 AC1: scripts/check-publication-body-order.sh is the local mirror of
// the remote pr-standards section-ORDER contract. The diagnostic must name
// the FOUND order (found sequence textually ahead of the required sequence on
// the diagnostic line) and contain the literal `section order`.

const SCRIPT = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'scripts',
	'check-publication-body-order.sh',
);

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('body-order-test-');
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

function run(body: string): { status: number; output: string } {
	const bodyPath = path.join(directory, 'body.md');
	writeFileSync(bodyPath, body, 'utf-8');
	const [shell, ...args] = bashCommand(SCRIPT, bodyPath);
	const result = spawnSync(shell, args, {
		cwd: directory,
		encoding: 'utf-8',
		stdin: 'ignore',
		timeout: 10_000,
	});
	return {
		status: result.status ?? -1,
		output: `${result.stdout}${result.stderr}`,
	};
}

const ORDERED = '## Summary\ns\n\n## Invariant audit\ni\n\n## Test plan\nt\n';

describe('check-publication-body-order (#3601 AC1)', () => {
	test('ordered body passes silently', () => {
		const { status, output } = run(ORDERED);
		expect(status).toBe(0);
		expect(output.trim()).toBe('');
	}, 30_000);

	test('out-of-order body is refused with a found-order diagnostic', () => {
		const { status, output } = run(
			'## Test plan\nt\n\n## Summary\ns\n\n## Invariant audit\ni\n',
		);
		expect(status).toBe(1);
		expect(output).toContain('section order');
		// Found order names Test plan ahead of Summary on the diagnostic line.
		const line =
			output.split('\n').find((l) => l.includes('section order')) ?? '';
		expect(line.indexOf('Test plan')).toBeGreaterThan(0);
		expect(line.indexOf('Test plan')).toBeLessThan(line.indexOf('Summary'));
	}, 30_000);

	test('every non-canonical permutation is refused', () => {
		const sections = ['## Summary', '## Invariant audit', '## Test plan'];
		const permutations: string[][] = [
			[sections[0]!, sections[2]!, sections[1]!],
			[sections[1]!, sections[0]!, sections[2]!],
			[sections[1]!, sections[2]!, sections[0]!],
			[sections[2]!, sections[0]!, sections[1]!],
			[sections[2]!, sections[1]!, sections[0]!],
		];
		for (const perm of permutations) {
			const { status } = run(perm.map((s) => `${s}\nx\n`).join('\n'));
			expect(status).toBe(1);
		}
	}, 60_000);

	test('a missing section is refused as missing, not as order', () => {
		const { status, output } = run('## Summary\ns\n\n## Test plan\nt\n');
		expect(status).toBe(1);
		expect(output).toContain('missing required section: ## Invariant audit');
		expect(output).not.toContain('section order:');
	}, 30_000);

	test('prose mentions do not count as headings (anchored grammar)', () => {
		const { status } = run(
			'Intro mentions ## Summary in prose.\n\n## Summary\ns\n\n## Invariant audit\ni\n\n## Test plan\nt\n',
		);
		expect(status).toBe(0);
	}, 30_000);
});
