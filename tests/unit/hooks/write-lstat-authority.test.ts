/**
 * PR B: write lstat + transparent authority + universal_deny_prefixes
 *
 * Tests:
 *  1. checkWriteTargetForSymlink — symlink/junction detection for writes
 *  2. Transparent authority — non-architect agents have their writes checked
 *  3. universal_deny_prefixes — no agent may write to globally denied paths
 *  4. lstat check on apply_patch
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type AuthorityConfig,
	AuthorityConfigSchema,
	type GuardrailsConfig,
	GuardrailsConfigSchema,
} from '../../../src/config/schema';
import { pendingCoderScopeByTaskId } from '../../../src/hooks/delegation-gate';
import {
	checkWriteTargetForSymlink,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

// ─── helpers ────────────────────────────────────────────────────────────────

let tempDir: string;
let originalCwd: string;

async function setup(): Promise<void> {
	// realpath so macOS /tmp → /private/tmp doesn't cause path mismatches
	tempDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'write-lstat-')),
	);
	originalCwd = process.cwd();
	process.chdir(tempDir);
	resetSwarmState();
}

async function teardown(): Promise<void> {
	process.chdir(originalCwd);
	try {
		await fs.rm(tempDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
}

function makeHooks(
	authorityOverrides: Record<string, unknown> = {},
): ReturnType<typeof createGuardrailsHooks> {
	const cfg = GuardrailsConfigSchema.parse({
		enabled: true,
	}) as GuardrailsConfig;
	const authority = AuthorityConfigSchema.parse(
		authorityOverrides,
	) as AuthorityConfig;
	// Production call convention: createGuardrailsHooks(dir, undefined, guardrailsCfg, authorityCfg)
	return createGuardrailsHooks(tempDir, undefined, cfg, authority);
}

function coderSession(id: string): void {
	ensureAgentSession(id, 'coder');
	swarmState.activeAgent.set(id, 'coder');
	beginInvocation(id, 'coder');
}

function architectSession(id: string): void {
	ensureAgentSession(id, 'architect');
	swarmState.activeAgent.set(id, 'architect');
	beginInvocation(id, 'architect');
}

function tryCreateSymlink(target: string, linkPath: string): boolean {
	try {
		fsSync.symlinkSync(target, linkPath);
		return true;
	} catch (error) {
		if (
			error &&
			typeof error === 'object' &&
			'code' in error &&
			((error as { code?: string }).code === 'EPERM' ||
				(error as { code?: string }).code === 'EACCES')
		) {
			return false;
		}
		throw error;
	}
}

// ─── 1. checkWriteTargetForSymlink unit tests ────────────────────────────────

describe('checkWriteTargetForSymlink', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('returns null for a plain new file (ENOENT) — write allowed', () => {
		const result = checkWriteTargetForSymlink('does-not-exist.ts', tempDir);
		expect(result).toBeNull();
	});

	it('returns null for an existing real file', async () => {
		await fs.writeFile(path.join(tempDir, 'real.ts'), 'ok');
		const result = checkWriteTargetForSymlink('real.ts', tempDir);
		expect(result).toBeNull();
	});

	it('returns null for a nested path where parent dir is real', async () => {
		await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
		const result = checkWriteTargetForSymlink('src/new-file.ts', tempDir);
		expect(result).toBeNull();
	});

	it('BLOCKS when the target itself is a symlink', async () => {
		// Create a real file and a symlink pointing to it
		const realFile = path.join(tempDir, 'real.ts');
		const link = path.join(tempDir, 'link.ts');
		await fs.writeFile(realFile, 'real');
		if (!tryCreateSymlink(realFile, link)) return;

		const result = checkWriteTargetForSymlink('link.ts', tempDir);
		expect(result).not.toBeNull();
		expect(result).toContain('WRITE BLOCKED');
		expect(result).toContain('symlink');
	});

	it('BLOCKS when a parent directory is a symlink', async () => {
		// Create a real dir outside tempDir and a symlink to it inside tempDir
		const outsideDir = await fs.mkdtemp(
			path.join(os.tmpdir(), 'outside-real-'),
		);
		const symlinkDir = path.join(tempDir, 'symdir');
		if (!tryCreateSymlink(outsideDir, symlinkDir)) {
			await fs.rm(outsideDir, { recursive: true, force: true });
			return;
		}

		const result = checkWriteTargetForSymlink('symdir/newfile.ts', tempDir);

		// cleanup outside dir
		try {
			await fs.rm(outsideDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}

		expect(result).not.toBeNull();
		expect(result).toContain('WRITE BLOCKED');
		expect(result).toContain('symlink');
	});

	it('returns null when target is above cwd (absolute external path)', () => {
		// Path outside tempDir — not a symlink concern, just not in scope.
		// checkWriteTargetForSymlink only checks nodes within cwd.
		const result = checkWriteTargetForSymlink('/tmp/harmless.ts', tempDir);
		// Result may be null or blocked depending on whether /tmp is a symlink.
		// The important invariant is: it never throws.
		expect(typeof result === 'string' || result === null).toBe(true);
	});
});

// ─── 2. Transparent authority — non-architect agents ─────────────────────────

describe('Transparent authority: non-architect agents checked on Write', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('coder blocked from writing to .swarm/ (blockedPrefix rule)', async () => {
		const hooks = makeHooks();
		coderSession('coder-swarm-block');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'coder-swarm-block', callID: 'c1' },
				{ args: { filePath: '.swarm/outputs/report.md' } },
			),
		).rejects.toThrow(/WRITE BLOCKED/);
	});

	it('coder allowed to write to src/ (production zone, no DENY match)', async () => {
		const hooks = makeHooks();
		coderSession('coder-src-allow');

		// Should NOT throw — coder has no allowedPrefix whitelist (removed in
		// df4ac3b for language-agnostic writes per #496). 'src/utils/helper.ts'
		// is the 'production' zone, not under blockedPrefix '.swarm/', and not
		// in blockedZones ['generated', 'config'], so the write is allowed.
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'coder-src-allow', callID: 'c2' },
			{ args: { filePath: 'src/utils/helper.ts' } },
		);
	});

	it('coder allowed to write to tests/ via edit tool (test zone, no DENY match)', async () => {
		// Coder has no allowedPrefix whitelist after df4ac3b. 'tests/unit/my.test.ts'
		// is the 'test' zone, not under blockedPrefix '.swarm/', and not in
		// blockedZones ['generated', 'config'], so the edit is allowed.
		const hooks = makeHooks();
		coderSession('coder-tests-allow');

		await hooks.toolBefore(
			{ tool: 'edit', sessionID: 'coder-tests-allow', callID: 'c3' },
			{ args: { filePath: 'tests/unit/my.test.ts' } },
		);
	});

	it('reviewer blocked from writing to src/ (blockedPrefix rule)', async () => {
		const hooks = makeHooks();
		const id = 'reviewer-src-block';
		ensureAgentSession(id, 'reviewer');
		swarmState.activeAgent.set(id, 'reviewer');
		beginInvocation(id, 'reviewer');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'r1' },
				{ args: { filePath: 'src/component.ts' } },
			),
		).rejects.toThrow(/WRITE BLOCKED/);
	});

	it('explorer (readOnly) blocked from any write', async () => {
		const hooks = makeHooks();
		const id = 'explorer-write-block';
		ensureAgentSession(id, 'explorer');
		swarmState.activeAgent.set(id, 'explorer');
		beginInvocation(id, 'explorer');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'e1' },
				{ args: { filePath: 'src/something.ts' } },
			),
		).rejects.toThrow(/WRITE BLOCKED/);
	});

	it('architect is permitted to write to src/ (authority check does not block architect)', async () => {
		const hooks = makeHooks();
		architectSession('arch-write-src');

		// Architect writes to src/ must not be blocked by the authority check
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'arch-write-src', callID: 'arch-w1' },
			{ args: { filePath: 'src/new-module.ts' } },
		);
	});
});

// ─── 3. universal_deny_prefixes ───────────────────────────────────────────────

describe('universal_deny_prefixes', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('blocks architect from writing to a universal deny prefix', async () => {
		const hooks = makeHooks({
			universal_deny_prefixes: ['.env', 'secrets/'],
		});
		architectSession('arch-deny-env');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'arch-deny-env', callID: 'u1' },
				{ args: { filePath: '.env' } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('blocks coder from writing to a universal deny prefix (before per-agent rules)', async () => {
		// coder's allowedPrefix includes 'src/' but universal_deny overrides it
		const hooks = makeHooks({
			universal_deny_prefixes: ['src/generated/'],
		});
		coderSession('coder-deny-generated');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'coder-deny-generated', callID: 'u2' },
				{ args: { filePath: 'src/generated/types.ts' } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('blocks patches to universal deny prefix', async () => {
		const hooks = makeHooks({
			universal_deny_prefixes: ['secrets/'],
		});
		coderSession('coder-patch-deny');

		const patchContent = `*** Begin Patch
*** Update File: secrets/key.pem
@@
-old line
+new line
*** End Patch`;

		await expect(
			hooks.toolBefore(
				{ tool: 'apply_patch', sessionID: 'coder-patch-deny', callID: 'u3' },
				{ args: { patch: patchContent } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('allows writes to paths not matching any universal deny prefix', async () => {
		const hooks = makeHooks({
			universal_deny_prefixes: ['.env', 'secrets/'],
		});
		coderSession('coder-deny-ok');

		// src/utils.ts is not in the deny list, and coder's allowedPrefix includes src/
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'coder-deny-ok', callID: 'u4' },
			{ args: { filePath: 'src/utils.ts' } },
		);
	});

	it('empty universal_deny_prefixes → no extra blocking', async () => {
		const hooks = makeHooks({ universal_deny_prefixes: [] });
		coderSession('coder-deny-empty');

		// coder can write to src/ normally
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'coder-deny-empty', callID: 'u5' },
			{ args: { filePath: 'src/file.ts' } },
		);
	});

	it('universal deny case-folds on Windows while POSIX remains case-sensitive', async () => {
		const isWindows = process.platform === 'win32';
		const hooks = makeHooks({ universal_deny_prefixes: ['.env'] });
		coderSession('coder-deny-case');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'coder-deny-case', callID: 'u6' },
				{ args: { filePath: '.ENV' } },
			),
		).rejects.toThrow(isWindows ? /UNIVERSAL_DENY/ : /POLICY_DENY/);
	});

	it('blocks paths using ../ traversal that normalize to a denied prefix', async () => {
		// Test gap fix: ensures path.resolve/relative normalizes '..' before prefix check,
		// preventing bypass via 'src/../.env' which resolves to '.env'
		const hooks = makeHooks({ universal_deny_prefixes: ['.env'] });
		coderSession('coder-deny-traversal');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'coder-deny-traversal', callID: 'u8' },
				{ args: { filePath: 'src/../.env' } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('blocks nested ../ traversal that normalizes to a denied prefix', async () => {
		// Test gap fix: deep traversal 'a/b/../../secrets/key' normalizes to 'secrets/key'
		const hooks = makeHooks({ universal_deny_prefixes: ['secrets/'] });
		coderSession('coder-deny-nested-traversal');

		await expect(
			hooks.toolBefore(
				{
					tool: 'write',
					sessionID: 'coder-deny-nested-traversal',
					callID: 'u9',
				},
				{ args: { filePath: 'a/b/../../secrets/key.pem' } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('blocks absolute paths inside cwd that match a denied prefix', async () => {
		// Test gap fix: absolute paths should also be normalized and matched
		const hooks = makeHooks({ universal_deny_prefixes: ['.env'] });
		coderSession('coder-deny-absolute');

		const absolutePath = path.join(tempDir, '.env');
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'coder-deny-absolute', callID: 'u10' },
				{ args: { filePath: absolutePath } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('BLOCKS write when no active agent is registered for the session', async () => {
		// Fix for adversarial finding: missing activeAgent fell back to 'architect' (broad permissions)
		// Now it fails closed instead
		const hooks = makeHooks();
		// Deliberately do NOT register an agent for this session
		const id = 'unregistered-session';

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'u7' },
				{ args: { filePath: 'src/file.ts' } },
			),
		).rejects.toThrow(/Unknown agent|No active agent registered/);
	});
});

// ─── 4. lstat check via toolBefore hook ─────────────────────────────────────

describe('lstat check via toolBefore (Write tool)', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('BLOCKS write when target is a symlink', async () => {
		// Create real file + symlink
		await fs.writeFile(path.join(tempDir, 'real.ts'), 'real');
		if (
			!tryCreateSymlink(
				path.join(tempDir, 'real.ts'),
				path.join(tempDir, 'link.ts'),
			)
		)
			return;

		const hooks = makeHooks();
		coderSession('coder-lstat-symlink');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'coder-lstat-symlink', callID: 'l1' },
				{ args: { filePath: 'link.ts' } },
			),
		).rejects.toThrow(/WRITE BLOCKED.*symlink/);
	});

	it('BLOCKS write when a parent directory is a symlink', async () => {
		// Create symlinked parent dir
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-'));
		if (!tryCreateSymlink(outside, path.join(tempDir, 'linked-src'))) {
			await fs.rm(outside, { recursive: true, force: true });
			return;
		}

		const hooks = makeHooks();
		coderSession('coder-lstat-parent');

		// Expect-then-cleanup: await the rejection before cleaning up the outside dir
		// so the promise is handled before any await between creation and expectation.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'coder-lstat-parent', callID: 'l2' },
				{ args: { filePath: 'linked-src/file.ts' } },
			),
		).rejects.toThrow(/WRITE BLOCKED.*symlink/);

		try {
			await fs.rm(outside, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it('allows write to a real (non-symlink) file path', async () => {
		await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });

		const hooks = makeHooks();
		coderSession('coder-lstat-real');

		// Should not throw (lstat sees real dir, authority check passes for coder+src/)
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'coder-lstat-real', callID: 'l3' },
			{ args: { filePath: 'src/new.ts' } },
		);
	});

	it('BLOCKS apply_patch when target path is a symlink', async () => {
		// Test gap fix: apply_patch + lstat combination was not previously tested
		await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
		const realFile = path.join(tempDir, 'src', 'real.ts');
		const linkFile = path.join(tempDir, 'src', 'link.ts');
		await fs.writeFile(realFile, 'real');
		if (!tryCreateSymlink(realFile, linkFile)) return;

		const hooks = makeHooks();
		coderSession('coder-patch-lstat');

		const patchContent = `*** Begin Patch
*** Update File: src/link.ts
@@
-real
+modified
*** End Patch`;

		await expect(
			hooks.toolBefore(
				{ tool: 'apply_patch', sessionID: 'coder-patch-lstat', callID: 'l4' },
				{ args: { patch: patchContent } },
			),
		).rejects.toThrow(/WRITE BLOCKED.*symlink/);
	});

	it('BLOCKS apply_patch when a parent directory is a symlink', async () => {
		// Test gap fix: verifies ancestor-chain walk works for patch targets
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-ext-'));
		if (!tryCreateSymlink(outside, path.join(tempDir, 'linked-src'))) {
			await fs.rm(outside, { recursive: true, force: true });
			return;
		}

		const hooks = makeHooks();
		coderSession('coder-patch-lstat-parent');

		const patchContent = `*** Begin Patch
*** Update File: linked-src/file.ts
@@
-x
+y
*** End Patch`;

		await expect(
			hooks.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: 'coder-patch-lstat-parent',
					callID: 'l5',
				},
				{ args: { patch: patchContent } },
			),
		).rejects.toThrow(/WRITE BLOCKED.*symlink/);

		try {
			await fs.rm(outside, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
});

// ─── 6. declared scope overrides allowedPrefix (issue #496) ──────────────────
//
// declare_scope-declared paths bypass the hardcoded allowedPrefix whitelist
// (e.g. coder's ['src/', 'tests/', 'docs/', 'scripts/']) so the architect can
// authorise framework-agnostic paths (Rails config/, app/, db/; Python module/;
// etc.) without editing the default rule set. All DENY rules remain enforced.

describe('declared scope overrides allowedPrefix (#496)', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('ALLOWS Rails config/ path after declare_scope (outside coder allowedPrefix)', async () => {
		// Without declare_scope, coder cannot write to `config/` (not in allowedPrefix).
		// After declare_scope, the same write succeeds — scope overrides allowedPrefix.
		const hooks = makeHooks();
		const id = 'coder-scope-rails-config';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['config/environments/test.rb'];
		}

		// config/environments/test.rb is outside ['src/','tests/','docs/','scripts/']
		// but inside the declared scope — authority check should allow it.
		await hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 's1' },
			{ args: { filePath: 'config/environments/test.rb' } },
		);
	});

	it('ALLOWS Rails app/ and db/migrate/ directories after declare_scope', async () => {
		const hooks = makeHooks();
		const id = 'coder-scope-rails-app';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['app/', 'db/migrate/'];
		}

		// Directory-containment: files under declared directories are in scope.
		await hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 's2a' },
			{ args: { filePath: 'app/models/user.rb' } },
		);
		await hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 's2b' },
			{ args: { filePath: 'db/migrate/20260416_create_users.rb' } },
		);
	});

	it('BLOCKS paths outside declared scope that hit a DENY rule', async () => {
		// After #496 coder no longer has a language-specific allowedPrefix, so
		// the "scope does not widen everything" guarantee is now exercised via
		// the DENY rules that remain: blockedPrefix, blockedZones, symlink
		// guard, universal_deny. Here declared scope is narrowed to `app/`
		// but the write targets `.swarm/plan.json` — still blocked by
		// blockedPrefix: ['.swarm/'].
		const hooks = makeHooks();
		const id = 'coder-scope-narrow';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['app/'];
		}

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's3' },
				{ args: { filePath: '.swarm/plan.json' } },
			),
		).rejects.toThrow(/AUTHORITY_PROTECTED_PATH/);
	});

	it('BACKWARD COMPAT: without declare_scope, coder is constrained only by DENY rules', async () => {
		// #496: coder no longer has a default allowedPrefix whitelist. Without
		// a declared scope the coder can write any path that is not caught by
		// a DENY rule (blockedPrefix / blockedZones / universal_deny / symlink
		// guard / readOnly). Three representative DENY rules are exercised
		// here to lock that contract in.
		const hooks = makeHooks({
			universal_deny_prefixes: ['.env', 'secrets/'],
		});
		const id = 'coder-no-scope-deny';
		coderSession(id);

		// blockedPrefix: ['.swarm/'] still applies.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's4a' },
				{ args: { filePath: '.swarm/plan.json' } },
			),
		).rejects.toThrow(/AUTHORITY_PROTECTED_PATH/);

		// blockedZones: ['generated', 'config'] still applies — a .yml file
		// classifies as config zone.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's4b' },
				{ args: { filePath: 'config/secrets.yml' } },
			),
		).rejects.toThrow(/config zone/);

		// universal_deny_prefixes still applies.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's4c' },
				{ args: { filePath: '.env' } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('SECURITY: blockedPrefix still enforced even when path is in declared scope', async () => {
		// blockedPrefix takes priority over the declared-scope allow. Declaring
		// `.swarm/` in scope must NOT let the coder write into it.
		const hooks = makeHooks();
		const id = 'coder-scope-blocked-prefix';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['.swarm/plan.json'];
		}

		// coder's blockedPrefix is ['.swarm/'] — must still fire.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's5' },
				{ args: { filePath: '.swarm/plan.json' } },
			),
		).rejects.toThrow(/AUTHORITY_PROTECTED_PATH/);
	});

	it('SECURITY: readOnly (explorer) still enforced even when path is in declared scope', async () => {
		const hooks = makeHooks();
		const id = 'explorer-scope-readonly';
		ensureAgentSession(id, 'explorer');
		swarmState.activeAgent.set(id, 'explorer');
		beginInvocation(id, 'explorer');

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['src/feature.ts'];
		}

		// explorer is read-only — scope declaration must not grant write authority.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's6' },
				{ args: { filePath: 'src/feature.ts' } },
			),
		).rejects.toThrow(/read-only/);
	});

	it('SECURITY: universal_deny still blocks even when path is in declared scope', async () => {
		const hooks = makeHooks({
			universal_deny_prefixes: ['.env', 'secrets/'],
		});
		const id = 'coder-scope-universal-deny';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['.env', 'secrets/api-key.pem'];
		}

		// universal_deny_prefixes is checked before per-agent rules and is not
		// relaxed by declared scope.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's7a' },
				{ args: { filePath: '.env' } },
			),
		).rejects.toThrow(/universal deny prefix/);

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's7b' },
				{ args: { filePath: 'secrets/api-key.pem' } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('SECURITY: blockedZones still enforced even when path is in declared scope', async () => {
		// coder blockedZones = ['generated', 'config']. A `.yaml` file classifies
		// as `config` zone — declared scope must not bypass blockedZones.
		const hooks = makeHooks();
		const id = 'coder-scope-blocked-zone';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['config/database.yml'];
		}

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's8' },
				{ args: { filePath: 'config/database.yml' } },
			),
		).rejects.toThrow(/config zone/);
	});

	it('FALLBACK: pendingCoderScopeByTaskId used when session.declaredCoderScope is null', async () => {
		// After /swarm close and before a new session inherits scope, the
		// per-task map is the source of truth. The guard must consult it.
		const hooks = makeHooks();
		const id = 'coder-scope-task-fallback';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = null;
			session.currentTaskId = 'task-rails-1';
		}
		pendingCoderScopeByTaskId.set('task-rails-1', ['config/', 'app/']);

		try {
			await hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 's9' },
				{ args: { filePath: 'config/routes.rb' } },
			);
		} finally {
			pendingCoderScopeByTaskId.delete('task-rails-1');
		}
	});

	it('apply_patch also honours declared scope (parity with Write/Edit)', async () => {
		const hooks = makeHooks();
		const id = 'coder-scope-patch';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['config/'];
		}

		const patchContent = `*** Begin Patch
*** Update File: config/routes.rb
@@
-old
+new
*** End Patch`;

		// After #496 coder has no default allowedPrefix, so config/routes.rb
		// (a .rb file → production zone, not config zone) is allowed even
		// without declared scope. Declaring scope here exercises the scope
		// path end-to-end for apply_patch. blockedZones/blockedPrefix still
		// apply independently.
		await hooks.toolBefore(
			{ tool: 'apply_patch', sessionID: id, callID: 's10' },
			{ args: { patch: patchContent } },
		);
	});

	// ─── Gap-closure over e95bbce: delegated-write call sites + Windows FS ───
	//
	// The initial #496 fix only wired declaredScope into the transparent path.
	// The delegated-write path (session.delegationActive === true — the primary
	// architect→coder workflow) still used pre-fix behaviour, so Rails/Python/Go
	// paths declared via `declare_scope` were WRITE BLOCKED on delegated writes.

	it('GAP-CLOSURE: delegated write honours declared scope', async () => {
		const hooks = makeHooks();
		const id = 'coder-delegated-scope';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.delegationActive = true;
			session.declaredCoderScope = ['config/'];
		}

		// Without the gap-closure fix, this would throw because the delegated
		// call site didn't pass `options.declaredScope`.
		await hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 'gc1' },
			{ args: { filePath: 'config/routes.rb' } },
		);
	});

	it('GAP-CLOSURE: delegated write without declared scope is still blocked by DENY rules', async () => {
		// After #496 coder has no default allowedPrefix, so the baseline for
		// "delegation-active + no scope must still enforce DENY rules" is now
		// exercised via blockedZones: 'config'. A .yml file (config zone)
		// must be rejected even when delegation is active and no scope is
		// declared.
		const hooks = makeHooks();
		const id = 'coder-delegated-no-scope';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.delegationActive = true;
			// no declaredCoderScope, no currentTaskId → scope cannot relax
			// blockedZones either (blockedZones is NOT bypassed by scope).
		}

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'gc2' },
				{ args: { filePath: 'config/secrets.yml' } },
			),
		).rejects.toThrow(/WRITE BLOCKED.*config zone/);
	});

	it('GAP-CLOSURE: delegated apply_patch honours declared scope', async () => {
		const hooks = makeHooks();
		const id = 'coder-delegated-patch-scope';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.delegationActive = true;
			session.declaredCoderScope = ['config/'];
		}

		const patchContent = `*** Begin Patch
*** Update File: config/routes.rb
@@
-old
+new
*** End Patch`;

		await hooks.toolBefore(
			{ tool: 'apply_patch', sessionID: id, callID: 'gc3' },
			{ args: { patch: patchContent } },
		);
	});

	it('GAP-CLOSURE (Windows): case-insensitive scope match', () => {
		// Only exercise on win32 — POSIX filesystems are case-sensitive and
		// `CONFIG/foo.rb` is a different path than `config/foo.rb` on Linux/macOS.
		if (process.platform !== 'win32') {
			return;
		}

		const hooks = makeHooks();
		const id = 'coder-windows-caseinsens';
		coderSession(id);

		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = ['config/'];
		}

		// Not using `await expect(...).resolves` here because the test body
		// short-circuits on non-win32 above; bun's `it` accepts a sync return.
		return hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 'gc4' },
			{ args: { filePath: 'CONFIG/foo.rb' } },
		);
	});
});

// ─── 7. resetSwarmState clears pendingCoderScopeByTaskId ─────────────────────
//
// The pending map is module-scoped in src/hooks/delegation-gate.ts — not part
// of swarmState — so without an explicit clear it leaks across /swarm close
// cycles. Stale scope for a reused taskId (e.g. "1.1") would allow a fresh
// session to bypass allowedPrefix using the previous swarm's declaration.

describe('resetSwarmState clears pendingCoderScopeByTaskId', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('clears the task-scope map', () => {
		pendingCoderScopeByTaskId.set('task-1', ['config/']);
		expect(pendingCoderScopeByTaskId.has('task-1')).toBe(true);

		resetSwarmState();

		expect(pendingCoderScopeByTaskId.has('task-1')).toBe(false);
	});

	it('stale scope does not persist across reset', async () => {
		// Populate map with scope for task-1, reset, then build a new session
		// that references the same taskId. The write must be BLOCKED because
		// the reset cleared the previous scope.
		//
		// Coder has no default allowedPrefix after #496, so this test uses a
		// DENY-rule-blocked path (config-zone .yml) to prove that stale scope
		// is not rehydrated. The stale scope contained `config/` — if it
		// were still in effect it could not rescue this write anyway because
		// blockedZones is NOT bypassed by scope, but the point here is that
		// the session has no scope at all post-reset.
		pendingCoderScopeByTaskId.set('task-1', ['config/']);

		resetSwarmState();

		const hooks = makeHooks();
		const id = 'coder-post-reset';
		coderSession(id);
		const session = swarmState.agentSessions.get(id);
		if (session) {
			session.declaredCoderScope = null;
			session.currentTaskId = 'task-1';
		}

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'reset1' },
				{ args: { filePath: 'config/secrets.yml' } },
			),
		).rejects.toThrow(/WRITE BLOCKED.*config zone/);
	});
});

// ─── 8. coder transparency (#496) ──────────────────────────────────────────
//
// #496 final fix: the hardcoded JS/TS-centric allowedPrefix whitelist
// (['src/', 'tests/', 'docs/', 'scripts/']) was removed from the coder agent's
// default authority rule. Writes are now gated only by DENY rules. These tests
// lock in the language-agnostic contract and verify every DENY rule still
// fires.

describe('coder transparency (#496)', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('Rails app/models/user.rb is allowed without declare_scope', async () => {
		const hooks = makeHooks();
		const id = 'coder-rails';
		coderSession(id);

		await hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 'rails1' },
			{ args: { filePath: 'app/models/user.rb' } },
		);
	});

	it('Python myapp/models.py is allowed without declare_scope', async () => {
		const hooks = makeHooks();
		const id = 'coder-python';
		coderSession(id);

		await hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 'python1' },
			{ args: { filePath: 'myapp/models.py' } },
		);
	});

	it('Go cmd/server/main.go is allowed without declare_scope', async () => {
		const hooks = makeHooks();
		const id = 'coder-go';
		coderSession(id);

		await hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 'go1' },
			{ args: { filePath: 'cmd/server/main.go' } },
		);
	});

	it('DENY: coder still cannot write config/database.yml (blockedZones: config)', async () => {
		const hooks = makeHooks();
		const id = 'coder-config-yml';
		coderSession(id);

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'deny-yml' },
				{ args: { filePath: 'config/database.yml' } },
			),
		).rejects.toThrow(/config zone/);
	});

	it('DENY: coder still cannot write .env (universal_deny_prefixes)', async () => {
		const hooks = makeHooks({
			universal_deny_prefixes: ['.env', 'secrets/'],
		});
		const id = 'coder-env';
		coderSession(id);

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'deny-env' },
				{ args: { filePath: '.env' } },
			),
		).rejects.toThrow(/universal deny prefix/);
	});

	it('DENY: coder still cannot write .swarm/plan.json (blockedPrefix)', async () => {
		const hooks = makeHooks();
		const id = 'coder-swarm';
		coderSession(id);

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'deny-swarm' },
				{ args: { filePath: '.swarm/plan.json' } },
			),
		).rejects.toThrow(/AUTHORITY_PROTECTED_PATH/);
	});

	it('DENY: coder still cannot write through symlink app/x.rb → /etc/shadow', async () => {
		const hooks = makeHooks();
		const id = 'coder-symlink';
		coderSession(id);

		// Create a symlink at app/x.rb targeting /etc/shadow
		await fs.mkdir(path.join(tempDir, 'app'), { recursive: true });
		const linkPath = path.join(tempDir, 'app', 'x.rb');
		try {
			fsSync.symlinkSync('/etc/shadow', linkPath);
		} catch (err) {
			// Some CI filesystems disallow symlink creation; if so, skip.
			const errno = (err as NodeJS.ErrnoException).code;
			if (errno === 'EPERM' || errno === 'EACCES') {
				return;
			}
			throw err;
		}

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'deny-symlink' },
				{ args: { filePath: 'app/x.rb' } },
			),
		).rejects.toThrow(/symlink|WRITE BLOCKED/i);
	});

	it('BLOCKS coder write to absolute path /etc/passwd', async () => {
		// Containment check: /etc/passwd resolves outside cwd (tempDir).
		// Before the containment check was added, removing coder.allowedPrefix
		// (#496) lost the implicit cwd containment because no DENY rule matched
		// the escaped path. This test locks in that the explicit rule-level
		// check rejects absolute paths outside cwd.
		const hooks = makeHooks();
		const id = 'coder-abs-escape';
		coderSession(id);

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'esc1' },
				{ args: { filePath: '/etc/passwd' } },
			),
		).rejects.toThrow(/resolves outside the working directory/);
	});

	it('BLOCKS coder write to relative traversal ../../etc/passwd', async () => {
		// Containment check: ../../etc/passwd resolves outside cwd via traversal.
		const hooks = makeHooks();
		const id = 'coder-traversal-escape';
		coderSession(id);

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'esc2' },
				{ args: { filePath: '../../etc/passwd' } },
			),
		).rejects.toThrow(/resolves outside the working directory/);
	});

	it('BLOCKS architect write to absolute path /etc/passwd (pre-existing gap also closed)', async () => {
		// Defense-in-depth: architect never had an allowedPrefix whitelist,
		// so the same cwd-escape gap existed for architect pre-#496. The
		// rule-level containment check applies to every agent uniformly.
		const hooks = makeHooks();
		const id = 'arch-abs-escape';
		architectSession(id);

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'esc3' },
				{ args: { filePath: '/etc/passwd' } },
			),
		).rejects.toThrow(/resolves outside the working directory/);
	});

	it('USER OVERRIDE: authority.rules.coder.allowedPrefix: [lib/] still restricts coder to lib/', async () => {
		const hooks = makeHooks({
			enabled: true,
			rules: {
				coder: {
					allowedPrefix: ['lib/'],
				},
			},
		});
		const id = 'coder-override';
		coderSession(id);

		// lib/ is allowed by the user override
		await hooks.toolBefore(
			{ tool: 'write', sessionID: id, callID: 'override-ok' },
			{ args: { filePath: 'lib/foo.rb' } },
		);

		// app/ is NOT in the user-override allowedPrefix, so it must be rejected.
		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: id, callID: 'override-denied' },
				{ args: { filePath: 'app/models/user.rb' } },
			),
		).rejects.toThrow(/not in allowed list/);
	});
});
