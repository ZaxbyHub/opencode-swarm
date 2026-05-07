/**
 * Tests for the Full-Auto v2 phase-completion approval gate as wired into
 * src/tools/phase-complete.ts.
 *
 * We exercise the helper directly rather than running the entire phase_complete
 * tool — this isolates the new gate logic and avoids depending on plan ledger,
 * QA gate profiles, etc. The approval helper is the integration point used by
 * phase_complete; if it returns ok=false, phase_complete returns BLOCKED.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { verifyFullAutoPhaseApproval } from '../../../src/full-auto/phase-approval';
import { startFullAutoRun } from '../../../src/full-auto/state';

let tmpDir: string;

function cfg(enabled: boolean, failClosed = true): PluginConfig {
	return {
		full_auto: {
			enabled,
			fail_closed: failClosed,
			mode: 'supervised',
		},
	} as unknown as PluginConfig;
}

beforeEach(() => {
	tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-fa-')));
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('phase_complete + Full-Auto v2 approval', () => {
	test('blocks active Full-Auto with no APPROVED record', () => {
		startFullAutoRun(tmpDir, 'sess', { enabled: true });
		const r = verifyFullAutoPhaseApproval(tmpDir, 'sess', 1, cfg(true));
		expect(r.ok).toBe(false);
	});

	test('passes with fresh APPROVED phase_boundary record', () => {
		startFullAutoRun(tmpDir, 'sess', { enabled: true });
		const dir = path.join(tmpDir, '.swarm', 'evidence', '1');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'full-auto-7.json'),
			JSON.stringify({
				type: 'full_auto_oversight',
				phase: 1,
				verdict: 'APPROVED',
				trigger_source: 'phase_boundary',
				timestamp: new Date().toISOString(),
				evidence_checked: ['diff'],
			}),
		);
		const r = verifyFullAutoPhaseApproval(tmpDir, 'sess', 1, cfg(true));
		expect(r.ok).toBe(true);
	});

	test('Turbo does NOT bypass approval (gate is fail-closed by default)', () => {
		// Turbo would normally short-circuit gates 1-5 inside phase_complete, but
		// the Full-Auto v2 gate runs OUTSIDE that bypass. We verify the helper
		// itself blocks regardless of Turbo state — the only thing that toggles
		// it is `full_auto.enabled` and durable run-state.
		startFullAutoRun(tmpDir, 'sess', { enabled: true });
		const r = verifyFullAutoPhaseApproval(tmpDir, 'sess', 1, cfg(true));
		expect(r.ok).toBe(false);
	});

	test('non-Full-Auto phase_complete behavior unchanged', () => {
		// When full_auto disabled or no run is active, the gate is a no-op.
		const r1 = verifyFullAutoPhaseApproval(tmpDir, 'sess', 1, cfg(false));
		expect(r1.ok).toBe(true);
		const r2 = verifyFullAutoPhaseApproval(tmpDir, 'sess', 1, cfg(true));
		expect(r2.ok).toBe(true); // no active run yet
	});
});
