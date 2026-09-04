/**
 * Issue #2475 (#2259): PowerShell wrapper env-override ordering.
 *
 * The weak-path wrapper must apply per-call envOverrides BEFORE its own scoped
 * TEMP/TMP and safe PATH assignments — the documented contract on
 * getEnvOverrides() ("TEMP/TMP are set to null (will be set to scoped temp at
 * runtime via wrapCommand)"). With the old ordering (overrides LAST), a
 * declared TEMP:null would Remove-Item the scoped temp AFTER it was set,
 * leaving the child with no TEMP and breaking Join-Path $env:TEMP for
 * multiline commands under $ErrorActionPreference = 'Stop'.
 */

import { afterEach, describe, expect, test } from 'bun:test';

const isWin = process.platform === 'win32';

import {
	_internals as reInternals,
	WindowsSandboxExecutor,
} from '../../../src/sandbox/win32/restricted-environment-executor';

const realProbeWindowsSandbox = reInternals.probeWindowsSandbox;

afterEach(() => {
	(
		reInternals as { probeWindowsSandbox: typeof realProbeWindowsSandbox }
	).probeWindowsSandbox = realProbeWindowsSandbox;
});

function decodeWrappedScript(wrapped: string): string {
	const payload = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/.exec(wrapped)?.[1];
	return payload ? Buffer.from(payload, 'base64').toString('utf16le') : wrapped;
}

describe('WindowsSandboxExecutor — env override ordering (#2475)', () => {
	test.skipIf(!isWin)(
		'null TEMP override (Remove-Item) runs BEFORE the scoped TEMP assignment',
		() => {
			(
				reInternals as { probeWindowsSandbox: () => boolean }
			).probeWindowsSandbox = () => true;

			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hi', [], undefined, {
				TEMP: null,
				TMP: null,
				PATH: 'C:\\Windows\\System32',
			});
			const script = decodeWrappedScript(wrapped);

			const removalIdx = script.indexOf('Remove-Item Env:TEMP');
			const scopedIdx = script.indexOf("$env:TEMP = '");
			expect(removalIdx).toBeGreaterThanOrEqual(0);
			expect(scopedIdx).toBeGreaterThan(removalIdx);

			// The scoped temp assignment still stands at execution time (it is
			// the LAST write for TEMP before the command runs).
			const lastTempWrite = script.lastIndexOf("$env:TEMP = '");
			expect(lastTempWrite).toBeGreaterThan(removalIdx);
		},
	);

	test.skipIf(!isWin)(
		'string PATH override runs BEFORE the safe-PATH assignment (executor hardening wins)',
		() => {
			(
				reInternals as { probeWindowsSandbox: () => boolean }
			).probeWindowsSandbox = () => true;

			const executor = new WindowsSandboxExecutor([]);
			const wrapped = executor.wrapCommand('echo hi', [], undefined, {
				PATH: 'C:\\attacker',
			});
			const script = decodeWrappedScript(wrapped);

			const overrideIdx = script.indexOf("$env:PATH = 'C:\\attacker';");
			const safeIdx = script.indexOf("$env:PATH = '");
			// The override line exists and the safe-PATH assignment (which
			// follows it in program order) is a DIFFERENT, later statement.
			expect(overrideIdx).toBeGreaterThanOrEqual(0);
			const afterOverride = script.indexOf("$env:PATH = '", overrideIdx + 1);
			expect(afterOverride).toBeGreaterThan(overrideIdx);
			expect(script.lastIndexOf("$env:PATH = '")).toBeGreaterThan(overrideIdx);
			// Safe-path hardening line is still present in the script.
			expect(safeIdx).toBeGreaterThanOrEqual(0);
		},
	);
});
