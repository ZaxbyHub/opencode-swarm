/**
 * Trace 3943-3951-close-residue-recoverability — #3943 AC2 (clean-stage
 * post-mortem archive-gate render site).
 *
 * Frozen discriminating check (RED at base 18c09e03e, GREEN after the fix).
 *
 * src/commands/close/clean-stage.ts:318-337 admits a readdir/archive-sourced
 * `post-mortem-*.md` name through the gate regex `/^post-mortem-[^/\]+\.md$/`
 * at line 320 — `[^/\]+` admits control bytes — and the cleanup-failure catch
 * at 328-336 interpolates the raw `${artifact}` name AND the raw failure
 * `${reason}` into `ctx.warnings` (template at line 333) without
 * `neutralizeResidueName`. `handleCloseCommand` persists `ctx.warnings`
 * verbatim into `.swarm/close-summary.md` (orchestrator.ts:712-714).
 *
 * Injection route: NTFS cannot materialize control bytes in real filenames, so
 * the control-bearing NAME is a caller-provided ctx field
 * (`archivedActiveStateFiles`, exactly the readdir-sourced surface the site
 * renders) and the non-ENOENT unlink failure is forced through the allowlisted
 * `node:fs` mock — spread-real, ONLY `promises.unlink` overridden, every other
 * delegated function bound to the real module. The mock is registered BEFORE
 * clean-stage loads (dynamic import after the mock) because clean-stage binds
 * `{ promises as fs } from 'node:fs'`.
 *
 * Untested-by-this-mock branches (partial-mock coverage note): all other
 * `fs.promises` operations run for real; the ENOENT silent-skip branch at
 * line 330 is deliberately not exercised here (no failure to render) — the
 * non-ENOENT branch is the AC2 render site.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const cc = (code: number): string => String.fromCodePoint(code);

/** C0 + DEL + C1 — the same class neutralizeResidueName strips (\p{Cc}). */
const CONTROL = new RegExp(
	`[${cc(0x00)}-${cc(0x1f)}${cc(0x7f)}-${cc(0x9f)}]`,
	'u',
);

// Caller-provided readdir-sourced artifact name carrying STX (C0) and DEL.
const EVIL_NAME = `post-mortem-a${cc(0x02)}b${cc(0x7f)}c.md`;

// Capture both values before registration: mock.module rewrites the live
// namespace, so fallthrough through realFs.promises would recurse into itself.
const REAL_PROMISES = realFs.promises;
const REAL_UNLINK = REAL_PROMISES.unlink;

// Register the mock BEFORE clean-stage loads; spread the REAL module captured
// above and override ONLY promises.unlink (everything else delegates real).
mock.module('node:fs', () => ({
	...realFs,
	promises: {
		...REAL_PROMISES,
		unlink: async (target: string): Promise<void> => {
			if (target.endsWith(EVIL_NAME)) {
				const err = new Error(
					`EPERM: operation not permitted, unlink '${target}'`,
				) as NodeJS.ErrnoException;
				err.code = 'EPERM';
				throw err;
			}
			return REAL_UNLINK(target);
		},
	},
}));

const { runCleanStage } = await import(
	'../../../src/commands/close/clean-stage.js'
);
const { _internals: closeStageInternals } = await import(
	'../../../src/commands/close/internals.js'
);
const REAL_UNLINK_ACTIVE_STATE =
	closeStageInternals.unlinkActiveStateFileWithRetry;

