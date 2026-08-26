/**
 * `applyLanePermissions` — the config-hook entry point.
 *
 * The hard requirement from the approved policy is that ORDINARY sessions are
 * completely unaffected, so the negative case asserts deep equality of the
 * whole config object against an untouched clone, not just "no
 * external_directory key".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from '../../../src/config/constants';
import type { LaneContext } from '../../../src/config/lane-context';
import {
	_internals,
	applyLanePermissions,
} from '../../../src/config/lane-permissions';
import { WorktreeIsolationConfigSchema } from '../../../src/config/schema';
import { evaluateExternalDirectory } from '../../helpers/opencode-permission-model';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let lane: LaneContext;

let warnings: string[];
let originals: typeof _internals;

beforeEach(() => {
	warnings = [];
	// #2039: the event record is written through the core event seam
	// (`appendCoreEventSync`), so the interception asserts on the REAL
	// `<lane>/.swarm/events.jsonl` (manifest line skipped) instead of
	// stubbing lane-permissions `_internals.appendFileSync`/`mkdirSync`,
	// which production no longer calls.
	lane = {
		lanePath: canonicalMkdtemp('lane-perms-2039-'),
		parentProjectPath: canonicalMkdtemp('lane-perms-parent-2039-'),
	};
	originals = { ..._internals };
	_internals.addDeferredWarning = (w: string) => {
		warnings.push(w);
	};
});

afterEach(() => {
	Object.assign(_internals, originals);
	fs.rmSync(lane.parentProjectPath, { recursive: true, force: true });
	fs.rmSync(lane.lanePath, { recursive: true, force: true });
});

function asLane(): void {
	_internals.resolveLaneContext = () => lane;
}
function asOrdinary(): void {
	_internals.resolveLaneContext = () => null;
}

function eventsPath(): string {
	return path.join(lane.lanePath, '.swarm', 'events.jsonl');
}

/**
 * The recorded lane-permissions decision events — parsed from the real
 * `<lane>/.swarm/events.jsonl`, skipping the #2039 manifest header line.
 */
function readEventRecords(): Record<string, unknown>[] {
	if (!fs.existsSync(eventsPath())) return [];
	return fs
		.readFileSync(eventsPath(), 'utf-8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.filter((line) => {
			try {
				return (
					(JSON.parse(line) as { type?: unknown }).type !==
					'swarm-events-manifest'
				);
			} catch {
				return true;
			}
		})
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A config shaped like the one the host hands the hook. */
function makeConfig(): Record<string, unknown> {
	return {
		agent: { coder: { mode: 'subagent', permission: { task: 'allow' } } },
		permission: { task: 'allow' },
		command: { swarm: { template: '/swarm $ARGUMENTS' } },
	};
}

describe('worktree.lane_permissions config knob', () => {
	test('defaults to scoped_allow', () => {
		expect(WorktreeIsolationConfigSchema.parse({}).lane_permissions).toBe(
			'scoped_allow',
		);
	});

	test.each(['scoped_allow', 'deny', 'off'] as const)('accepts %s', (value) => {
		expect(
			WorktreeIsolationConfigSchema.parse({ lane_permissions: value })
				.lane_permissions,
		).toBe(value);
	});

	test('rejects an unknown value', () => {
		expect(
			WorktreeIsolationConfigSchema.safeParse({ lane_permissions: 'yolo' })
				.success,
		).toBe(false);
	});

	test('the shipped default constant matches the schema default', () => {
		// These two drifting is how a "default" silently becomes something else.
		expect(DEFAULT_WORKTREE_ISOLATION_CONFIG.lane_permissions).toBe(
			WorktreeIsolationConfigSchema.parse({}).lane_permissions,
		);
	});
});

describe('ordinary (non-lane) sessions are completely unaffected', () => {
	test.each([
		'scoped_allow',
		'deny',
		'off',
	] as const)('mode=%s mutates nothing', (mode) => {
		asOrdinary();
		const config = makeConfig();
		const before = structuredClone(config);
		const result = applyLanePermissions(config, '/some/project', mode);
		expect(result).toEqual({ lane: false });
		expect(config).toEqual(before);
		expect(warnings).toEqual([]);
		expect(readEventRecords()).toEqual([]);
	});

	test('a config with NO permission key does not gain one', () => {
		asOrdinary();
		const config: Record<string, unknown> = { agent: {} };
		applyLanePermissions(config, '/some/project', 'scoped_allow');
		expect(Object.hasOwn(config, 'permission')).toBe(false);
	});
});

