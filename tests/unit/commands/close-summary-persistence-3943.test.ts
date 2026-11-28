/**
 * Trace 3943-3951-close-residue-recoverability — #3943 D1 supplementary
 * (PERSISTED-SURFACE leg of the two clean-stage render fixes).
 *
 * Non-frozen companion to the frozen checks
 * `close-clean-stage-3943-ac1-quarantine-render.test.ts` (quarantine-failure
 * catch, clean-stage.ts:489-501) and
 * `close-clean-stage-3943-ac2-postmortem-render.test.ts` (post-mortem
 * cleanup-failure catch, clean-stage.ts:325-341). Those assert the in-memory
 * `ctx.warnings` string; THIS file closes the gap the approved plan named for
 * the durable artifact: `handleCloseCommand` writes every `ctx.warnings` entry
 * VERBATIM as a `- ${w}` line under `## Warnings` of `.swarm/close-summary.md`
 * (src/commands/close/orchestrator.ts:712-714), so the file on disk — not the
 * array in memory — is the operator's durable record. At base both render
 * sites interpolated the raw `${reason}` / `${artifact}` and the persisted
 * summary carried the raw control bytes.
 *
 * Shape (per the plan): the REAL `handleCloseCommand` end to end, modeled on
 * tests/unit/commands/residue-render-neutralization.test.ts:157-248 (same
 * `installCloseCommandMocks()` preamble + plan.json + ledger init), with the
 * two inert injections the frozen checks use:
 *   (a) quarantine failure — the allowlisted `_internals.queryTracked` seam
 *       throws an OS-style error whose message embeds a control-bearing path
 *       (the only inventory-level throw route into the clean-stage catch);
 *   (b) post-mortem cleanup failure — `node:fs` `promises.unlink` overridden
 *       (spread-real, single function) to fail EPERM for one control-named
 *       post-mortem artifact, registered BEFORE the dynamic import so
 *       clean-stage's `import { promises as fs } from 'node:fs'` binds it.
 *
 * Fixture honesty: unlike the AC2 frozen check (which supplies the
 * control-bearing name as a caller-provided ctx field because NTFS forbids C0
 * bytes in real filenames), the post-mortem name here is a REAL file under
 * `.swarm/`, so the real archive stage discovers it via `fs.readdir` and
 * populates `ctx.archivedActiveStateFiles` itself. It therefore uses only
 * bytes Win32 permits in a filename: DEL (U+007F) and C1 (U+0085) — both in
 * the same `\p{Cc}` class `neutralizeResidueName` strips.
 *
 * Partial-mock coverage note: the `node:fs` mock overrides ONLY
 * `promises.unlink`, and only for the single EVIL_POST_MORTEM_NAME (every
 * other call delegates to the real module, including the archive stage's
 * `copyFile` and the summary's own atomic write). The ENOENT silent-skip
 * branch at clean-stage.ts:330 is deliberately not exercised (no failure to
 * render there); the non-ENOENT branch is the AC2 render site.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import { installCloseCommandMocks } from '../../helpers/close-command-mocks';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const cc = (code: number): string => String.fromCodePoint(code);

/** C0 (U+0000-U+001F) + DEL (U+007F) + C1 (U+0080-U+009F) — the exact class
 *  neutralizeResidueName strips (`\p{Cc}`). */
const CONTROL = new RegExp(
	`[${cc(0x00)}-${cc(0x1f)}${cc(0x7f)}-${cc(0x9f)}]`,
	'u',
);

/** Whole-file variant of the same class: the summary's own LF row separators
 *  are structural (orchestrator.ts:715 joins rows with "
"), so the
 *  durable-artifact assertion forbids every C0/DEL/C1 byte EXCEPT U+000A.
 *  CR is NOT exempt — the writer never emits CRLF, so a stray CR would
 *  itself be an injected control byte. */
const CONTROL_EXCEPT_LF = new RegExp(
	`[${cc(0x00)}-${cc(0x09)}${cc(0x0b)}-${cc(0x1f)}${cc(0x7f)}-${cc(0x9f)}]`,
	'u',
);

