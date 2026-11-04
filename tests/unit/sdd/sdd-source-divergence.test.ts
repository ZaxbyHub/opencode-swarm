/**
 * #3354 AC5 (acceptance check C5): when the validated full loader discards
 * the project config (user_only recovery), the SDD source resolver must not
 * still honor that discarded file's `sdd.source` — the raw read and the full
 * loader may not diverge on which config files are trusted.
 *
 * Fixture (from the trace probe probe-3354-divergence.ts, wrongTypedKey
 * case): project `{"sdd":{"source":"speckit"},"full_auto":{"locked":true,"mode":123}}`
 * (schema-invalid via the wrong-typed recognized key) + a valid user config.
 *
 * Sanity leg (green before and after): the full loader classifies this as
 * `user_only` recovery. Divergence leg: RED at base (the resolver reports
 * `source: 'speckit'` from the discarded project file), GREEN after the fix.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	loadPluginConfigWithMeta,
	readSddSourceSetting,
} from '../../../src/config/loader';
import {
	resetSddSelectionAdvisories,
	resolveSddSourceSelection,
} from '../../../src/sdd/effective-spec';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;
let xdgDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

beforeEach(() => {
	tempDir = canonicalMkdtemp('sdd-divergence-');
	xdgDir = path.join(tempDir, '.xdg-config');
	fs.mkdirSync(path.join(xdgDir, 'opencode'), { recursive: true });
	savedEnv = process.env.SWARM_SDD_SOURCE;
	savedXdg = process.env.XDG_CONFIG_HOME;
	delete process.env.SWARM_SDD_SOURCE;
	process.env.XDG_CONFIG_HOME = xdgDir;
	_internals.resetUnknownTopLevelKeyWarning();
	_internals.resetGatesAdvisoryDedup();
	resetSddSelectionAdvisories();
	clearDeferredWarnings();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.SWARM_SDD_SOURCE;
	else process.env.SWARM_SDD_SOURCE = savedEnv;
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	_internals.resetUnknownTopLevelKeyWarning();
	_internals.resetGatesAdvisoryDedup();
	resetSddSelectionAdvisories();
	clearDeferredWarnings();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('#3354 AC5: the SDD resolver ignores a project config the full loader discarded', () => {
	test('a user_only-discarded project config must not win the sdd.source selection', () => {
		// Valid user config.
		fs.writeFileSync(
			path.join(xdgDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({}),
			'utf-8',
		);
		// Schema-invalid project config carrying sdd.source (wrong-typed
		// recognized key inside full_auto -> Zod type error -> user_only).
		const projDir = path.join(tempDir, 'project');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				sdd: { source: 'speckit' },
				full_auto: { locked: true, mode: 123 },
			}),
			'utf-8',
		);

		// Sanity (green before and after): the full loader really does discard
		// the project config on this fixture — the divergence leg is only
		// meaningful while this holds.
		const meta = loadPluginConfigWithMeta(projDir);
		expect(meta.recovery).toBe('user_only');

		// Post-fix contract: the discarded project file's sdd.source must not
		// win the selection. At base the resolver reports 'speckit' from the
		// very file the validated loader threw away.
		const selection = resolveSddSourceSelection(projDir);
		// PRR-004: pin the exact post-fix value (undefined) so a resolver that
		// returns a WRONG provider — or any other non-undefined drift — fails
		// this leg instead of only missing the base value.
		expect(selection?.source).toBeUndefined();
	});

	test('preserving leg (critic round-1 finding 1): a stripped_keys-RECOVERED project config keeps supplying sdd.source', () => {
		// The full loader ACCEPTS this file (targeted unrecognized-key
		// recovery at step 6) and uses its sdd.source — the resolver must
		// keep honoring it. A bare safeParse acceptance gate would reject it
		// and create the OPPOSITE divergence; green before AND after the fix.
		fs.writeFileSync(
			path.join(xdgDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({}),
			'utf-8',
		);
		const projDir = path.join(tempDir, 'project-stripped');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				sdd: { source: 'speckit' },
				checkpoint: { enabled: true, totallyBogusKey: 1 },
			}),
			'utf-8',
		);

		const meta = loadPluginConfigWithMeta(projDir);
		expect(meta.recovery).toBe('stripped_keys');

		const selection = resolveSddSourceSelection(projDir);
		expect(selection?.source).toBe('speckit');
	});

	test('preserving leg (critic round-2 case 1): legacy-Epic-migrated project config still supplies sdd.source', () => {
		// Standalone this file fails safeParse (turbo.epic legacy shape), but
		// the real loader MIGRATES it (step 0) and accepts it. The resolver
		// must honor it because acceptance is delegated to the same pipeline.
		fs.writeFileSync(
			path.join(xdgDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({}),
			'utf-8',
		);
		const projDir = path.join(tempDir, 'project-legacy-epic');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				sdd: { source: 'speckit' },
				turbo: { strategy: 'standard', epic: 'bad' },
				epic: {},
			}),
			'utf-8',
		);

		const meta = loadPluginConfigWithMeta(projDir);
		expect(meta.recovery).toBe('none');

		const selection = resolveSddSourceSelection(projDir);
		expect(selection?.source).toBe('speckit');
	});

	test('preserving leg (critic round-2 case 2): a step-7b sanitized_values acceptance still supplies sdd.source', () => {
		// BOTH files carry an invalid council.enabled value; individually each
		// fails parsing, but the two-file loader recovers via sanitized_values
		// and keeps the project sdd.source. A per-file gate would reject it.
		fs.writeFileSync(
			path.join(xdgDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({ council: { enabled: 'yes' } }),
			'utf-8',
		);
		const projDir = path.join(tempDir, 'project-7b');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				sdd: { source: 'speckit' },
				council: { enabled: 'yes' },
			}),
			'utf-8',
		);

		const meta = loadPluginConfigWithMeta(projDir);
		expect(meta.recovery).toBe('sanitized_values');

		const selection = resolveSddSourceSelection(projDir);
		expect(selection?.source).toBe('speckit');
	});

	test('preserving leg (critic round-2 case 3): an invalid USER file healed by the merge still supplies its sdd.source', () => {
		// The user file alone fails parsing, but deep-merging under the valid
		// project config heals it (recovery none) and its sdd.source is the
		// effective one (the project sets none). Origin must be user.
		const projDir = path.join(tempDir, 'project-heals-user');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		// The project's VALID council block overrides the user's invalid one
		// in the deep merge — that is what heals the merged parse.
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ council: { enabled: true } }),
			'utf-8',
		);
		fs.writeFileSync(
			path.join(xdgDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({
				sdd: { source: 'speckit' },
				council: { enabled: 'yes' },
			}),
			'utf-8',
		);

		const meta = loadPluginConfigWithMeta(projDir);
		expect(meta.recovery).toBe('none');

		const selection = resolveSddSourceSelection(projDir);
		expect(selection?.source).toBe('speckit');
	});

	test('discriminating leg (critic round-2 case 4): a project config refused by the dangerous-merge guard must NOT supply sdd.source', () => {
		// The file passes STANDALONE schema parsing, but the real loader
		// refuses the project overlay entirely (own __proto__ key). At base
		// the raw read honors its sdd.source (the divergence); post-fix the
		// delegated acceptance ignores the refused file.
		fs.writeFileSync(
			path.join(xdgDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({}),
			'utf-8',
		);
		const projDir = path.join(tempDir, 'project-proto-refused');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		const raw =
			'{"sdd":{"source":"speckit"},"__proto__":{"git":{"binary":"pwned"}}}';
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			raw,
			'utf-8',
		);

		const selection = resolveSddSourceSelection(projDir);
		// PRR-004: pin the exact post-fix value (undefined) so a resolver that
		// returns a WRONG provider — or any other non-undefined drift — fails
		// this leg instead of only missing the base value.
		expect(selection?.source).toBeUndefined();
	});

	test('no-new-warnings leg (critic round-2 MINOR): readSddSourceSetting is diagnostic-free', () => {
		// A fixture whose acceptance path would emit migration/sanitize
		// advisories in a naive replica: the delegated silent-mode call must
		// add NOTHING to the deferred-warning buffer beyond what the raw
		// reads already produce (which is nothing — they are silent too).
		const projDir = path.join(tempDir, 'project-quiet');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				sdd: { source: 'speckit' },
				turbo: { strategy: 'standard', epic: 'bad' },
				epic: {},
			}),
			'utf-8',
		);

		clearDeferredWarnings();
		readSddSourceSetting(projDir);
		const warnings = getDeferredWarnings();
		expect(warnings.filter((w) => w.includes('opencode-swarm'))).toEqual([]);
	});

	test('preserving leg (critic round-3 finding 1): step-5 fail-secure recovery still supplies the accepted user sdd.source', () => {
		// Malformed project JSON (read-level error) + valid user config with
		// sdd.source: the loader's step-5 guardrails_defaults return PRESERVES
		// the successfully parsed merged config, so the resolver must keep the
		// accepted source (a recovery-name mapping to undefined would lose it).
		fs.writeFileSync(
			path.join(xdgDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({ sdd: { source: 'speckit' } }),
			'utf-8',
		);
		const projDir = path.join(tempDir, 'project-badjson');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			'{ not json',
			'utf-8',
		);

		const meta = loadPluginConfigWithMeta(projDir);
		expect(meta.recovery).toBe('guardrails_defaults');
		expect(meta.configHadErrors).toBe(true);

		const selection = resolveSddSourceSelection(projDir);
		expect(selection?.source).toBe('speckit');
	});

	test('origin leg (critic round-3 finding 2): after dangerous-merge refusal the origin must be user, not project', () => {
		// The project overlay is refused (own __proto__ key) and the loader
		// continues with the user config (recovery none). The accepted source
		// is the USER's; raw-key presence on the refused project file must not
		// mislabel the origin.
		fs.writeFileSync(
			path.join(xdgDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({ sdd: { source: 'openspec' } }),
			'utf-8',
		);
		const projDir = path.join(tempDir, 'project-proto-origin');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			'{"sdd":{"source":"speckit"},"__proto__":{"git":{"binary":"pwned"}}}',
			'utf-8',
		);

		const meta = loadPluginConfigWithMeta(projDir);
		expect(meta.recovery).toBe('none');

		const setting = readSddSourceSetting(projDir);
		expect(setting.source).toBe('openspec');
		expect(setting.origin).toBe('user');
	});

	test('dedup-preservation leg (critic round-3 finding 3): a silent SDD read must not arm warning dedup state', () => {
		const projDir = path.join(tempDir, 'project-dedup');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				sdd: { source: 'speckit' },
				turbo: { strategy: 'standard', epic: 'bad' },
				epic: {},
			}),
			'utf-8',
		);

		// Reset every loader dedup flag the silent path could arm, run the
		// silent read, then prove a subsequent NON-silent load still emits
		// the legacy-Epic migration advisory.
		_internals.resetUnknownTopLevelKeyWarning();
		_internals.resetRetiredEpicKeyWarning();
		_internals.resetLegacyEpicConfigWarning();
		_internals.resetGatesAdvisoryDedup();
		clearDeferredWarnings();

		readSddSourceSetting(projDir);
		expect(
			getDeferredWarnings().filter((w) => w.includes('opencode-swarm')),
		).toEqual([]);

		loadPluginConfigWithMeta(projDir);
		const later = getDeferredWarnings();
		expect(
			later.some((w) => w.includes('turbo.epic') || w.includes('Epic')),
		).toBe(true);
	});
});
