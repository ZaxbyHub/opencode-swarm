import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computePhaseEvidenceSnapshot } from '../../../src/tools/phase-complete/snapshot-identity';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('phase evidence snapshot identity', () => {
	test('changes for evidence bytes but ignores lock artifacts', () => {
		const fixture = createSafeTestDir('phase-snapshot-');
		cleanups.push(fixture.cleanup);
		const evidence = path.join(fixture.dir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidence, { recursive: true });
		fs.writeFileSync(path.join(evidence, 'gate.json'), '{"pass":true}');
		const first = computePhaseEvidenceSnapshot(fixture.dir);

		fs.mkdirSync(path.join(fixture.dir, '.swarm', 'locks'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(fixture.dir, '.swarm', 'locks', 'plan.lock'),
			'',
		);
		expect(computePhaseEvidenceSnapshot(fixture.dir)).toBe(first);

		fs.writeFileSync(path.join(evidence, 'gate.json'), '{"pass":false}');
		expect(computePhaseEvidenceSnapshot(fixture.dir)).not.toBe(first);
	});

	test('fails closed on redirected evidence inputs', () => {
		const fixture = createSafeTestDir('phase-snapshot-link-');
		cleanups.push(fixture.cleanup);
		const outside = path.join(fixture.dir, 'outside');
		fs.mkdirSync(path.join(fixture.dir, '.swarm'), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		try {
			fs.symlinkSync(
				outside,
				path.join(fixture.dir, '.swarm', 'evidence'),
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES') return;
			throw error;
		}
		expect(() => computePhaseEvidenceSnapshot(fixture.dir)).toThrow(
			'PHASE_SNAPSHOT_UNSAFE_PATH',
		);
	});
});
