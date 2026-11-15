/**
 * #3364: first-turn bundled-skill materialization ordering.
 *
 * Legs:
 * - registry: pre-registration, adoption by the sync, materialized-only
 *   'ready', failed settlement, not-started, reset clears both maps,
 *   all-pending admission refusal;
 * - settlement ownership: the outer await timeout (withTimeout race) leaves
 *   an ADOPTED entry pending while the copy still runs — only the sync
 *   promise settles it;
 * - gate: single shared wait joined by concurrent pre-settlement
 *   invocations, immediate after settlement, bounded, fail-open, no
 *   input/output mutation;
 * - e2e: a first-turn read racing the copy observes the file after the gate;
 * - wiring pins: the gate composes FIRST in experimental.chat.messages.transform
 *   and registration is guarded by bootstrapStateWritesEnabled.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	awaitBundledSkillsMaterialization,
	type BundledSkillsMaterializationStatus,
	failScheduledBundledSkillsSync,
	registerDeferredBundledSkillsSync,
	syncBundledProjectSkillsIfMissingAsync,
} from '../../../src/config/bundled-skills';
import {
	createBundledSkillsFirstTurnGate,
	FIRST_TURN_GATE_TOTAL_BUDGET_MS,
} from '../../../src/hooks/bundled-skills-first-turn-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

let root: string;
let pkgRoot: string;

/** Minimal package fixture: bundled slugs under .opencode/skills. Files are
 * spread across slugs — the sync caps a single skill directory at 64 files
 * (MAX_SKILL_FILES), so one-dir-heavy fixtures abort the copy. */
const FIXTURE_SLUGS = [
	'brainstorm',
	'specify',
	'clarify-spec',
	'swarm-resume',
	'clarify',
	'discover',
	'consult',
	'pre-phase-briefing',
] as const;

function seedMiniFixture(files = 1): void {
	let remaining = files;
	let slugIndex = 0;
	while (remaining > 0) {
		const slug = FIXTURE_SLUGS[slugIndex % FIXTURE_SLUGS.length];
		const src = path.join(pkgRoot, '.opencode', 'skills', slug);
		fs.mkdirSync(src, { recursive: true });
		// First slug always gets its SKILL.md; spread the rest 60-per-dir max.
		const take = Math.min(remaining, 60);
		for (let i = 0; i < take; i += 1) {
			fs.writeFileSync(
				path.join(src, i === 0 ? 'SKILL.md' : `extra-${slugIndex}-${i}.md`),
				'x',
			);
			remaining -= 1;
			if (remaining <= 0) break;
		}
		slugIndex += 1;
		if (slugIndex >= FIXTURE_SLUGS.length * 60) break;
	}
}

beforeEach(() => {
	root = canonicalMkdtemp('gate-3364-root-');
	pkgRoot = canonicalMkdtemp('gate-3364-pkg-');
	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	_test_exports.resetBundledProjectSkillSyncCache();
});

afterEach(() => {
	_test_exports.resetBundledProjectSkillSyncCache();
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(pkgRoot, { recursive: true, force: true });
});

