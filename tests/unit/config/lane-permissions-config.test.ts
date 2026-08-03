/**
 * `applyLanePermissions` — the config-hook entry point.
 *
 * The hard requirement from the approved policy is that ORDINARY sessions are
 * completely unaffected, so the negative case asserts deep equality of the
 * whole config object against an untouched clone, not just "no
 * external_directory key".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from '../../../src/config/constants';
import type { LaneContext } from '../../../src/config/lane-context';
import {
	_internals,
	applyLanePermissions,
} from '../../../src/config/lane-permissions';
import { WorktreeIsolationConfigSchema } from '../../../src/config/schema';
import { evaluateExternalDirectory } from '../../helpers/opencode-permission-model';

const lane: LaneContext = {
	lanePath: path.resolve('/tmp/wt/.swarm-worktrees/ses/1.1'),
	parentProjectPath: path.resolve('/tmp/wt/my-project'),
};

let warnings: string[];
let events: Array<{ file: string; record: Record<string, unknown> }>;
let originals: typeof _internals;

beforeEach(() => {
	warnings = [];
	events = [];
	originals = { ..._internals };
	_internals.addDeferredWarning = (w: string) => {
		warnings.push(w);
	};
	_internals.mkdirSync = () => undefined;
	_internals.appendFileSync = (p: string, data: string) => {
		events.push({ file: p, record: JSON.parse(data) });
	};
});

afterEach(() => {
	Object.assign(_internals, originals);
});

function asLane(): void {
	_internals.resolveLaneContext = () => lane;
}
function asOrdinary(): void {
	_internals.resolveLaneContext = () => null;
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
		expect(events).toEqual([]);
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
		expect(events.length).toBe(1);
		const record = events[0].record;
		expect(record.event).toBe('lane_permissions');
		expect(record.decision).toBe('applied');
		expect(record.mode).toBe('scoped_allow');
		expect(record.lanePath).toBe(lane.lanePath);
		expect(record.parentProjectPath).toBe(lane.parentProjectPath);
		expect(Array.isArray(record.allowlist)).toBe(true);
		expect((record.allowlist as unknown[]).length).toBeGreaterThan(0);
		expect(String(record.remedy)).toContain('external_directory');
		expect(events[0].file).toContain('.swarm');
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
		const coerced = events[0].record.coercedAskPatterns as string[];
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
		expect(events[0].record.coercedAskPatterns).toEqual([]);
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

		expect(events.length).toBe(1);
		const file = events[0].file;
		expect(file).toBe(path.join(lane.lanePath, '.swarm', 'events.jsonl'));
		expect(file).not.toContain(path.join('src', '.swarm'));
	});

	test('the same anchoring applies on the "off" (skipped) path', () => {
		asLane();
		applyLanePermissions(makeConfig(), path.join(lane.lanePath, 'src'), 'off');
		expect(events[0].file).toBe(
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
		const recorded = events[0].record.allowlist as Array<{
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
		expect(events.length).toBe(1);
		expect(events[0].record.decision).toBe('skipped');
		expect(String(events[0].record.reason)).toContain('hang');
	});
});

describe('observability failures never break plugin init', () => {
	test('an events.jsonl write failure is swallowed and rules still applied', () => {
		asLane();
		_internals.appendFileSync = () => {
			throw new Error('EROFS: read-only file system');
		};
		const config = makeConfig();
		expect(() =>
			applyLanePermissions(config, lane.lanePath, 'scoped_allow'),
		).not.toThrow();
		expect(
			(config.permission as Record<string, unknown>).external_directory,
		).toBeDefined();
	});

	test('an mkdir failure is swallowed', () => {
		asLane();
		_internals.mkdirSync = () => {
			throw new Error('EACCES');
		};
		expect(() =>
			applyLanePermissions(makeConfig(), lane.lanePath, 'scoped_allow'),
		).not.toThrow();
	});
});
