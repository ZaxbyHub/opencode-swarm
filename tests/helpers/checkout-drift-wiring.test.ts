/**
 * Checkout-drift bookend wiring: the real preload
 * (tests/preload/prod-store-tripwire.ts) fails a `bun test` run that writes
 * into the guarded checkout, `.swarm/` writes included, unless
 * `SWARM_TEST_CHECKOUT_DRIFT=warn` downgrades it to a warning.
 *
 * A write still in flight when the last test returns (an un-awaited
 * fs.promises chain) is caught too.
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
	if (process.env.DRIFT_FIXTURE_LATE) {
		// Un-awaited, like a fire-and-forget atomic persist (read, mkdir, temp
		// write, rename): it lands after the test returns.
		void (async () => {
			await fs.promises.readFile(target).catch(() => null);
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await fs.promises.writeFile(\`\${target}.tmp\`, 'leak');
			await fs.promises.rename(\`\${target}.tmp\`, target);
		})();
		return;
	}
	fs.writeFileSync(target, 'leak');
	expect(fs.existsSync(target)).toBe(true);
});
`;

// The late-write case races a wall-clock window (the preload's 25 ms settle):
// skipped under coverage shards, whose self-hosted pool is contended
// (docs/ci/merge-queue-policy.md), and enforced in the hosted unit matrix.
const skipCoverageShard = Boolean(process.env.COVERAGE_SHARD_INDEX);
const describeWallClock = describe.skipIf(skipCoverageShard);

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
	late = false,
): { exitCode: number; output: string } {
	const env: Record<string, string | undefined> = {
		...process.env,
		SWARM_TEST_CHECKOUT_DRIFT_ROOT: checkout,
		DRIFT_FIXTURE_TARGET: target,
		DRIFT_FIXTURE_LATE: late ? '1' : undefined,
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

	test('a .swarm/ write fails the run by default', () => {
		const { exitCode, output } = runFixture(path.join('.swarm', 'state.json'));
		expect(output).toContain('.swarm/state.json: created');
		expect(output).toContain('error: CHECKOUT DRIFT');
		expect(exitCode).not.toBe(0);
	}, 60_000);

	test('a .swarm/ write only warns with SWARM_TEST_CHECKOUT_DRIFT=warn', () => {
		const { exitCode, output } = runFixture(
			path.join('.swarm', 'state.json'),
			'warn',
		);
		expect(output).toContain('.swarm/state.json: created');
		expect(exitCode).toBe(0);
	}, 60_000);
});

describeWallClock('checkout-drift preload wiring (wall-clock window)', () => {
	test('a .swarm/ write still in flight when the last test returns fails the run', () => {
		const { exitCode, output } = runFixture(
			path.join('.swarm', 'late.json'),
			undefined,
			true,
		);
		expect(output).toContain('.swarm/late.json: created');
		expect(output).toContain('error: CHECKOUT DRIFT');
		expect(exitCode).not.toBe(0);
	}, 60_000);
});
