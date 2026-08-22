import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	clearToolchainCache,
	_internals as discoveryInternals,
} from '../../../src/build/discovery';
import { pkg_audit } from '../../../src/tools/pkg-audit';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Split out of pkg-audit.test.ts (FR-006 ratchet: that file is over the
// 500-line cap and must not grow). See pkg-audit.test.ts's
// "bundle-audit (Ruby) Tests" describe block for the sibling coverage this
// complements.

describe('pkg_audit (bundle-audit / Ruby) — host-independent unavailability', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('pkg-audit-ruby-availability-');
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function getMockContext(): ToolContext {
		return {
			sessionID: 'test-session',
			messageID: 'test-message',
			agent: 'test-agent',
			directory: tempDir,
			worktree: tempDir,
			abort: new AbortController().signal,
			metadata: () => ({}),
			ask: async () => undefined,
		} as ToolContext;
	}

	it('should return clean with note when neither bundle-audit nor bundle on PATH', async () => {
		// The "not installed" note comes from `runBundleAudit`'s
		// `isCommandAvailable` early return, so the test must ESTABLISH that
		// precondition rather than inherit it from the host. It previously did
		// not, and passed only where Ruby happens to be absent — which is true
		// on Windows and ubuntu, and FALSE on macos-latest, where Ruby ships
		// preinstalled so `bundle` resolves, the early return never fires, and
		// the assertion sees "bundle-audit JSON output could not be parsed"
		// instead. Same host-dependent-precondition class as the
		// fabricated-path failures in #2236.
		//
		// Forced unavailable through the discovery DI seam (mirroring the dart
		// case in pkg-audit.test.ts). Cache cleared either side so nothing
		// leaks between tests or files.
		const originalSpawnSync = discoveryInternals.spawnSyncImpl;
		clearToolchainCache();
		discoveryInternals.spawnSyncImpl = () => ({
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			exitCode: 1,
			success: false,
		});

		try {
			const result = await pkg_audit.execute(
				{ ecosystem: 'ruby' },
				getMockContext(),
			);
			const parsed = JSON.parse(result);

			expect(parsed.clean).toBe(true);
			expect(parsed.note).toContain('not installed');
		} finally {
			discoveryInternals.spawnSyncImpl = originalSpawnSync;
			clearToolchainCache();
		}
	});
});