describe('lane instance — scoped_allow', () => {
	test('writes external_directory rules into the top-level permission block', () => {
		asLane();
		const config = makeConfig();
		const result = applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		expect(result.lane).toBe(true);
		expect(result.mode).toBe('scoped_allow');
		const permission = config.permission as Record<string, unknown>;
		const rules = permission.external_directory as Record<string, string>;
		expect(Object.keys(rules)[0]).toBe('*');
		expect(rules['*']).toBe('deny');
		expect(Object.keys(rules).length).toBeGreaterThan(1);
	});

	test('preserves unrelated permission keys (no assign-over-merge clobber)', () => {
		asLane();
		const config = makeConfig();
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		expect((config.permission as Record<string, unknown>).task).toBe('allow');
	});

	test('does NOT touch per-agent permission blocks', () => {
		asLane();
		const config = makeConfig();
		const agentBefore = structuredClone(config.agent);
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		expect(config.agent).toEqual(agentBefore);
	});

	test('creates the permission block when the config has none', () => {
		asLane();
		const config: Record<string, unknown> = { agent: {} };
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		expect(
			(config.permission as Record<string, unknown>).external_directory,
		).toBeDefined();
	});

	test('emits exactly one advisory naming the remedy', () => {
		asLane();
		applyLanePermissions(makeConfig(), lane.lanePath, 'scoped_allow');
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('external_directory');
		expect(warnings[0]).toContain(lane.lanePath);
	});

	test('records one structured decision event with allowlist + remedy', () => {
		asLane();
		applyLanePermissions(makeConfig(), lane.lanePath, 'scoped_allow');
		const records = readEventRecords();
		expect(records.length).toBe(1);
		const record = records[0];
		expect(record.event).toBe('lane_permissions');
		expect(record.decision).toBe('applied');
		expect(record.mode).toBe('scoped_allow');
		expect(record.lanePath).toBe(lane.lanePath);
		expect(record.parentProjectPath).toBe(lane.parentProjectPath);
		expect(Array.isArray(record.allowlist)).toBe(true);
		expect((record.allowlist as unknown[]).length).toBeGreaterThan(0);
		expect(String(record.remedy)).toContain('external_directory');
		expect(eventsPath()).toContain('.swarm');
	});
});

describe('regression (HIGH-2): no configuration shape can leave a lane at "ask"', () => {
	// `ask` is unanswerable in a lane (no TUI), so any surviving `ask` is a
	// guaranteed indefinite hang. Every accepted config shape must resolve.
	const outside = path.resolve('/definitely/not/allowlisted');

	test.each([
		[
			'top-level string shorthand',
			{ permission: { external_directory: 'ask' } },
		],
		['top-level map', { permission: { external_directory: { '*': 'ask' } } }],
		[
			'top-level per-pattern',
			{ permission: { external_directory: { [`${outside}/*`]: 'ask' } } },
		],
	])('%s is downgraded to deny', (_label, extra) => {
		asLane();
		const config = { agent: {}, ...structuredClone(extra) } as Record<
			string,
			unknown
		>;
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		const rules = (config.permission as Record<string, unknown>)
			.external_directory as Record<string, string>;
		for (const action of Object.values(rules)) {
			expect(action).not.toBe('ask');
		}
		expect(
			evaluateExternalDirectory({ external_directory: rules }, outside),
		).toBe('deny');
	});

	test('a PER-AGENT external_directory map ask is downgraded (host merges it LAST)', () => {
		// Without this, fix #1 is trivially bypassable: the host applies
		// `a.merge(e.permission, a.fromConfig(agent.permission))` after the
		// top-level block, so a per-agent `ask` is the rule that actually wins.
		asLane();
		const config: Record<string, unknown> = {
			agent: {
				coder: {
					permission: { external_directory: { [`${outside}/*`]: 'ask' } },
				},
			},
		};
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		const agentRules = (
			(
				(config.agent as Record<string, Record<string, unknown>>).coder
					.permission as Record<string, unknown>
			).external_directory as Record<string, string>
		)[`${outside}/*`];
		expect(agentRules).toBe('deny');
	});

	test('a PER-AGENT string shorthand ask is downgraded', () => {
		asLane();
		const config: Record<string, unknown> = {
			agent: { coder: { permission: { external_directory: 'ask' } } },
		};
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		expect(
			(
				(config.agent as Record<string, Record<string, unknown>>).coder
					.permission as Record<string, unknown>
			).external_directory,
		).toBe('deny');
	});

	test('the downgrade is reported in both the advisory and the event record', () => {
		asLane();
		const config: Record<string, unknown> = {
			permission: { external_directory: 'ask' },
			agent: { coder: { permission: { external_directory: 'ask' } } },
		};
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		expect(warnings[0]).toContain('"deny"');
		const coerced = readEventRecords()[0].coercedAskPatterns as string[];
		expect(coerced).toContain('*');
		expect(coerced).toContain('coder.*');
	});

	test('per-agent allow/deny are left untouched', () => {
		asLane();
		const config: Record<string, unknown> = {
			agent: {
				coder: {
					permission: {
						external_directory: { '/a/*': 'allow', '/b/*': 'deny' },
					},
				},
			},
		};
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');
		expect(
			(
				(config.agent as Record<string, Record<string, unknown>>).coder
					.permission as Record<string, unknown>
			).external_directory,
		).toEqual({ '/a/*': 'allow', '/b/*': 'deny' });
		expect(readEventRecords()[0].coercedAskPatterns).toEqual([]);
	});

	test('a NON-lane session keeps its per-agent ask untouched', () => {
		asOrdinary();
		const config: Record<string, unknown> = {
			agent: { coder: { permission: { external_directory: 'ask' } } },
		};
		const before = structuredClone(config);
		applyLanePermissions(config, '/ordinary/project', 'scoped_allow');
		expect(config).toEqual(before);
	});
});

