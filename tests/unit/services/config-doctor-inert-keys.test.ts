import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_CONSUMERS } from '../../../src/config/consumers';
import { loadPluginConfigWithMeta } from '../../../src/config/loader';
import { PluginConfigSchema } from '../../../src/config/schema';
import {
	collectRawInertKeyFindings,
	runConfigDoctor,
} from '../../../src/services/config-doctor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Issue #2957: pin BOTH arms of the inert-config-key advisory. Since PR #3065
// wired ctx.config into the harness-opt/skill-opt closures (issue #2949),
// harness_opt and skill_opt are consumed plugin-config keys — the production
// map must keep doctor silent on them (the "passes clean post-J6" end-state).
// The DI parameter on collectRawInertKeyFindings proves the opposite (inert)
// arm on any tree without mock.module, per the issue's "DI tests pin both
// arms so merge order cannot break either PR" contract.

// Isolate the raw collectors from this machine's real user config (they read
// the user plugin-config path under XDG_CONFIG_HOME when set — the #2102
// raw-collector contract, same pattern as config-doctor-inert-key-2904).
const PREV_XDG = process.env.XDG_CONFIG_HOME;
// The XDG root lives inside a canonicalMkdtemp tree (FR-011); keeping the
// canonical temp root free of stray files is why the redirect target is a
// dedicated subtree rather than the shared temp dir itself.
const XDG_BASE = canonicalMkdtemp('2957-inert-keys-xdg-');
const XDG_ROOT = path.join(XDG_BASE, '.config');
fs.mkdirSync(XDG_ROOT, { recursive: true });

beforeEach(() => {
	process.env.XDG_CONFIG_HOME = XDG_ROOT;
});

afterAll(() => {
	if (PREV_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = PREV_XDG;
	fs.rmSync(XDG_BASE, { recursive: true, force: true });
});

function tempProject(): string {
	return canonicalMkdtemp('2957-inert-keys-proj-');
}

function writeProjectConfig(dir: string, raw: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(raw),
		'utf8',
	);
}

function defaults() {
	return PluginConfigSchema.parse({});
}

describe('config doctor — inert-config-key arms (issue #2957)', () => {
	it('production map via the real loader: setting harness_opt and skill_opt stays silent (consumed post-wiring)', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, {
				harness_opt: { enabled: true },
				skill_opt: { enabled: true },
			});
			// Exercise the loader path the issue's integration arm prescribed:
			// the same load runConfigDoctor's callers use, over the scratch tree.
			const { config } = loadPluginConfigWithMeta(dir);
			const result = runConfigDoctor(config, dir);
			const hits = result.findings.filter(
				(f) =>
					f.id === 'inert-config-key' &&
					(f.path === 'harness_opt' || f.path === 'skill_opt'),
			);
			expect(hits).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('production map: the parallelization control still warns (mechanism alive, exactly one inert warn)', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, { parallelization: { enabled: true } });
			const result = runConfigDoctor(defaults(), dir);
			const inertWarns = result.findings.filter(
				(f) => f.id === 'inert-config-key' && f.severity === 'warn',
			);
			expect(inertWarns).toHaveLength(1);
			expect(inertWarns[0]?.path).toBe('parallelization');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('DI inert arm: injected inert declarations warn by name with the full reason rendered', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, {
				harness_opt: { enabled: true },
				skill_opt: { enabled: true },
			});
			const harnessReason =
				'no runtime consumer: handlers read opencode.json instead (pre-wiring shape); replacement: none until wiring lands';
			const skillReason =
				'no runtime consumer: plan or run reads opencode.json instead (pre-wiring shape); replacement: none until wiring lands';
			const findings = collectRawInertKeyFindings(dir, {
				harness_opt: { inert: harnessReason },
				skill_opt: { inert: skillReason },
			});
			expect(findings).toHaveLength(2);
			for (const key of ['harness_opt', 'skill_opt'] as const) {
				const finding = findings.find((f) => f.path === key);
				expect(finding).toBeDefined();
				expect(finding?.id).toBe('inert-config-key');
				expect(finding?.title).toBe(`Inert config key: ${key}`);
				expect(finding?.severity).toBe('warn');
				expect(finding?.autoFixable).toBe(false);
				expect(finding?.currentValue).toEqual({ enabled: true });
				const reason = key === 'harness_opt' ? harnessReason : skillReason;
				expect(finding?.description).toContain(key);
				expect(finding?.description).toContain(reason);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('DI seam is replace-not-merge and honors per-key mixed declarations', () => {
		const dir = tempProject();
		try {
			// Config sets three keys; the injected map declares only ONE of them
			// (harness_opt, inert). Under replace semantics exactly that key is
			// flagged: skill_opt is absent from the map (never falls back to its
			// production consumed declaration — kills a merge mutant) and
			// parallelization is NOT masked by any production inert declaration
			// reaching through (kills the production-wins merge mutant that
			// would flag it instead of harness_opt).
			writeProjectConfig(dir, {
				harness_opt: { enabled: true },
				skill_opt: { enabled: true },
				parallelization: { enabled: true },
			});
			const findings = collectRawInertKeyFindings(dir, {
				harness_opt: { inert: 'injected mixed-declaration test reason' },
			});
			expect(findings).toHaveLength(1);
			expect(findings[0]?.path).toBe('harness_opt');
			expect(findings[0]?.description).toContain(
				'injected mixed-declaration test reason',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('inert-set snapshot: exactly one production-inert key, parallelization (gates the docs claim)', () => {
		const inertKeys = Object.entries(CONFIG_CONSUMERS)
			.filter(([, declaration]) => 'inert' in declaration)
			.map(([key]) => key)
			.sort();
		expect(inertKeys).toEqual(['parallelization']);
	});

	it('DI edge semantics: dual-shape declarations flag as inert and an empty reason renders as an empty clause', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, { harness_opt: { enabled: true } });
			const findings = collectRawInertKeyFindings(dir, {
				// Type-escape fixture: the union rejects dual shapes, but an
				// injected object literal can carry both arms; the collector's
				// documented precedence is that the inert arm wins.
				harness_opt: {
					inert: '',
					consumers: ['src/commands/harness-opt.ts:handleHarnessOptRun'],
				} as never,
			});
			expect(findings).toHaveLength(1);
			expect(findings[0]?.description).toContain('declared inert: ');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
