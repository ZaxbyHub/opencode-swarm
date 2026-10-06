/**
 * Mutation-layer tests for the quarantine-aging tracker (issue #2905,
 * swarm-pr-review pr3067-20261004 findings PRR-001/041/013/019/039).
 *
 * Exercises the gh-touching surface through the `_internals.runGh` DI seam
 * (no network): routeDecision open/update/close flows, lookupAnchorStates
 * bounds and failure handling, real-mode main() routing incl. the
 * non-adopted-title canary and the missing-ledger close guard, and the
 * bot-author matcher that must accept both gh renderings of the Actions
 * actor ('app/github-actions' and 'github-actions[bot]'). All clocks are
 * Date.UTC literals.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as agingInternals,
	main as agingMain,
	decideAgingAction,
	type ExistingIssue,
	escapeAnnotation,
	isBotAuthored,
	lookupAnchorStates,
	renderAgingBody,
	routeDecision,
	TRACKING_TITLE_PREFIX,
} from '../../../../scripts/ci/quarantine-aging';
import {
	buildQuarantineCensus,
	DEFAULT_QUARANTINE_LEDGERS,
	type QuarantineCensus,
} from '../../../../scripts/ci/quarantine-census';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const NOW = new Date(Date.UTC(2026, 9, 3)); // 2026-10-03 UTC

type GhStub = (args: string[]) => {
	ok: boolean;
	stdout: string;
	error?: string;
};

/** Run `fn` with runGh stubbed and console.log captured; restores both. */
async function withCaptured(
	stub: GhStub,
	fn: () => Promise<unknown> | unknown,
): Promise<{ logs: string[]; result: unknown }> {
	const originalRunGh = agingInternals.runGh;
	const originalLog = console.log;
	const logs: string[] = [];
	console.log = (...parts: unknown[]) => {
		logs.push(parts.map(String).join(' '));
	};
	agingInternals.runGh = stub;
	try {
		const result = await fn();
		return { logs, result };
	} finally {
		agingInternals.runGh = originalRunGh;
		console.log = originalLog;
	}
}

function ghOk(stdout = ''): { ok: boolean; stdout: string } {
	return { ok: true, stdout };
}

function censusWithExpiring(expiry: string): QuarantineCensus {
	const contents = DEFAULT_QUARANTINE_LEDGERS.map((ledger, index) => ({
		ledger,
		content:
			index === 0
				? [
						'# fixture',
						'# OWNER: @a — #2973',
						`# EXPIRY: ${expiry} — x`,
						'tests/unit/aging.test.ts',
					].join('\n')
				: '# empty\n',
	}));
	return buildQuarantineCensus(contents, NOW);
}

function fixtureRoot(): string {
	const root = canonicalMkdtemp('q-aging-mut-');
	fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
	return root;
}

function writeExpiringLedger(root: string, expiry: string): void {
	fs.writeFileSync(
		path.join(root, 'scripts', 'ci', 'quarantined-tests.txt'),
		[
			'# fixture',
			'# OWNER: @a — #2973',
			`# EXPIRY: ${expiry} — x`,
			'tests/unit/aging.test.ts',
		].join('\n'),
	);
}

const BOT_TITLE_1 = `${TRACKING_TITLE_PREFIX} 1 entries expire within 21 days`;