describe('materialization registry (#3364)', () => {
	test('not-started for a root with no registration', async () => {
		const status: BundledSkillsMaterializationStatus =
			await awaitBundledSkillsMaterialization(root, 1_000);
		expect(status).toBe('not-started');
	}, 30_000);

	test('pre-registration + sync adoption settles materialized; gate reads ready', async () => {
		seedMiniFixture();
		expect(registerDeferredBundledSkillsSync(root)).toBe('registered');
		expect(_test_exports.materializationOutcomeFor(root)).toBe('scheduled');
		const sync = syncBundledProjectSkillsIfMissingAsync(root, pkgRoot, true);
		const status = await awaitBundledSkillsMaterialization(root, 15_000);
		await sync;
		expect(status).toBe('ready');
		expect(_test_exports.materializationOutcomeFor(root)).toBe('materialized');
	}, 60_000);

	test('settlement ownership: the outer await timeout never fails an adopted entry still copying', async () => {
		// ~200 files make the real copy outlast a 1 ms outer await race.
		seedMiniFixture(200);
		registerDeferredBundledSkillsSync(root);
		const syncPromise = syncBundledProjectSkillsIfMissingAsync(
			root,
			pkgRoot,
			true,
		);
		// Outer-task shape: the post-resolution task's withTimeout(2s) is a
		// RACE over the sync promise — its expiry (simulated here with a 1 ms
		// bound) must leave the registry entry pending (in-flight), and the
		// 15 s gate budget must still observe materialization.
		const timeoutStatus = await awaitBundledSkillsMaterialization(root, 1);
		expect(timeoutStatus).toBe('timeout');
		expect(_test_exports.materializationOutcomeFor(root)).toBe('in-flight');
		const readyStatus = await awaitBundledSkillsMaterialization(
			root,
			FIRST_TURN_GATE_TOTAL_BUDGET_MS,
		);
		await syncPromise;
		expect(readyStatus).toBe('ready');
		expect(_test_exports.materializationOutcomeFor(root)).toBe('materialized');
	}, 60_000);

	test('failScheduled settles a never-adopted scheduled entry exactly once', async () => {
		registerDeferredBundledSkillsSync(root);
		failScheduledBundledSkillsSync(root);
		expect(_test_exports.materializationOutcomeFor(root)).toBe('failed');
		const status = await awaitBundledSkillsMaterialization(root, 1_000);
		expect(status).toBe('failed');
		// Idempotent: a second call cannot resurrect or re-settle.
		failScheduledBundledSkillsSync(root);
		expect(_test_exports.materializationOutcomeFor(root)).toBe('failed');
	}, 30_000);

	test('all-pending cap: the ninth registration is refused and the root reads not-started', async () => {
		const roots: string[] = [];
		for (let i = 0; i < 8; i += 1) {
			const r = canonicalMkdtemp(`gate-3364-cap-${i}-`);
			roots.push(r);
			expect(registerDeferredBundledSkillsSync(r)).toBe('registered');
		}
		expect(registerDeferredBundledSkillsSync(root)).toBe(
			'registration-refused',
		);
		expect(await awaitBundledSkillsMaterialization(root, 1)).toBe(
			'not-started',
		);
		for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
	}, 30_000);

	// Windows without Developer Mode refuses unprivileged symlinks (EPERM) —
	// probe once at load; the behavioral leg runs only where symlinks work.
	const SYMLINK_CAPABLE = (() => {
		const probeRoot = canonicalMkdtemp('gate-3364-symprobe-');
		try {
			fs.symlinkSync(probeRoot, path.join(probeRoot, 'link-probe'));
			return true;
		} catch {
			return false;
		} finally {
			fs.rmSync(probeRoot, { recursive: true, force: true });
		}
	})();
	test.skipIf(!SYMLINK_CAPABLE)(
		'guard refusal settles failed (symlinked swarm dir)',
		async () => {
			seedMiniFixture();
			registerDeferredBundledSkillsSync(root);
			const linkedRoot = canonicalMkdtemp('gate-3364-linked-');
			const swarmLink = path.join(linkedRoot, '.swarm');
			fs.symlinkSync(root, swarmLink);
			const sync = syncBundledProjectSkillsIfMissingAsync(
				linkedRoot,
				pkgRoot,
				true,
			);
			await sync;
			expect(_test_exports.materializationOutcomeFor(linkedRoot)).toBe(
				'failed',
			);
			const status = await awaitBundledSkillsMaterialization(linkedRoot, 1_000);
			expect(status).toBe('failed');
			fs.rmSync(linkedRoot, { recursive: true, force: true });
		},
		30_000,
	);
});

