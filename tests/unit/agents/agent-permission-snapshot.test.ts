/**
 * Coverage follow-ups from the PR #2549 review (run 2549-r1, PRR-009):
 *
 * 1. The `.swarm/evidence/agent-tools-*.json` snapshot derivation changed in
 *    #2528 (allow-list based, no longer read off the deleted tools map) — pin
 *    its CONTENT against the independent allow-list derivation.
 * 2. multi-swarm combined with tool_filter.enabled=false was untested.
 * 3. The prefixed skill_improver FR-004 exception (local_skill_improver
 *    keeps its skill tools when skills.enabled is false) was untested — the
 *    strip compares baseAgentName, so the exception must survive prefixing.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { getAgentConfigs } from '../../../src/agents/index';
import { SKILL_TOOL_NAMES } from '../../../src/config/constants';
import {
	PluginConfigSchema,
	stripKnownSwarmPrefix,
} from '../../../src/config/schema';
import { AGENT_TOOL_MAP, TOOL_NAMES } from '../../../src/tools/tool-metadata';
import {
	createSafeTestDir,
	safeRmRecursive,
} from '../../helpers/safe-test-dir';

function deniedSet(
	permission: Record<string, unknown> | undefined,
): Set<string> {
	return new Set(
		Object.entries(permission ?? {})
			.filter(([, v]) => v === 'deny')
			.map(([name]) => name)
			.filter((name) => (TOOL_NAMES as readonly string[]).includes(name)),
	);
}

describe('agent tools evidence snapshot (PRR-009a content pin)', () => {
	test('snapshot agents map equals the allow-list derivation (default config)', async () => {
		const { dir } = createSafeTestDir('agent-snapshot-');
		try {
			const sid = 'snap-test-1';
			getAgentConfigs(PluginConfigSchema.parse({}), dir, sid);

			// The write is fire-and-forget (void mkdir().then(writeFile)); poll
			// bounded instead of sleeping a fixed delay.
			const snapshotPath = path.join(
				dir,
				'.swarm',
				'evidence',
				`agent-tools-${sid}.json`,
			);
			// 5 s budget: the write is fire-and-forget and cold-FS Windows CI
			// can take hundreds of ms for the mkdir+write chain (AGENTS.md
			// invariant 1: bounded is not free).
			let raw: string | undefined;
			for (let attempt = 0; attempt < 200 && !raw; attempt++) {
				try {
					raw = readFileSync(snapshotPath, 'utf-8');
				} catch {
					await Bun.sleep(25);
				}
			}
			expect(
				raw,
				'snapshot file not written within the 5s poll budget',
			).toBeDefined();

			const parsed = JSON.parse(raw as string) as {
				agents: Record<string, string[]>;
			};
			const configs = getAgentConfigs(PluginConfigSchema.parse({}));
			for (const [name, cfg] of Object.entries(configs)) {
				const expectedAllow = TOOL_NAMES.filter(
					(t) => !deniedSet(cfg.permission).has(t),
				);
				expect(parsed.agents[name]).toEqual(expectedAllow);
			}
		} finally {
			safeRmRecursive(dir);
		}
	});

	test('snapshot under tool_filter.enabled=false reflects factory true-keys', async () => {
		const { dir } = createSafeTestDir('agent-snapshot-off-');
		try {
			const sid = 'snap-test-2';
			getAgentConfigs(
				PluginConfigSchema.parse({ tool_filter: { enabled: false } }),
				dir,
				sid,
			);
			const snapshotPath = path.join(
				dir,
				'.swarm',
				'evidence',
				`agent-tools-${sid}.json`,
			);
			// 5 s budget: the write is fire-and-forget and cold-FS Windows CI
			// can take hundreds of ms for the mkdir+write chain (AGENTS.md
			// invariant 1: bounded is not free).
			let raw: string | undefined;
			for (let attempt = 0; attempt < 200 && !raw; attempt++) {
				try {
					raw = readFileSync(snapshotPath, 'utf-8');
				} catch {
					await Bun.sleep(25);
				}
			}
			expect(
				raw,
				'snapshot file not written within the 5s poll budget',
			).toBeDefined();
			const parsed = JSON.parse(raw as string) as {
				agents: Record<string, string[]>;
			};
			// In this mode the snapshot lists factory-declared true-keys (the
			// pre-#2528 derivation, sourced from agent.config.tools). The
			// reviewer factory declares only write/edit/patch denies, so its
			// snapshot is correctly empty — asserting the exact shape pins the
			// derivation against accidentally switching to the allow-list form.
			// The reviewer is the relevant pin here: its factory declares only
			// write/edit/patch denies, so the true-key derivation yields an
			// empty list — asserting the exact empty shape pins the derivation
			// against accidentally switching to the allow-list form.
			// (No default-config factory declares true-keys, so every list in
			// this mode is empty; coder et al. would add only vacuous
			// not.toContain assertions on empty arrays.)
			const reviewerList = parsed.agents.reviewer;
			expect(reviewerList).toEqual([]);
		} finally {
			safeRmRecursive(dir);
		}
	});
});

describe('multi-swarm combined with tool_filter.enabled=false (PRR-009b)', () => {
	test('prefixed agents get only the factory floor; primaries keep task', () => {
		const agents = getAgentConfigs(
			PluginConfigSchema.parse({
				tool_filter: { enabled: false },
				swarms: { local: { name: 'Local', agents: {} } },
			}),
		);
		expect(agents.local_reviewer).toBeDefined();
		const reviewerPermission = agents.local_reviewer.permission as Record<
			string,
			unknown
		>;
		// Factory floor enforced through the prefixed path…
		expect(reviewerPermission.edit).toBe('deny');
		expect(reviewerPermission.patch).toBe('deny');
		// …no plugin-tool enumeration in this mode…
		expect(deniedSet(reviewerPermission).size).toBe(0);
		// …and prefixed primaries keep delegation.
		expect(
			(agents.local_architect.permission as Record<string, unknown>).task,
		).toBe('allow');
		expect('tools' in agents.local_reviewer).toBe(false);
	});
});

describe('prefixed skill_improver FR-004 exception (PRR-009c)', () => {
	test('local_skill_improver retains its skill tools when skills.enabled is false', () => {
		const agents = getAgentConfigs(
			PluginConfigSchema.parse({
				swarms: { local: { name: 'Local', agents: {} } },
			}),
		);
		expect(agents.local_skill_improver).toBeDefined();
		expect(stripKnownSwarmPrefix('local_skill_improver')).toBe(
			'skill_improver',
		);
		const permission = agents.local_skill_improver.permission as Record<
			string,
			unknown
		>;
		// The four skill tools in skill_improver's role map stay allowed…
		for (const tool of [
			'skill_generate',
			'skill_list',
			'skill_inspect',
			'skill_improve',
		] as const) {
			expect(permission[tool]).not.toBe('deny');
		}
		// …while the architect-only trio stays denied. Expected visible set =
		// SKILL_TOOL_NAMES ∩ the skill_improver role map (the unprefixed
		// agent does not exist without a default swarm).
		for (const tool of [
			'skill_apply',
			'skill_regenerate',
			'skill_retire',
		] as const) {
			expect(permission[tool]).toBe('deny');
		}
		const roleSkillTools = SKILL_TOOL_NAMES.filter((t) =>
			(AGENT_TOOL_MAP.skill_improver as readonly string[]).includes(t),
		);
		const visibleLocally = SKILL_TOOL_NAMES.filter(
			(t) => permission[t] !== 'deny',
		).sort();
		expect(visibleLocally).toEqual([...roleSkillTools].sort());
		expect(AGENT_TOOL_MAP.skill_improver.length).toBeGreaterThan(0);
	});
});
