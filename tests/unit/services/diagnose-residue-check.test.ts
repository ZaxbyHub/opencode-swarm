/**
 * Issue #2035 — /swarm diagnose wiring: the bounded Atomic-write residue
 * HealthCheck derives from the same shared inventory as close and config
 * doctor, carries counts only (no paths), and never fails the whole report
 * when the inventory itself errors.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDiagnoseData } from '../../../src/services/diagnose-service';
import { _internals as residueInternals } from '../../../src/services/swarm-residue';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let projectDir: string;
let swarmDir: string;
const realQueryTracked = residueInternals.queryTracked;

beforeEach(() => {
	projectDir = canonicalMkdtemp('diagnose-residue-');
	swarmDir = path.join(projectDir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
});

afterEach(() => {
	residueInternals.queryTracked = realQueryTracked;
	rmSync(projectDir, { recursive: true, force: true });
});

describe('getDiagnoseData — Atomic-write residue check (issue #2035)', () => {
	test('clean .swarm reports a passing check with no path detail', async () => {
		const data = await getDiagnoseData(projectDir);
		const check = data.checks.find((c) => c.name === 'Atomic-write residue');
		expect(check).toBeDefined();
		expect(check?.status).toBe('✅');
	});

	test('stale residue downgrades to ⚠️ with counts only (no absolute paths)', async () => {
		writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
		const residue = path.join(swarmDir, 'context.md.tmp.1710000000.123456789');
		writeFileSync(residue, 'stale', 'utf-8');
		const t = withFrozenClock(
			() => new Date(Date.now() - 3 * 60 * 60 * 1000),
			// anchor the frozen instant to the real clock: relative fixtures must
			// // stay on the same side of the staleness window as before freezing
			{ fixedNow: Date.now() },
		);
		utimesSync(residue, t, t);

		const data = await getDiagnoseData(projectDir);
		const check = data.checks.find((c) => c.name === 'Atomic-write residue');
		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('1 stale temp file(s)');
		expect(check?.detail).toContain('quarantine-eligible');
		// No absolute workspace path leaks into the check line.
		expect(check?.detail).not.toContain(projectDir);
		expect(check?.detail).not.toContain(residue);
	});
});