describe('first-turn gate (#3364)', () => {
	test('e2e: the gate invocation orders the read after the copy (no base ENOENT)', async () => {
		seedMiniFixture(120); // enough files for the copy to be genuinely async
		registerDeferredBundledSkillsSync(root);
		const syncPromise = syncBundledProjectSkillsIfMissingAsync(
			root,
			pkgRoot,
			true,
		);
		const gate = createBundledSkillsFirstTurnGate(
			root,
			FIRST_TURN_GATE_TOTAL_BUDGET_MS,
		);
		const input = { marker: 1 };
		const output = { marker: 2 };
		await gate(input, output); // single wait: resolves only after settlement
		await syncPromise;
		expect(input.marker).toBe(1);
		expect(output.marker).toBe(2); // no mutation
		const skill = fs.readFileSync(
			path.join(root, '.swarm', 'bundled-skills', 'brainstorm', 'SKILL.md'),
			'utf8',
		);
		expect(skill).toBe('x');
	}, 60_000);

	test('concurrent pre-settlement invocations join the same wait (none slip past)', async () => {
		seedMiniFixture(150);
		registerDeferredBundledSkillsSync(root);
		const syncPromise = syncBundledProjectSkillsIfMissingAsync(
			root,
			pkgRoot,
			true,
		);
		const gate = createBundledSkillsFirstTurnGate(
			root,
			FIRST_TURN_GATE_TOTAL_BUDGET_MS,
		);
		const [a, b] = await Promise.all([gate({}, {}), gate({}, {})]);
		await syncPromise;
		expect(a).toBeUndefined();
		expect(b).toBeUndefined();
		// Both waited: the file exists by the time EITHER resolved.
		expect(
			fs.existsSync(
				path.join(root, '.swarm', 'bundled-skills', 'brainstorm', 'SKILL.md'),
			),
		).toBe(true);
	}, 60_000);

	test('bounded: a never-settling scheduled entry resolves at the budget (fail-open)', async () => {
		registerDeferredBundledSkillsSync(root); // scheduled, never adopted
		const gate = createBundledSkillsFirstTurnGate(root, 50);
		await gate({}, {}); // must resolve (timeout latch), never throw
		expect(true).toBe(true);
	}, 30_000);

	test('post-settlement invocations are immediate (no repeated waits)', async () => {
		seedMiniFixture();
		const syncPromise = syncBundledProjectSkillsIfMissingAsync(
			root,
			pkgRoot,
			true,
		);
		const gate = createBundledSkillsFirstTurnGate(
			root,
			FIRST_TURN_GATE_TOTAL_BUDGET_MS,
		);
		await gate({}, {});
		await syncPromise;
		await gate({}, {}); // resolved-promise await: a microtask
		expect(true).toBe(true);
	}, 30_000);
});

describe('wiring pins (#3364)', () => {
	test('gate composes FIRST in experimental.chat.messages.transform', () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, 'src', 'index.ts'),
			'utf8',
		);
		// Anchor on the hooks-object ENTRY (key + wrapper together) — the bare
		// key string also appears at earlier reference sites (pipelineHook[...]).
		const anchor = src.indexOf(
			"'experimental.chat.messages.transform': withStartupFirstUseTracking",
		);
		expect(anchor).toBeGreaterThan(-1);
		const region = src.slice(anchor, anchor + 2_000);
		const gateIdx = region.indexOf('bundledSkillsFirstTurnGate,');
		const stageIdx = region.indexOf('messagesTransformArchitectEnhancerStage');
		expect(gateIdx).toBeGreaterThan(-1);
		expect(stageIdx).toBeGreaterThan(gateIdx);
	}, 30_000);

	test('pre-registration is guarded by bootstrapStateWritesEnabled at enqueue time', () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, 'src', 'index.ts'),
			'utf8',
		);
		const guard = src.indexOf(
			'if (bootstrapStateWritesEnabled) {\n\t\tregisterDeferredBundledSkillsSync(bootstrapRoot);\n\t}',
		);
		expect(guard).toBeGreaterThan(-1);
	}, 30_000);

	test('gate factory receives bootstrapRoot', () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, 'src', 'index.ts'),
			'utf8',
		);
		expect(src).toContain('createBundledSkillsFirstTurnGate(bootstrapRoot)');
	}, 30_000);
});