describe('bot-author matching (PRR-041)', () => {
	test('accepts both gh renderings of the Actions actor and is_bot', () => {
		expect(
			isBotAuthored({
				number: 1,
				title: BOT_TITLE_1,
				author: { login: 'app/github-actions' },
			}),
		).toBe(true);
		expect(
			isBotAuthored({
				number: 1,
				title: BOT_TITLE_1,
				author: { login: 'github-actions[bot]' },
			}),
		).toBe(true);
		expect(
			isBotAuthored({
				number: 1,
				title: BOT_TITLE_1,
				author: { login: 'some-other-app[bot]', is_bot: true },
			}),
		).toBe(true);
	});

	test('rejects human authors and missing authors', () => {
		expect(
			isBotAuthored({
				number: 1,
				title: BOT_TITLE_1,
				author: { login: 'zaxbysauce' },
			}),
		).toBe(false);
		expect(isBotAuthored({ number: 1, title: BOT_TITLE_1 })).toBe(false);
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), [
			{ number: 7, title: BOT_TITLE_1, author: { login: 'zaxbysauce' } },
		]);
		expect(decision.action).toBe('open');
	});

	test('decideAgingAction adopts the production author shape', () => {
		const issue: ExistingIssue = {
			number: 9,
			title: BOT_TITLE_1,
			author: { login: 'app/github-actions', is_bot: true },
		};
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), [
			issue,
		]);
		expect(decision.action).toBe('update');
		expect(decision.adopted[0]?.number).toBe(9);
	});
});

describe('routeDecision through the DI seam', () => {
	test('open posts gh issue create with the pinned repo and logs success', async () => {
		const calls: string[][] = [];
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), []);
		const { logs } = await withCaptured(
			(args) => {
				calls.push(args);
				return ghOk();
			},
			() => routeDecision(decision, 'BODY', 'ZaxbyHub/opencode-swarm'),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe('issue');
		expect(calls[0][1]).toBe('create');
		expect(calls[0]).toContain('--repo');
		expect(calls[0]).toContain('BODY');
		expect(logs.join('\n')).toContain('opened tracking issue');
	});

	test('create failure emits an annotation-escaped warning', async () => {
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), []);
		const { logs } = await withCaptured(
			() => ({ ok: false, stdout: '', error: 'boom\n::add-mask::x' }),
			() => routeDecision(decision, 'BODY', 'ZaxbyHub/opencode-swarm'),
		);
		const warning = logs.find((line) => line.startsWith('::warning::'));
		expect(warning).toContain('gh issue create failed');
		expect(warning).toContain('%0A');
		expect(warning?.split('\n')).toHaveLength(1);
	});

	test('update comments, retitles, and closes duplicates with --repo', async () => {
		const calls: string[][] = [];
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), [
			{
				number: 21,
				title: `${TRACKING_TITLE_PREFIX} 3 entries expire within 21 days`,
				author: { login: 'app/github-actions' },
			},
			{
				number: 22,
				title: `${TRACKING_TITLE_PREFIX} 3 entries expire within 21 days`,
				author: { login: 'app/github-actions' },
			},
		]);
		const { logs } = await withCaptured(
			(args) => {
				calls.push(args);
				return ghOk();
			},
			() => routeDecision(decision, 'BODY', 'ZaxbyHub/opencode-swarm'),
		);
		const verbs = calls.map((args) => args[1]);
		expect(verbs).toEqual(['comment', 'edit', 'close']);
		expect(calls[0]).toContain('21');
		expect(calls[1]).toContain('--title');
		expect(calls[2]).toContain('22');
		expect(calls.every((args) => args.includes('--repo'))).toBe(true);
		expect(logs.join('\n')).not.toContain('::warning::');
	});

	test('close at n=0 closes every adopted issue', async () => {
		const calls: string[][] = [];
		const decision = decideAgingAction(censusWithExpiring('2026-12-01'), [
			{
				number: 31,
				title: `${TRACKING_TITLE_PREFIX} 0 entries expire within 21 days`,
				author: { login: 'app/github-actions' },
			},
			{
				number: 32,
				title: `${TRACKING_TITLE_PREFIX} 0 entries expire within 21 days`,
				author: { login: 'app/github-actions' },
			},
		]);
		const { logs } = await withCaptured(
			(args) => {
				calls.push(args);
				return ghOk();
			},
			() => routeDecision(decision, 'BODY', 'ZaxbyHub/opencode-swarm'),
		);
		expect(calls.map((args) => args[1])).toEqual(['close', 'close']);
		expect(
			logs.filter((line) => line.includes('closed tracking issue')),
		).toHaveLength(2);
	});
});

