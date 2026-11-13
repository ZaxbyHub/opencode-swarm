import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// #3605 AC4 (ABSORB-refined): cost-yield-ledger.sh pairs cost with yield on
// the same row for every lane, renders the derived per-request context
// ((input+cache_read+cache_creation)/requests; never reasoning_tokens; output
// excluded), renders zero-request lanes as n/a while still pairing, and states
// the pooled per-finding aggregate (exact values asserted).

const ROOT = path.join(import.meta.dir, '..', '..', '..');
const SCRIPT = path.join(
	ROOT,
	'.opencode',
	'skills',
	'swarm-pr-review',
	'scripts',
	'cost-yield-ledger.sh',
);

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('cost-yield-test-');
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

const HEADER =
	'id\telapsed_min\ttool_uses\trequests\tinput_tokens\tcache_read_input_tokens\tcache_creation_input_tokens\toutput_tokens\tactionable_findings';

async function writeLedger(name: string, rows: string[]): Promise<string> {
	const target = path.join(directory, name);
	await fs.writeFile(target, [HEADER, ...rows].join('\n') + '\n', 'utf-8');
	return target;
}

function run(input: string): { status: number; output: string } {
	const [shell, ...rest] = bashCommand(
		path.relative(ROOT, SCRIPT),
		path.relative(ROOT, input),
	);
	const result = spawnSync(shell, rest, {
		cwd: ROOT,
		encoding: 'utf-8',
		stdin: 'ignore',
		timeout: 30_000,
	});
	return {
		status: result.status ?? -1,
		output: `${result.stdout}${result.stderr}`,
	};
}

describe('cost-yield-ledger (#3605 AC4)', () => {
	test('renders paired rows with exact derived figures and the pooled aggregate', async () => {
		const input = await writeLedger('ok.tsv', [
			'lane-a\t12\t8\t3\t50000\t120000\t8000\t9000\t2',
			'lane-b\t7\t4\t2\t30000\t90000\t5000\t6000\t1',
			'lane-c\t3\t2\t0\t\t\t\t\t0',
		]);
		const { status, output } = run(input);
		expect(status).toBe(0);
		expect(output).toContain('COST-YIELD-LEDGER: ok lanes=3');
		// Exact arithmetic: lane-a derived = (50000+120000+8000)/3 = 59333.3;
		// aggregate = (178000+125000+0)/3 = 101000.0.
		expect(output).toContain('lane-a  cost: 59333.3 ctx/req');
		expect(output).toContain('per-finding cost: 101000.0');
		// Pairing: every lane row carries both a cost figure and a yield figure.
		for (const lane of ['lane-a', 'lane-b', 'lane-c']) {
			// Two-space separator: 'lane-c' would otherwise prefix-match the
			// rendered header line ('lane-cost-yield-ledger ...').
			const line =
				output.split('\n').find((l) => l.startsWith(`${lane}  `)) ?? '';
			expect(line).toContain('cost:');
			expect(line).toContain('yield:');
		}
		// Zero-request lane renders n/a and still pairs with its yield.
		expect(output).toContain('lane-c  cost: n/a (zero requests)');
	}, 60_000);

	test('a row missing its yield field is refused unpaired', async () => {
		const input = await writeLedger('unpaired.tsv', [
			'lane-a\t12\t8\t3\t50000\t120000\t8000\t9000',
		]);
		const { status, output } = run(input);
		expect(status).toBe(1);
		expect(output).toContain('LEDGER-REFUSED: unpaired');
	}, 60_000);

	test('zero total findings renders the n/a aggregate, not a divide-by-zero', async () => {
		const input = await writeLedger('zero.tsv', [
			'lane-a\t5\t3\t1\t1000\t0\t0\t100\t0',
		]);
		const { status, output } = run(input);
		expect(status).toBe(0);
		expect(output).toContain(
			'per-finding cost: n/a (zero actionable findings)',
		);
	}, 60_000);

	test('a wrong header is refused', async () => {
		const target = path.join(directory, 'bad-header.tsv');
		await fs.writeFile(target, 'id\trequests\nlane-a\t1\n', 'utf-8');
		const { status, output } = run(target);
		expect(status).toBe(1);
		expect(output).toContain('LEDGER-REFUSED: unpaired');
	}, 60_000);
});
