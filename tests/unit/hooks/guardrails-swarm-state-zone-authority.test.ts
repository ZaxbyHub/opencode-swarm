/**
 * .swarm/ runtime-state zone authority (the 2026-11-23
 * swarm_communication_debug AUTHORITY_POLICY_DENY wedge).
 *
 * The loop skill instructs the architect to write
 * `.swarm/loop/<run>/state.json` after every gate transition. The zone
 * classifier used to send every `.json` path to the `config` zone, and the
 * architect's default `blockedZones: ['generated', 'config']` denied the
 * write — with no config escape, because zone blocks cannot be overridden by
 * allow rules. These tests pin the reclassification contract end-to-end:
 * swarm runtime state is its own `state` zone, the architect may write it,
 * and every pre-existing .swarm/ protection (plan projections, the coder's
 * .swarm/ prefix block) still holds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkFileAuthority } from '../../../src/hooks/guardrails';

function isDenied(
	result: ReturnType<typeof checkFileAuthority>,
): result is { allowed: false; reason: string } {
	return !result.allowed;
}

describe('guardrails swarm state-zone authority', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-state-zone-'));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('allows the architect to write .swarm/loop run state (previously config-zone denied)', () => {
		const result = checkFileAuthority(
			'architect',
			'.swarm/loop/mainstream-model-20261121T1646Z/state.json',
			tempDir,
		);
		expect(result.allowed).toBe(true);
	});

	it('allows the architect to write .swarm/loop run state via absolute path', () => {
		const absolutePath = path.join(
			tempDir,
			'.swarm',
			'loop',
			'mainstream-model-20261121T1646Z',
			'state.json',
		);
		const result = checkFileAuthority('architect', absolutePath, tempDir);
		expect(result.allowed).toBe(true);
	});

	it('still denies the architect the plan projections (exact-path block, not zone)', () => {
		for (const planPath of ['.swarm/plan.md', '.swarm/plan.json']) {
			const result = checkFileAuthority('architect', planPath, tempDir);
			expect(result.allowed).toBe(false);
		}
	});

	it('still denies the coder every .swarm/ path (prefix block)', () => {
		const result = checkFileAuthority(
			'coder',
			'.swarm/loop/mainstream-model-20261121T1646Z/state.json',
			tempDir,
		);
		expect(result.allowed).toBe(false);
		if (isDenied(result)) {
			expect(result.reason).toContain('Path blocked');
		}
	});

	it('still denies the architect the gate-integrity .swarm/ surfaces (#2703-review F-004)', () => {
		// The state zone is ONLY .swarm/loop/. Evidence bundles, route
		// receipts, full-auto state, and session state keep their base
		// config-zone classification, so the architect's default
		// blockedZones (the #894 class) keeps blocking them — a blanket
		// .swarm/ → state reclassification had re-opened architect writes to
		// exactly the files gate-evidence integrity depends on.
		for (const integrityPath of [
			'.swarm/evidence/secretscan.json',
			'.swarm/evidence/1.8/evidence.json',
			'.swarm/pr-review/route-receipts/dispatch-1.json',
			'.swarm/full-auto-state.json',
			'.swarm/session/abc.json',
		]) {
			const result = checkFileAuthority('architect', integrityPath, tempDir);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.zone).toBe('config');
			}
		}
	});

	it('still denies the architect real config-zone files (the #894 lint-bypass protection)', () => {
		for (const configPath of [
			'biome.json',
			'tsconfig.json',
			'.oxlintrc.json',
		]) {
			const result = checkFileAuthority('architect', configPath, tempDir);
			expect(result.allowed).toBe(false);
		}
	});

	it('still denies the architect generated-zone files', () => {
		const result = checkFileAuthority('architect', 'lib/math.wasm', tempDir);
		expect(result.allowed).toBe(false);
		if (isDenied(result)) {
			expect(result.zone).toBe('generated');
		}
	});

	it('honors an explicit blockedZones:["state"] override for consumers that must lock runtime state down', () => {
		// The authority config can still deny the state zone explicitly — the
		// reclassification only removes the accidental default block.
		const result = checkFileAuthority(
			'architect',
			'.swarm/loop/run/state.json',
			tempDir,
			{ rules: { architect: { blockedZones: ['state'] } } },
		);
		expect(result.allowed).toBe(false);
		if (isDenied(result)) {
			expect(result.reason).toContain('state');
		}
	});
});