/** (a) Inert OS-style quarantine failure carrying NUL, BEL, ESC, DEL, NEL. */
const EVIL_QUARANTINE_REASON =
	'EPERM: operation not permitted, rename ' +
	`'res${cc(0x00)}id-abc${cc(0x07)}.tmp' -> ` +
	`'quarantine\res${cc(0x1b)}[2Kid-${cc(0x7f)}abc${cc(0x85)}.tmp'`;

/** (b) Real post-mortem artifact name; DEL + C1 only (Win32-legal bytes). */
const EVIL_POST_MORTEM_NAME = `post-mortem-a${cc(0x7f)}b${cc(0x85)}c.md`;

// Captured BEFORE registration: mock.module mutates the live node:fs
// namespace, so reading realFs.promises.unlink back at call time would
// return this very override (self-recursion / RangeError).
const REAL_UNLINK = realFs.promises.unlink;

// Registered BEFORE the close pipeline loads; the override fires only for the
// single EVIL_POST_MORTEM_NAME above and delegates every other unlink.
mock.module('node:fs', () => ({
	...realFs,
	promises: {
		...realFs.promises,
		unlink: async (target: string | URL): Promise<void> => {
			if (
				typeof target === 'string' &&
				target.endsWith(EVIL_POST_MORTEM_NAME)
			) {
				const err = new Error(
					`EPERM: operation not permitted, unlink '${target}'`,
				) as NodeJS.ErrnoException;
				err.code = 'EPERM';
				throw err;
			}
			return REAL_UNLINK(target as string);
		},
	},
}));

installCloseCommandMocks();

const { handleCloseCommand } = await import('../../../src/commands/close.js');
const { _internals: swarmResidueInternals } = await import(
	'../../../src/services/swarm-residue.js'
);

const realQueryTracked = swarmResidueInternals.queryTracked;

const PLAN = {
	title: 'Close summary persistence project',
	schema_version: '1.0.0',
	swarm: 'lowtier',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'Phase 1',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'in_progress',
					size: 'small',
					description: 'Task A',
					depends: [],
					files_touched: [],
				},
			],
		},
	],
};