describe('renderAgingBody (PRR-014)', () => {
	test('empty expiring set renders "None this week."', () => {
		const body = renderAgingBody(
			censusWithExpiring('2026-12-01'),
			{ available: true, added: 0, retired: 0 },
			new Map(),
		);
		expect(body).toContain('None this week.');
		expect(body).toContain('total active: 1');
	});

	test('table cells escape pipes and unknown anchors render as state unknown', () => {
		const census = censusWithExpiring('2026-10-10');
		const body = renderAgingBody(
			census,
			{ available: false, reason: 'x' },
			new Map(),
		);
		expect(body).toContain('tests/unit/aging.test.ts |');
		expect(body).toContain('#2973 (state unknown)');
		const hostile: QuarantineCensus = {
			...census,
			expiringSoon: census.expiringSoon.map((entry) => ({
				...entry,
				path: 'tests/a|b.test.ts',
			})),
		};
		const escaped = renderAgingBody(
			hostile,
			{ available: true, added: 0, retired: 0 },
			new Map(),
		);
		expect(escaped).toContain('tests/a\\|b.test.ts');
	});
});

describe('lookupAnchorStates bounds and failures (PRR-035)', () => {
	test('caps lookups at 20 refs', async () => {
		const calls: string[][] = [];
		const refs = Array.from({ length: 25 }, (_, i) => `#${100 + i}`);
		await withCaptured(
			(args) => {
				calls.push(args);
				return ghOk('{"state":"OPEN"}');
			},
			() => lookupAnchorStates(refs),
		);
		expect(calls).toHaveLength(20);
	});

	test('failed and unparseable lookups warn and are skipped', async () => {
		// Both the state map and the warnings come from the SAME stubbed run:
		// a second lookup outside the stub would spawn real gh, which has no
		// auth on CI (reviewer round on the feedback fixes).
		const { logs, result } = await withCaptured(
			(args) => {
				if (args.includes('101'))
					return { ok: false, stdout: '', error: 'nope' };
				if (args.includes('102')) return ghOk('not json');
				return ghOk('{"state":"CLOSED"}');
			},
			() => lookupAnchorStates(['#101', '#102', '#103']),
		);
		const states = result as Map<string, string>;
		expect(states.get('#103')).toBe('CLOSED');
		expect(states.has('#101')).toBe(false);
		expect(states.has('#102')).toBe(false);
		expect(logs.join('\n')).toContain('anchor state lookup failed for #101');
		expect(logs.join('\n')).toContain('unparseable');
	});
});