describe('close clean-stage post-mortem cleanup warning — regression: raw control bytes rendered from the archive-sourced name and unlink failure (#3943 AC2)', () => {
	let tmpDir: string;

	afterEach(() => {
		// Best-effort cleanup per the writing-tests skill (Bun mock.module
		// restore is unreliable; per-file process isolation is the real guard).
		mock.restore();
		if (tmpDir) {
			realFs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('the active-state cleanup failure warning carries no control byte either', async () => {
		tmpDir = canonicalMkdtemp('ac2-activestate-render-');
		const swarmDir = path.join(tmpDir, '.swarm');
		realFs.mkdirSync(swarmDir, { recursive: true });

		// The active-state cleanup catch is the THIRD clean-stage render site
		// (#3943's defect-class sweep sibling). Its artifact name is a constant,
		// but the OS error text is interpolated — so the error MESSAGE is the
		// carrier. Force a non-ENOENT failure whose message carries control
		// bytes and assert the rendered warning is control-free.
		closeStageInternals.unlinkActiveStateFileWithRetry = (async (
			filePath: string,
		): Promise<void> => {
			if (filePath.endsWith('dark-matter.md')) {
				const err = new Error(
					`EPERM: operation not permitted, unlink '${filePath}' ${cc(0x02)}${cc(0x7f)}`,
				) as NodeJS.ErrnoException;
				err.code = 'EPERM';
				throw err;
			}
			return REAL_UNLINK_ACTIVE_STATE(filePath);
		}) as typeof REAL_UNLINK_ACTIVE_STATE;

		try {
			const ctx = {
				directory: tmpDir,
				swarmDir,
				warnings: [] as string[],
				// 'dark-matter.md' is claimed as ARCHIVED, so the clean stage
				// unlinks it — that is the site-298 render path.
				archivedActiveStateFiles: new Set<string>([
					EVIL_NAME,
					'dark-matter.md',
				]),
				archivedActiveStateDirs: new Set<string>(),
				archiveFailureReasons: new Map(),
				projectName: 'ac2',
				isForced: false,
				planAlreadyDone: true,
			} as unknown as Parameters<typeof runCleanStage>[0];

			await expect(runCleanStage(ctx)).resolves.toBeDefined();

			const warning = ctx.warnings.find(
				(w) =>
					w.startsWith('Failed to clean active-state file ') &&
					w.includes('dark-matter.md'),
			);
			expect(
				warning,
				'expected the active-state cleanup-failure warning to be emitted',
			).toBeDefined();
			expect(
				CONTROL.test(warning!),
				`the active-state cleanup warning carried a control byte: ${JSON.stringify(warning)}`,
			).toBe(false);
			// The diagnostic survives neutralization.
			expect(warning!).toContain('EPERM');
		} finally {
			closeStageInternals.unlinkActiveStateFileWithRetry =
				REAL_UNLINK_ACTIVE_STATE;
		}
	});

	test('post-mortem cleanup operator warning and close-summary persisted text carry no C0/DEL/C1 byte', async () => {
		tmpDir = canonicalMkdtemp('ac2-postmortem-render-');
		const swarmDir = path.join(tmpDir, '.swarm');
		realFs.mkdirSync(swarmDir, { recursive: true });

		const ctx = {
			directory: tmpDir,
			swarmDir,
			warnings: [] as string[],
			archivedActiveStateFiles: new Set<string>([EVIL_NAME]),
			archivedActiveStateDirs: new Set<string>(),
			archiveFailureReasons: new Map(),
			projectName: 'ac2',
			isForced: false,
			planAlreadyDone: true,
		} as unknown as Parameters<typeof runCleanStage>[0];

		await expect(runCleanStage(ctx)).resolves.toBeDefined();
		expect(ctx.warnings.join('\n')).not.toContain('Maximum call stack');

		const warning = ctx.warnings.find(
			(w) =>
				w.startsWith('Failed to clean active-state file ') &&
				w.includes('post-mortem'),
		);
		// Reachability: the gate regex admitted the control-bearing name and
		// the non-ENOENT unlink failure reached the render site at line 333.
		expect(
			warning,
			'expected the post-mortem cleanup-failure warning to be emitted',
		).toBeDefined();

		// Anti-removal guard: the diagnostic stays informative — the errno and
		// the file kind survive neutralization (neutralizeResidueName is
		// byte-identical for control-free text).
		expect(warning!).toContain('[EPERM]');
		expect(warning!).toContain('post-mortem-a');
		expect(warning!).toContain('.md');
		expect(warning!).toContain('EPERM: operation not permitted, unlink');

		// AC2 core: the operator warning carries no C0/DEL/C1 byte.
		expect(
			CONTROL.test(warning!),
			`warning still carries raw control bytes: ${JSON.stringify(warning)}`,
		).toBe(false);

		// AC2 core, persisted surface (orchestrator.ts:712-714 writes each
		// warning verbatim as a `- ${w}` line into .swarm/close-summary.md).
		const persistedLine = `- ${warning}`;
		expect(
			CONTROL.test(persistedLine),
			`close-summary.md persisted line still carries raw control bytes: ${JSON.stringify(persistedLine)}`,
		).toBe(false);
	}, 30_000);
});
