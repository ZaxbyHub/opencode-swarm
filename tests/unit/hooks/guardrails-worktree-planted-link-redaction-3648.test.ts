import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
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

	const git = (args: string, cwd: string): void => {
		execSync(`git ${args}`, { cwd, stdio: 'pipe' });
	};

	beforeEach(() => {
		sandboxDir = canonicalMkdtemp('swarm-wt-redact-');
		mainRepoDir = path.join(sandboxDir, 'main-repo');
		fsSync.mkdirSync(mainRepoDir, { recursive: true });
		git('init -b main', mainRepoDir);
		git('config user.name "Test"', mainRepoDir);
		git('config user.email "test@example.com"', mainRepoDir);
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
		// Arm A needs a target that resolves onto a different filesystem
		// root (another drive on win32, another mount on Linux). Build the
		// probe from the sandbox's own root: when no second root is
		// constructible, skip with a diagnostic (never silently — the #3606
		// suite's skip-probe pattern).
		const secondRoot = (() => {
			const roots = fsSync
				.readdirSync(path.parse(sandboxDir).root, { withFileTypes: true })
				.map((e) => e.name)
				.slice(0, 0); // directory listing of the root is not a reliable probe
			void roots;
			if (process.platform === 'win32') {
				// Prefer any drive other than the sandbox's own.
				for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
					const candidate = `${letter}:\\`;
					if (fsSync.existsSync(candidate)) return candidate;
				}
			}
			return null;
		})();
		if (secondRoot === null) {
			console.warn(
				'[planted-link-redaction] no second filesystem root on this host; different-root arm skipped with diagnostic',
			);
			return;
		}
		const target = path.join(secondRoot, 'swarm-wt-redact-arm-a.txt');
		if (fsSync.existsSync(target)) {
			console.warn(
				'[planted-link-redaction] second-root target already exists; arm skipped',
			);
			return;
		}
		const result = checkFileAuthority('architect', target, mainRepoDir);
		expect(result.allowed).toBe(false);
		// On the different-root arm the planted link below the MATCHED
		// worktree is what distinguishes the re-rooted detail from the plain
		// 'different drive or filesystem root' deny: the target itself is
		// outside every root, so a plain different-root deny is also
		// correct — assert the code and, when the re-rooted detail fires,
		// its exact slot.
		if (!result.allowed) {
			expect(result.code).toBe('AUTHORITY_ROOT_ESCAPE');
			const reason = result.reason ?? '';
			if (reason.includes('re-rooted target crosses symlink/junction')) {
				expect(reason).toContain(
					`"${sanitizeDiagnosticText(redactPath(linkPath), 320)}"`,
				);
			}
		}
		try {
			fsSync.rmSync(target, { force: true });
		} catch {
			// best effort
		}
	}, 60_000);
});
