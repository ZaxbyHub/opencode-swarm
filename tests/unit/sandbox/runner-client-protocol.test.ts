/**
 * Issue #2475: runner probe protocol handshake.
 *
 * The runner's --probe output carries protocol_schema_version and
 * runner_version. The TypeScript client must ACCEPT a matching protocol
 * version and REFUSE a missing or mismatched one (stale or PATH-shadowed
 * foreign binary) — refused binaries surface as unavailable with a
 * protocol-mismatch error, feeding the visible-downgrade path.
 *
 * process.platform is overridden to win32 (the macOS env-hardening test
 * pattern) so these run on every OS, not just Windows runners.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	_resetProbeCache,
	probe,
	RUNNER_PROTOCOL_SCHEMA_VERSION,
} from '../../../src/sandbox/win32/runner-client';

const realFindRunnerBinary = _internals.findRunnerBinary;
const realSpawnRunner = _internals.spawnRunner;
const platformDescriptor = Object.getOwnPropertyDescriptor(
	process,
	'platform',
) as PropertyDescriptor;

function makeSpawnReturning(json: string) {
	return ((_cmd: string, _args: string[], _opts: unknown) => ({
		status: 0,
		stdout: json,
		stderr: '',
		error: null,
	})) as typeof realSpawnRunner;
}

function fullProbe(overrides: Record<string, unknown>): string {
	return JSON.stringify({
		app_container_available: true,
		lpac_available: false,
		restricted_token_available: true,
		private_desktop_creatable: true,
		integrity_level: 'medium',
		is_admin: false,
		os_version: '10.0.22631',
		arch: 'x86_64',
		runner_version: '0.1.0',
		protocol_schema_version: RUNNER_PROTOCOL_SCHEMA_VERSION,
		...overrides,
	});
}

describe('runner-client probe protocol handshake (#2475)', () => {
	beforeEach(() => {
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			configurable: true,
		});
		_internals.findRunnerBinary = () => 'C:\\fake\\swarm-sandbox-runner.exe';
		_resetProbeCache();
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', platformDescriptor);
		_internals.findRunnerBinary = realFindRunnerBinary;
		_internals.spawnRunner = realSpawnRunner;
		_resetProbeCache();
	});

	test('accepts a probe reporting the expected protocol version', () => {
		_internals.spawnRunner = makeSpawnReturning(fullProbe({}));

		const result = probe();
		expect(result.available).toBe(true);
		expect(result.mode).toBe('app-container');
		expect(result.capabilities?.protocol_schema_version).toBe(
			RUNNER_PROTOCOL_SCHEMA_VERSION,
		);
		expect(result.capabilities?.runner_version).toBe('0.1.0');
		expect(result.error).toBeUndefined();
	});

	test('refuses a probe reporting a mismatched protocol version', () => {
		_internals.spawnRunner = makeSpawnReturning(
			fullProbe({ protocol_schema_version: 2 }),
		);

		const result = probe();
		expect(result.available).toBe(false);
		expect(result.mode).toBe('none');
		expect(result.error).toContain('protocol mismatch');
		expect(result.error).toContain('got 2');
	});

	test('refuses a probe with no protocol version (stale/foreign binary)', () => {
		const legacyProbe = JSON.stringify({
			app_container_available: true,
			lpac_available: false,
			restricted_token_available: true,
			private_desktop_creatable: true,
			integrity_level: 'medium',
			is_admin: false,
			os_version: '10.0.22631',
			arch: 'x86_64',
		});
		_internals.spawnRunner = makeSpawnReturning(legacyProbe);

		const result = probe();
		expect(result.available).toBe(false);
		expect(result.error).toContain('protocol mismatch');
		expect(result.error).toContain('got none');
	});

	test('the expected protocol version constant is 1 (schema stability pin)', () => {
		expect(RUNNER_PROTOCOL_SCHEMA_VERSION).toBe(1);
	});
});
