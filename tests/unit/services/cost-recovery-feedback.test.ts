import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	foldTelemetryEvents,
	readTelemetryEventsAsync,
} from '../../../src/services/cost-accounting';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const directories: string[] = [];
const fingerprint = 'a'.repeat(32);
const initial = {
	event: 'delegation_end',
	record_id: 'restart-record',
	identity_fingerprint: fingerprint,
	parent_session_digest: 'b'.repeat(32),
	version: 1,
	cost_usd: 0.1,
	cost_source: 'unavailable',
	tokens_input: 1,
	tokens_output: 1,
};

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function writeFixture(): string {
	const directory = canonicalMkdtemp('cost-recovery-feedback-');
	directories.push(directory);
	const swarmDirectory = path.join(directory, '.swarm');
	mkdirSync(swarmDirectory, { recursive: true });
	writeFileSync(
		path.join(swarmDirectory, 'telemetry.jsonl'),
		[
			initial,
			// Version 3 arrives before version 2 in the append-only stream.
			{
				...initial,
				event: 'delegation_cost_correction',
				version: 3,
				cost_usd: 0.3,
			},
			{
				...initial,
				event: 'delegation_cost_correction',
				version: 2,
				cost_usd: 0.2,
			},
			// A malformed modern record must remain visible to legacy aggregation.
			{
				...initial,
				event: 'delegation_end',
				record_id: 'bad-record',
				version: 7,
				cost_usd: 0.4,
			},
		]
			.map((event) => JSON.stringify(event))
			.join('\n'),
	);
	return directory;
}

describe('provider cost recovery feedback regressions', () => {
	test('F-012: folds out-of-order corrections in version order and preserves malformed legacy evidence', async () => {
		const directory = writeFixture();
		const folded = foldTelemetryEvents(
			await readTelemetryEventsAsync(directory),
		);

		expect(folded.versions['restart-record']).toBe(3);
		expect(
			folded.events.find((event) => event.record_id === 'restart-record'),
		).toMatchObject({
			version: 3,
			cost_usd: 0.3,
		});
		expect(
			folded.events.some((event) => event.record_id === 'bad-record'),
		).toBe(true);
	});

	test('FB-015: persisted recovery behavior survives a real Bun process boundary', async () => {
		const directory = writeFixture();
		const modulePath = path
			.resolve('src/services/cost-accounting.ts')
			.replaceAll('\\', '/');
		const script = [
			`import { foldTelemetryEvents, readTelemetryEventsAsync } from ${JSON.stringify(`file://${modulePath}`)};`,
			`const folded = foldTelemetryEvents(await readTelemetryEventsAsync(process.env.COST_RECOVERY_DIRECTORY));`,
			`console.log(JSON.stringify({ version: folded.versions['restart-record'], legacy: folded.events.some((event) => event.record_id === 'bad-record') }));`,
		].join('\n');
		const proc = Bun.spawn([process.execPath, '--eval', script, directory], {
			cwd: path.resolve('.'),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, COST_RECOVERY_DIRECTORY: directory },
		});
		const timeout = setTimeout(() => proc.kill(), 5_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout.trim())).toEqual({ version: 3, legacy: true });
		} finally {
			clearTimeout(timeout);
			proc.kill();
		}
	});
});