describe('real-mode main() routing (PRR-001/013, canary, close guard)', () => {
	test('open flow: empty list, n>0 census, create fires', async () => {
		const root = fixtureRoot();
		try {
			writeExpiringLedger(root, '2026-10-10');
			const calls: string[][] = [];
			const { logs, result } = await withCaptured(
				(args) => {
					calls.push(args);
					if (args[1] === 'view') return ghOk('{"state":"OPEN"}');
					if (args[1] === 'list') return ghOk('[]');
					return ghOk();
				},
				() => agingMain(['--root', root, '--now', '2026-10-04']),
			);
			expect(result).toBe(0);
			expect(calls.some((args) => args[1] === 'create')).toBe(true);
			expect(logs.join('\n')).toContain('decision: open');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('list failure and non-array payload both route nothing (exit 0)', async () => {
		const root = fixtureRoot();
		try {
			const failRun = await withCaptured(
				() => ({ ok: false, stdout: '', error: 'auth failed' }),
				() => agingMain(['--root', root, '--now', '2026-10-04']),
			);
			expect(failRun.result).toBe(0);
			expect(failRun.logs.join('\n')).toContain('gh issue list failed');

			const nonArray = await withCaptured(
				(args) => (args[1] === 'list' ? ghOk('{"oops":true}') : ghOk()),
				() => agingMain(['--root', root, '--now', '2026-10-04']),
			);
			expect(nonArray.result).toBe(0);
			expect(nonArray.logs.join('\n')).toContain('non-array output');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('non-adopted same-title issue triggers the duplicate canary', async () => {
		const root = fixtureRoot();
		try {
			writeExpiringLedger(root, '2026-10-10');
			const human = {
				number: 55,
				title: BOT_TITLE_1,
				author: { login: 'zaxbysauce' },
			};
			const { logs } = await withCaptured(
				(args) => {
					if (args[1] === 'view') return ghOk('{"state":"OPEN"}');
					if (args[1] === 'list') return ghOk(JSON.stringify([human]));
					return ghOk();
				},
				() => agingMain(['--root', root, '--now', '2026-10-04']),
			);
			expect(logs.join('\n')).toContain('not adopted');
			expect(logs.join('\n')).toContain('#55');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('missing ledgers refuse the n=0 close (no gh close call)', async () => {
		const root = fixtureRoot();
		// No ledger files written: every ledger is missing at root.
		try {
			const adopted = {
				number: 41,
				title: `${TRACKING_TITLE_PREFIX} 0 entries expire within 21 days`,
				author: { login: 'app/github-actions' },
			};
			const calls: string[][] = [];
			const { logs, result } = await withCaptured(
				(args) => {
					calls.push(args);
					if (args[1] === 'list') return ghOk(JSON.stringify([adopted]));
					return ghOk();
				},
				() => agingMain(['--root', root, '--now', '2026-10-04']),
			);
			expect(result).toBe(0);
			expect(calls.some((args) => args[1] === 'close')).toBe(false);
			expect(logs.join('\n')).toContain('refusing to close');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('an unreadable ledger (dir in its place) also refuses the n=0 close', async () => {
		const root = fixtureRoot();
		try {
			// Discriminating fixture (reviewer round 2): the three sibling
			// ledgers exist as readable files, so the ONLY defective input is
			// the directory sitting where the general ledger belongs —
			// existsSync passes, readFileSync throws. Under the round-1
			// existsSync-only guard this fixture would close (bug reproduced);
			// the read-aware guard must refuse.
			for (const ledger of DEFAULT_QUARANTINE_LEDGERS) {
				if (ledger === DEFAULT_QUARANTINE_LEDGERS[0]) continue;
				const full = path.join(root, ...ledger.split('/'));
				fs.mkdirSync(path.dirname(full), { recursive: true });
				fs.writeFileSync(full, '# empty\n');
			}
			fs.mkdirSync(path.join(root, 'scripts', 'ci', 'quarantined-tests.txt'));
			const adopted = {
				number: 42,
				title: `${TRACKING_TITLE_PREFIX} 0 entries expire within 21 days`,
				author: { login: 'app/github-actions' },
			};
			const calls: string[][] = [];
			const { logs, result } = await withCaptured(
				(args) => {
					calls.push(args);
					if (args[1] === 'list') return ghOk(JSON.stringify([adopted]));
					return ghOk();
				},
				() => agingMain(['--root', root, '--now', '2026-10-04']),
			);
			expect(result).toBe(0);
			expect(calls.some((args) => args[1] === 'close')).toBe(false);
			expect(logs.join('\n')).toContain('refusing to close');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('invalid --now is a usage error (exit 2), no gh calls', async () => {
		const originalErr = console.error;
		const errs: string[] = [];
		console.error = (...parts: unknown[]) => {
			errs.push(parts.map(String).join(' '));
		};
		try {
			const { result } = await withCaptured(
				() => ghOk(),
				() => agingMain(['--root', process.cwd(), '--now', 'garbage']),
			);
			expect(result).toBe(2);
			expect(errs.join('\n')).toContain('invalid --now');
		} finally {
			console.error = originalErr;
		}
	});
});

describe('annotation escaping helper (PRR-039)', () => {
	test('escapes %, CR and LF', () => {
		expect(escapeAnnotation('100%\nline\rbreak')).toBe('100%25%0Aline%0Dbreak');
	});
});