describe('regression (invariant 4): the event record anchors to the LANE ROOT', () => {
	test('a NESTED instance directory still writes to <lane>/.swarm, not <lane>/src/.swarm', () => {
		// resolveLaneContext deliberately walks ancestors, so ctx.directory can be
		// BELOW the lane root. Using it verbatim would write
		// `<lane>/src/.swarm/events.jsonl` — a `.swarm/` under a source
		// subdirectory, which AGENTS.md invariant 4 forbids.
		asLane();
		const nested = path.join(lane.lanePath, 'src', 'deep');
		applyLanePermissions(makeConfig(), nested, 'scoped_allow');

		expect(readEventRecords().length).toBe(1);
		expect(fs.existsSync(eventsPath())).toBe(true);
		expect(eventsPath()).toBe(
			path.join(lane.lanePath, '.swarm', 'events.jsonl'),
		);
		expect(fs.existsSync(path.join(lane.lanePath, 'src', '.swarm'))).toBe(
			false,
		);
	});

	test('the same anchoring applies on the "off" (skipped) path', () => {
		asLane();
		applyLanePermissions(makeConfig(), path.join(lane.lanePath, 'src'), 'off');
		expect(readEventRecords().length).toBe(1);
		expect(eventsPath()).toBe(
			path.join(lane.lanePath, '.swarm', 'events.jsonl'),
		);
	});
});

describe('the event record must report the rules actually emitted', () => {
	test('every allowlist pattern in the event equals a real key in the rule map', () => {
		// The rule map and the event record used to derive each pattern
		// independently (two `laneDirectoryPattern` calls per entry, each doing
		// its own `realpathSync.native`). If those ever diverged, the event log —
		// the whole observability story for this feature — would misreport what
		// was granted. The pattern is now computed once per allowlist entry and
		// both consumers read it, so this asserts they agree.
		asLane();
		const config = makeConfig();
		applyLanePermissions(config, lane.lanePath, 'scoped_allow');

		const rules = (config.permission as Record<string, unknown>)
			.external_directory as Record<string, string>;
		const recorded = readEventRecords()[0].allowlist as Array<{
			pattern: string;
			reason: string;
		}>;

		expect(recorded.length).toBeGreaterThan(0);
		for (const entry of recorded) {
			expect(Object.hasOwn(rules, entry.pattern)).toBe(true);
			expect(rules[entry.pattern]).toBe('allow');
		}
		// And every non-catch-all allow rule is accounted for in the record.
		const allowKeys = Object.keys(rules).filter(
			(k) => k !== '*' && rules[k] === 'allow',
		);
		expect(new Set(recorded.map((e) => e.pattern))).toEqual(new Set(allowKeys));
	});
});

describe('lane instance — deny', () => {
	test('emits only the catch-all deny', () => {
		asLane();
		const config = makeConfig();
		applyLanePermissions(config, lane.lanePath, 'deny');
		expect(
			(config.permission as Record<string, unknown>).external_directory,
		).toEqual({ '*': 'deny' });
	});
});

describe('lane instance — off', () => {
	test('changes nothing but records why the lane may hang', () => {
		asLane();
		const config = makeConfig();
		const before = structuredClone(config);
		const result = applyLanePermissions(config, lane.lanePath, 'off');
		expect(result).toEqual({ lane: true, mode: 'off' });
		expect(config).toEqual(before);
		expect(warnings).toEqual([]);
		const records = readEventRecords();
		expect(records.length).toBe(1);
		expect(records[0].decision).toBe('skipped');
		expect(String(records[0].reason)).toContain('hang');
	});
});

describe('observability failures never break plugin init', () => {
	test('an events.jsonl write failure is swallowed and rules still applied', () => {
		asLane();
		// #2039: the write goes through the core event seam, so the realistic
		// write failure is store-lock contention — hold `.swarm/events.lock`
		// and let appendCoreEventSync fail with CORE_EVENT_STORE_LOCKED.
		const swarmDir = path.join(lane.lanePath, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const lockPath = path.join(swarmDir, 'events.lock');
		const fd = fs.openSync(lockPath, 'wx');
		fs.closeSync(fd);
		const config = makeConfig();
		try {
			expect(() =>
				applyLanePermissions(config, lane.lanePath, 'scoped_allow'),
			).not.toThrow();
			expect(
				(config.permission as Record<string, unknown>).external_directory,
			).toBeDefined();
		} finally {
			fs.rmSync(lockPath, { force: true });
		}
	});

	test('a .swarm creation failure is swallowed', () => {
		asLane();
		// #2039: make `.swarm` un-creatable by occupying the name with a
		// regular file — the seam's mkdirSync throws and the event write is
		// best-effort by design.
		fs.writeFileSync(path.join(lane.lanePath, '.swarm'), 'not a directory');
		expect(() =>
			applyLanePermissions(makeConfig(), lane.lanePath, 'scoped_allow'),
		).not.toThrow();
	});
});
