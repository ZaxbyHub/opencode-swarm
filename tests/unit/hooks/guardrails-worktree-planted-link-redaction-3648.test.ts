import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import {
	checkFileAuthority,
	clearGuardrailsCaches,
} from '../../../src/hooks/guardrails/file-authority.js';
import {
	redactPath,
	sanitizeDiagnosticText,
} from '../../../src/scope/path-identity.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * #3648 AC15 / #3652 closeout addition (D8): the planted-link redaction in
 * file-authority's RE-ROOTED arms (`re-rooted target crosses symlink/junction
 * "<redacted>" inside the matched worktree`, from de9d15706) shipped without
 * a test pin — a regression would silently reintroduce raw planted-link
 * paths into AUTHORITY_ROOT_ESCAPE details. This suite drives the re-rooted
 * arms through a REAL planted link whose target does not exist (the lexical
 * chain survives tail-tolerant canonicalization; an existing-target junction
 * resolves away and falls to the plain outside-deny, which is why the
 * sibling containment-hardening suite never saw this detail) and asserts the
 * EXACT redacted slot form, with a negative raw-path assertion where
 * redactPath actually transforms the path (home/profile prefixes only —
 * path-identity.ts:149-216; a /tmp fixture on Linux legitimately keeps the
 * raw spelling, so the negative assertion is gated by an applicability
 * probe, plan-critic round 4).
 */
describe('planted-link redaction in re-rooted authority denials (#3648 AC15)', () => {
	let sandboxDir: string;
	let mainRepoDir: string;
	let linkedDir: string;
	let linkPath: string;

	// FB-012 (#3689 review): the git helper had no timeout and left stdin
	// piped (a credential/gpg prompt could hang the shard — the same Windows
	// CI-hang class as #3691), and the fixture commit ran without disabling
	// signing/hooks (sibling precedent tests/gitignore-warning.test.ts
	// neutralizes both).
	const git = (args: string, cwd: string): void => {
		execSync(`git ${args}`, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 30_000,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: '0',
				GIT_CONFIG_NOSYSTEM: '1',
			},
		});
	};

	beforeEach(() => {
		sandboxDir = canonicalMkdtemp('swarm-wt-redact-');
		mainRepoDir = path.join(sandboxDir, 'main-repo');
		fsSync.mkdirSync(mainRepoDir, { recursive: true });
		git('init -b main', mainRepoDir);
		git('config user.name "Test"', mainRepoDir);
		git('config user.email "test@example.com"', mainRepoDir);
		// FB-012: neutralize ambient signing/hooking before the first commit
		// (a developer machine with commit.gpgsign=true or global hooks must
		// not hang or fail the fixture).
		git('config commit.gpgsign false', mainRepoDir);
		git('config core.hooksPath .git/no-op-hooks', mainRepoDir);
		git('commit --allow-empty -m "initial commit"', mainRepoDir);
		linkedDir = path.join(sandboxDir, 'linked');
		git(`worktree add "${linkedDir}" -b feat/linked`, mainRepoDir);
		// The planted link targets a NON-EXISTENT directory: the lexical
		// chain then survives tail-tolerant canonicalization on win32 (the
		// realpath stops at the junction) and POSIX alike, so the re-rooted
		// arm's findPlantedLinkBelow walk actually observes the link.
		const nonexistentTarget = path.join(sandboxDir, 'outside-not-there');
		linkPath = path.join(linkedDir, 'planted-link');
		fsSync.symlinkSync(
			nonexistentTarget,
			linkPath,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		clearGuardrailsCaches();
	});

	afterEach(() => {
		clearGuardrailsCaches();
		try {
			fsSync.rmSync(sandboxDir, { recursive: true, force: true });
		} catch {
			// EBUSY-tolerant best effort (Windows teardown flake).
		}
	});

	it('denies a write through the planted link with the EXACT redacted slot (escaping-relative arm)', () => {
		const result = checkFileAuthority(
			'architect',
			path.join(linkPath, 'new-file.txt'),
			mainRepoDir,
		);
		expect(result.allowed).toBe(false);
		if (result.allowed) return;
		expect(result.code).toBe('AUTHORITY_ROOT_ESCAPE');
		const reason = result.reason ?? '';
		const expectedSlot = sanitizeDiagnosticText(redactPath(linkPath), 320);
		expect(reason).toContain('re-rooted target crosses symlink/junction');
		// Exact-slot control: the rendered slot equals the composed
		// redaction of the real link path (raw preserved where redactPath
		// has nothing to redact IS the documented contract).
		expect(reason).toContain(`"${expectedSlot}"`);
		// Negative assertion (scoped): where redactPath TRANSFORMS the path
		// (home/profile prefix — path-identity.ts recognizes lexical
		// /home/<user>, /Users/<user>, and Windows profile shapes, NOT
		// os.homedir()), the raw spelling must NOT leak into the reason.
		const rawNormalized = path.normalize(linkPath);
		const transformed = expectedSlot !== rawNormalized;
		if (transformed) {
			expect(reason).not.toContain(rawNormalized);
			expect(expectedSlot.startsWith('~')).toBe(true);
		} else {
			// Applicability probe result recorded for the trace: this host's
			// fixture path is not redactPath-transformable (e.g. /tmp), so
			// the negative leg is vacuous here by documented contract.
			console.warn(
				'[planted-link-redaction] redactPath does not transform this fixture path; negative raw-absent assertion is vacuous by contract',
			);
		}
	}, 60_000);

	it('the planted-link detail rides the different-filesystem-root arm where a second root exists', () => {
		// FB-013 (#3689 review): the previous probe put a PLAIN file on the
		// second root — its target never matched a registered worktree, so
		// matchWorktreeRoot() returned null, the check took the plain
		// 'different drive or filesystem root' deny, and the conditional
		// re-rooted assertion never executed on ANY host (vacuous leg;
		// FB-022 also removed a dead roots probe left from that design).
		// The arm genuinely needs the LINKED WORKTREE ITSELF on the second
		// root (reviewer recipe): a registered linked worktree whose root
		// matches, with the target crossing a planted link below it, while
		// the target lands on a different filesystem root than `dir`.
		// When no second root is constructible (single-mount hosts), the
		// leg skips WITH a diagnostic — the PR body/fragment claim for this
		// arm is accordingly host-conditional, not "always pinned".
		const ownRoot = path.parse(sandboxDir).root;
		let secondWorktree: string | null = null;
		if (process.platform === 'win32') {
			for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
				const candidate = `${letter}:\\`;
				if (candidate === ownRoot || !fsSync.existsSync(candidate)) continue;
				const dir = `${letter}:\\swarm-wt-redact-linked-${process.pid}`;
				if (fsSync.existsSync(dir)) continue;
				try {
					git(`worktree add "${dir}" -b feat/linked-second-root`, mainRepoDir);
					secondWorktree = dir;
				} catch {
					// Drive not writable / registry refusal — skip with diagnostic.
					try {
						git(`worktree prune`, mainRepoDir);
					} catch {
						/* best effort */
					}
				}
				break;
			}
		}
		if (secondWorktree === null) {
			console.warn(
				'[planted-link-redaction] no second filesystem root worktree constructible on this host; different-root arm skipped with diagnostic',
			);
			return;
		}
		try {
			const planted = path.join(secondWorktree, 'planted-link');
			fsSync.symlinkSync(
				path.join(secondWorktree, 'outside-not-there'),
				planted,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			clearGuardrailsCaches();
			const target = path.join(planted, 'arm-a-new-file.txt');
			const result = checkFileAuthority('architect', target, mainRepoDir);
			expect(result.allowed).toBe(false);
			if (result.allowed) return;
			expect(result.code).toBe('AUTHORITY_ROOT_ESCAPE');
			const reason = result.reason ?? '';
			// Unconditional (no if-guard): when this arm executes at all it
			// MUST render the re-rooted planted-link detail with the exact
			// redacted slot — the whole point of the leg.
			expect(reason).toContain('re-rooted target crosses symlink/junction');
			expect(reason).toContain(
				`"${sanitizeDiagnosticText(redactPath(planted), 320)}"`,
			);
		} finally {
			// Cleanup is UNCONDITIONAL on both paths: `git worktree remove`
			// can leave the directory behind on Windows (busy junction from
			// the planted link), so the forced rm + prune always follow.
			try {
				git(`worktree remove --force "${secondWorktree}"`, mainRepoDir);
			} catch {
				// fall through to the forced cleanup
			}
			try {
				fsSync.rmSync(secondWorktree, { recursive: true, force: true });
				git('worktree prune', mainRepoDir);
			} catch {
				// best effort — residue is namespaced by pid.
			}
		}
	}, 60_000);
});
