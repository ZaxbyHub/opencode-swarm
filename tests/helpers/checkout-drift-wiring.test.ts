/**
 * Checkout-drift bookend wiring: the real preload
 * (tests/preload/prod-store-tripwire.ts) fails a `bun test` run that writes
 * into the guarded checkout, and only warns for `.swarm/` writes by default.
 *
 * Each case spawns `bun test` on a one-test fixture with that preload and
 * `SWARM_TEST_CHECKOUT_DRIFT_ROOT` pointing at a scratch "checkout", so the
 * real repository is never written.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from './tmpdir';

const PRELOAD = path.resolve(
	import.meta.dir,
	'..',
	'preload',
	'prod-store-tripwire.ts',
);

const FIXTURE = `import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('writes into the guarded checkout', () => {
	const target = path.join(
		process.env.SWARM_TEST_CHECKOUT_DRIFT_ROOT ?? '',
		process.env.DRIFT_FIXTURE_TARGET ?? '',
	);
	fs.writeFileSync(target, 'leak');
	expect(fs.existsSync(target)).toBe(true);
});
`;

let scratch: string;
let checkout: string;
let fixtureDir: string;

beforeEach(() => {
	scratch = canonicalMkdtemp('checkout-drift-wiring-');
	checkout = path.join(scratch, 'checkout');
	fixtureDir = path.join(scratch, 'fixture');
	fs.mkdirSync(path.join(checkout, '.swarm'), { recursive: true });
	fs.mkdirSync(fixtureDir);
	fs.writeFileSync(path.join(fixtureDir, 'drift-fixture.test.ts'), FIXTURE);
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

function runFixture(
	target: string,
	mode?: string,
): { exitCode: number; output: string } {
	const env: Record<string, string | undefined> = {
		...process.env,
		SWARM_TEST_CHECKOUT_DRIFT_ROOT: checkout,
		DRIFT_FIXTURE_TARGET: target,
	};
	if (mode === undefined) delete env.SWARM_TEST_CHECKOUT_DRIFT;
	else env.SWARM_TEST_CHECKOUT_DRIFT = mode;
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			'test',
			'--preload',
			PRELOAD,
			'./drift-fixture.test.ts',
		],
		cwd: fixtureDir,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		exitCode: result.exitCode ?? -1,
		output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
	};
}

describe('checkout-drift preload wiring', () => {
	test('a top-level write fails the run', () => {
		const { exitCode, output } = runFixture('leak.txt');
		expect(output).toContain('CHECKOUT DRIFT');
		expect(output).toContain('leak.txt: created');
		expect(exitCode).not.toBe(0);
	}, 60_000);

	test('a .swarm/ write only warns by default', () => {
		const { exitCode, output } = runFixture(path.join('.swarm', 'state.json'));
		expect(output).toContain('.swarm/state.json: created');
		expect(exitCode).toBe(0);
	}, 60_000);

	test('a .swarm/ write fails the run with SWARM_TEST_CHECKOUT_DRIFT=enforce', () => {
		const { exitCode, output } = runFixture(
			path.join('.swarm', 'state.json'),
			'enforce',
		);
		expect(output).toContain('.swarm/state.json: created');
		expect(exitCode).not.toBe(0);
	}, 60_000);
});