describe('persisted .swarm/close-summary.md — regression: raw control bytes reached the durable warning record from the two clean-stage render sites (#3943 D1)', () => {
	let testDir: string;
	let quarantineInjected = false;

	afterEach(() => {
		// Restore the seam on every exit path, including a mid-body throw.
		if (quarantineInjected) {
			swarmResidueInternals.queryTracked = realQueryTracked;
			quarantineInjected = false;
		}
		// Best-effort only: Bun's mock.module restore is unreliable and the
		// real guard is per-file process isolation (writing-tests SKILL). The
		// fs override above stays inert for every name but EVIL_POST_MORTEM_NAME.
		mock.restore();
		if (testDir) {
			try {
				rmSync(testDir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
	});

	/** Runs the real close command with the requested inert injections. */
	async function runClose(options: {
		quarantineFails: boolean;
		withPostMortem: boolean;
	}): Promise<string> {
		// Referenced so the sqlite loader is preloaded before the close
		// pipeline runs (same convention as residue-render-neutralization:162).
		void loadDatabaseCtor;
		testDir = canonicalMkdtemp('close-summary-persistence-');
		const swarmDir = path.join(testDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		writeFileSync(path.join(swarmDir, 'plan.json'), JSON.stringify(PLAN));
		await initLedger(testDir, derivePlanId(PLAN), undefined, PLAN);
		if (options.withPostMortem) {
			writeFileSync(
				path.join(swarmDir, EVIL_POST_MORTEM_NAME),
				'# post mortem\n',
				'utf-8',
			);
		}
		if (options.quarantineFails) {
			// Full-arg forwarding wrapper per the seam rule; the throw happens
			// before any forwarding, so the base arity never constrains it.
			swarmResidueInternals.queryTracked = ((...args: unknown[]) => {
				void args;
				throw new Error(EVIL_QUARANTINE_REASON);
			}) as typeof realQueryTracked;
			quarantineInjected = true;
		}
		return await handleCloseCommand(testDir, []);
	}

	function readSummary(): string {
		const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
		expect(existsSync(summaryPath), 'close-summary.md was not persisted').toBe(
			true,
		);
		return readFileSync(summaryPath, 'utf-8');
	}

	test('the quarantine-failure warning persists control-free with the diagnostic intact', async () => {
		await runClose({ quarantineFails: true, withPostMortem: false });
		const summary = readSummary();

		// Durable AC: the whole persisted artifact carries no C0/DEL/C1 byte.
		expect(
			CONTROL_EXCEPT_LF.test(summary),
			`persisted close-summary.md still carries raw control bytes: ${JSON.stringify(summary.match(CONTROL_EXCEPT_LF) ?? '')}`,
		).toBe(false);
		expect(summary.includes(cc(0x7f))).toBe(false);

		// Anti-removal guard: neutralization must not be "fixed" by dropping
		// the diagnostic — the stable prefix, the errno text, and the failing
		// candidate's printable parts all survive.
		const warnLine = summary
			.split('\n')
			.find((l) => l.includes('Atomic-write residue quarantine failed'));
		expect(
			warnLine,
			'the quarantine-failure warning is missing from the persisted summary',
		).toBeDefined();
		expect(warnLine).toContain('EPERM: operation not permitted');
		expect(warnLine).toContain('resid-abc');
		expect(warnLine).toContain('.tmp');
		// The poisoned name never injected an extra persisted row.
		expect(
			summary
				.split('\n')
				.filter((l) => l.includes('Atomic-write residue quarantine failed')),
		).toHaveLength(1);
	}, 30_000);

	test('the post-mortem cleanup warning persists control-free with the diagnostic intact', async () => {
		await runClose({ quarantineFails: false, withPostMortem: true });
		const summary = readSummary();

		expect(
			CONTROL_EXCEPT_LF.test(summary),
			'persisted close-summary.md still carries raw control bytes',
		).toBe(false);

		const warnLine = summary
			.split('\n')
			.find(
				(l) =>
					l.startsWith('- Failed to clean active-state file ') &&
					l.includes('post-mortem'),
			);
		expect(
			warnLine,
			'the post-mortem cleanup-failure warning is missing from the persisted summary',
		).toBeDefined();
		// Reachability: the name came from a readdir-sourced archived artifact
		// (the real archive stage populated ctx.archivedActiveStateFiles).
		expect(warnLine).toContain('post-mortem-a');
		expect(warnLine).toContain('.md');
		expect(warnLine).toContain('[EPERM]');
		expect(warnLine).toContain('EPERM: operation not permitted, unlink');
		expect(
			summary.split('\n').filter((l) => l.includes('post-mortem-a')),
		).toHaveLength(1);
	}, 30_000);

	test('both injections together keep the persisted summary control-free', async () => {
		await runClose({ quarantineFails: true, withPostMortem: true });
		const summary = readSummary();

		// The durable artifact is the contract: ONE control-free file carrying
		// BOTH neutralized warnings (each on its own line, diagnostics intact).
		expect(CONTROL_EXCEPT_LF.test(summary)).toBe(false);
		// Fixture sanity: the node:fs override must DELEGATE for every other
		// unlink, never recurse into itself (a self-referential fallback would
		// surface here as a RangeError warning line).
		expect(summary).not.toContain('Maximum call stack');
		expect(
			summary
				.split('\n')
				.some((l) => l.includes('Atomic-write residue quarantine failed')),
		).toBe(true);
		expect(
			summary
				.split('\n')
				.some(
					(l) =>
						l.startsWith('- Failed to clean active-state file ') &&
						l.includes('post-mortem-a') &&
						l.includes('[EPERM]'),
				),
		).toBe(true);
	}, 30_000);
});
