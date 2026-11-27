/**
 * Trace 3943-3951-close-residue-recoverability — #3943 AC1 (clean-stage
 * quarantine-failure render site).
 *
 * Frozen discriminating check (RED at base 18c09e03e, GREEN after the fix).
 *
 * src/commands/close/clean-stage.ts:485-494 interpolates the raw
 * `quarantineSwarmResidue` failure message (`err.message`) into
 * `ctx.warnings` without the control-character neutralization PR #3942
 * applied to every other residue-derived render site (siblings clean-stage
 * 379/400/479, archive-stage 396, doctor 442-446/468-470 all route through
 * `neutralizeResidueName`). `handleCloseCommand` persists `ctx.warnings`
 * VERBATIM into `.swarm/close-summary.md` (orchestrator.ts:712-714, the
 * `## Warnings` block maps each warning to a `- ${w}` line), so producer-side
 * neutralization is the contract; at base the raw bytes reach the operator
 * warning and the persisted summary.
 *
 * Injection route: the quarantine catch at 485-494 is reachable only via an
 * inventory/manifest-level throw (per-entry moves are guarded, PRR-005). The
 * allowlisted seam `src/services/swarm-residue.ts:_internals.queryTracked`
 * runs OUTSIDE any try/catch inside `inventorySwarmResidue`
 * (src/services/swarm-residue.ts:266), so a throw from it propagates through
 * the REAL `quarantineSwarmResidue` into the REAL clean-stage catch — no
 * module mock needed (the `src/services/swarm-residue` mock.module target is
 * NOT allowlisted, so the primary route from the brief was rejected; the
 * manifest-write-failure fallback was also rejected because its OS error
 * message embeds only control-free Windows paths — NTFS forbids control
 * bytes in real filenames — which would make the no-control assertion pass
 * vacuously at base). The inert fixture is an OS-style error whose message
 * embeds a control-character-bearing path. Control bytes are materialized via
 * String.fromCharCode so no literal control byte ever lives in a real
 * filename or in this source line.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCleanStage } from '../../../src/commands/close/clean-stage.js';
import { _internals as residueInternals } from '../../../src/services/swarm-residue.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const cc = (code: number): string => String.fromCodePoint(code);

/** C0 (U+0000-U+001F) + DEL (U+007F) + C1 (U+0080-U+009F) — the same class
 *  neutralizeResidueName strips (\p{Cc}). */
const CONTROL = new RegExp(
	`[${cc(0x00)}-${cc(0x1f)}${cc(0x7f)}-${cc(0x9f)}]`,
	'u',
);

/** Inert OS-style quarantine failure carrying NUL, BEL, ESC, DEL, and NEL. */
const EVIL_REASON =
	'EPERM: operation not permitted, rename ' +
	`'res${cc(0x00)}id-abc${cc(0x07)}.tmp' -> ` +
	`'quarantine\res${cc(0x1b)}[2Kid-${cc(0x7f)}abc${cc(0x85)}.tmp'`;

describe('close clean-stage quarantine-failure warning — regression: raw control bytes rendered from the quarantineSwarmResidue failure message (#3943 AC1)', () => {
	const realQueryTracked = residueInternals.queryTracked;
	let tmpDir: string;

	afterEach(() => {
		// Restore the seam even when the test body threw mid-flight.
		residueInternals.queryTracked = realQueryTracked;
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('quarantine-failure operator warning and close-summary persisted text carry no C0/DEL/C1 byte', async () => {
		tmpDir = canonicalMkdtemp('ac1-quarantine-render-');
		const swarmDir = path.join(tmpDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// Force a quarantine-time failure whose message embeds a
		// control-character-bearing path (inventory-level throw; full-arg
		// forwarding wrapper per the seam rule — the throw happens before the
		// forwarding, so the base arity never constrains the wrapper).
		residueInternals.queryTracked = ((...args: unknown[]) => {
			void args;
			throw new Error(EVIL_REASON);
		}) as typeof residueInternals.queryTracked;

		const ctx = {
			directory: tmpDir,
			swarmDir,
			warnings: [] as string[],
			archivedActiveStateFiles: new Set<string>(),
			archivedActiveStateDirs: new Set<string>(),
			archiveFailureReasons: new Map(),
			projectName: 'ac1',
			isForced: false,
			planAlreadyDone: true,
		} as unknown as Parameters<typeof runCleanStage>[0];

		// The clean stage must not throw out of the quarantine catch — the
		// failure is a warning path.
		await expect(runCleanStage(ctx)).resolves.toBeDefined();

		const warning = ctx.warnings.find((w) =>
			w.startsWith('Atomic-write residue quarantine failed'),
		);
		// Reachability: the injected failure DID reach the clean-stage catch.
		expect(
			warning,
			'expected the quarantine-failure warning (catch at clean-stage.ts:485-494) to be emitted',
		).toBeDefined();

		// Anti-removal guard: neutralization must not be "fixed" by dropping
		// the diagnostic. The stable prefix and a rendering of the failing
		// candidate survive.
		expect(warning!).toContain('Atomic-write residue quarantine failed');
		expect(warning!).toContain('res');
		expect(warning!).toContain('.tmp');

		// AC1 core: the operator warning carries no C0/DEL/C1 byte.
		expect(
			CONTROL.test(warning!),
			`warning still carries raw control bytes: ${JSON.stringify(warning)}`,
		).toBe(false);

		// AC1 core, persisted surface: handleCloseCommand writes each warning
		// verbatim as `- ${w}` under the `## Warnings` heading of
		// .swarm/close-summary.md (orchestrator.ts:712-714) — assert the exact
		// persisted line shape is control-free.
		const persistedLine = `- ${warning}`;
		expect(
			CONTROL.test(persistedLine),
			`close-summary.md persisted line still carries raw control bytes: ${JSON.stringify(persistedLine)}`,
		).toBe(false);
	}, 30_000);
});
