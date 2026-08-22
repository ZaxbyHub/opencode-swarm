/**
 * Host-independent on-disk fixtures for the `src/utils/git-executable.ts`
 * resolver tests (issue #2236).
 *
 * WHY THIS EXISTS. The resolver derives PATH and ProgramFiles candidates with
 * the SIMULATED platform's separator (`joinDirAndName` /
 * `windowsPlatformCandidates`), while node's `path.join` uses the HOST's. A
 * fixture built with `path.join` is therefore a DIFFERENT STRING from the
 * candidate the resolver generates on any host whose separator differs: it
 * fails the `fs.statSync` pre-check inside `probeCandidate`, the whole
 * candidate list is rejected, and resolution degrades to the bare `'git'`.
 * That is exactly how six tests in git-executable-override.test.ts passed on
 * Windows and failed on both ubuntu-latest and macos-latest. Override
 * candidates are exempt from the mismatch — `buildCandidates` uses an override
 * VERBATIM, never joining it — which is why the sibling git-executable.test.ts
 * (whose fs fixtures are all overrides) stayed green on POSIX CI.
 *
 * WHY `win32` IS THE SIMULATED PLATFORM. It is the only one that supports
 * on-disk fixtures on BOTH hosts: a win32-shaped path is
 * `path.win32.isAbsolute()` on POSIX too (a leading `/` is a win32 root), and
 * a `\`-joined tail materializes on POSIX as a literal filename. The reverse
 * is impossible — `path.posix.isAbsolute('C:\\…')` is false, so a linux
 * simulation rejects a Windows tmpdir fixture as "not an absolute path" before
 * it ever stats. Linux-side shaping is pinned by filesystem-free guard tests
 * instead (see git-executable-override.test.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The platform these fixtures — and the tests that use them — simulate. */
export const SIM_PLATFORM = 'win32' as const;
export const SIM_SEP: string = SIM_PLATFORM === 'win32' ? '\\' : '/';
export const SIM_GIT_NAME: string =
	SIM_PLATFORM === 'win32' ? 'git.exe' : 'git';

/** Mirror of `joinDirAndName` in src/utils/git-executable.ts. */
export function simJoin(
	dir: string,
	platform: NodeJS.Platform,
	...segments: string[]
): string {
	const sep = platform === 'win32' ? '\\' : '/';
	return segments.reduce(
		(acc, segment) => `${acc.replace(/[\\/]+$/, '')}${sep}${segment}`,
		dir,
	);
}

let fixtureSeq = 0;

/**
 * Creates a real file at EXACTLY the string the resolver will generate for
 * `<dir>` + `segments` under `SIM_PLATFORM`, and returns both the directory
 * (to hand to `PATH` / `ProgramFiles`) and that candidate string.
 *
 * Every fixture that must EXIST on disk should go through here, including the
 * ones used as verbatim overrides, so there is one host-independent
 * construction path and the guards below cover all of them. Deliberately
 * absent paths are exempt — nothing is derived from them.
 *
 * Throws rather than returning a mis-shaped path: a fixture that cannot be
 * reached by the resolver must fail HERE with a self-explaining message, not
 * forty lines later as an opaque `Received: "git"`.
 */
export function writeSimFixture(
	tmpDir: string,
	label: string,
	...segments: string[]
): { dir: string; candidate: string } {
	const dir = path.join(tmpDir, `${label}-${fixtureSeq++}`);
	const tail = segments.length > 0 ? segments : [SIM_GIT_NAME];
	const candidate = simJoin(dir, SIM_PLATFORM, ...tail);

	const expectedTail = tail.map((segment) => SIM_SEP + segment).join('');
	if (candidate.slice(dir.length) !== expectedTail) {
		throw new Error(
			`fixture is not ${SIM_PLATFORM}-shaped: ${JSON.stringify(candidate)} does not end with ${JSON.stringify(expectedTail)}`,
		);
	}
	const isAbsoluteForSim =
		SIM_PLATFORM === 'win32'
			? path.win32.isAbsolute(candidate)
			: path.posix.isAbsolute(candidate);
	if (!isAbsoluteForSim) {
		throw new Error(
			`fixture ${JSON.stringify(candidate)} is not absolute for the simulated platform ${SIM_PLATFORM}; probeCandidate would reject it before stat`,
		);
	}

	// On POSIX the `\`-joined tail is a literal filename, so the HOST parent of
	// a win32-shaped candidate can be `tmpDir` itself. Assert containment so a
	// future caller cannot litter the shared system temp root on CI.
	const hostParent = path.dirname(candidate);
	if (!hostParent.startsWith(tmpDir)) {
		throw new Error(
			`fixture would be written outside the test tmpdir: ${JSON.stringify(hostParent)} is not under ${JSON.stringify(tmpDir)}`,
		);
	}

	fs.mkdirSync(hostParent, { recursive: true });
	fs.writeFileSync(candidate, 'stub');
	// `probeCandidate` stats this exact string before spawning; if the host
	// cannot reach it, every candidate is rejected and resolution silently
	// degrades to the bare name.
	if (!fs.existsSync(candidate)) {
		throw new Error(
			`fixture ${JSON.stringify(candidate)} is not reachable on this host after being written`,
		);
	}
	return { dir, candidate };
}
