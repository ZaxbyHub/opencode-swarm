/**
 * Issue #2679 — `resolveProjectRootDecision` resolver semantics.
 *
 * The decision resolver is the non-throwing twin of `assertProjectRoot`: the
 * bootstrap path (src/index.ts) consumes it once per boot to pick the root
 * that owns ALL project-surface state. These unit tests pin the fixture-level
 * matrix the frozen acceptance checks exercise end-to-end (C1/C3/C4/C8 in
 * .agents/issue-traces/2679-project-root-ownership-bootstrap/repro/):
 *
 *  - `.git` file/dir and `.opencode` dir are local boundary markers → root.
 *  - an ordinary child of an ancestor owning `.swarm/` + a project indicator
 *    → redirect to that ancestor (owningRoot).
 *  - an indicator WITHOUT `.swarm/` must NOT capture an ordinary child.
 *  - unresolvable ownership (missing dir, >MAX_PROJECT_ROOT_DEPTH claiming
 *    ancestor) → fail-closed with a bounded reason.
 *
 * Real filesystem fixtures only — no mock.module, no clock usage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	assertProjectRoot,
	MAX_PROJECT_ROOT_DEPTH,
	resolveProjectRootDecision,
} from '../../../src/utils/project-boundary';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let root: string;

beforeEach(() => {
	root = canonicalMkdtemp('project-boundary-resolver-2679-');
});

afterEach(() => {
	safeRmRecursive(root);
});

describe('resolveProjectRootDecision — marker roots (#2679)', () => {
	it('returns root for a directory with a .git directory', () => {
		const project = path.join(root, 'git-dir-root');
		fs.mkdirSync(path.join(project, '.git'), { recursive: true });

		const decision = resolveProjectRootDecision(project);
		expect(decision.kind).toBe('root');
		if (decision.kind !== 'root') return;
		expect(decision.directory).toBe(fs.realpathSync(project));
	});

	it('returns root for a directory with a .git FILE (gitdir: worktree pointer)', () => {
		const project = path.join(root, 'git-file-root');
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, '.git'), 'gitdir: ../git-data\n');

		const decision = resolveProjectRootDecision(project);
		expect(decision.kind).toBe('root');
		if (decision.kind !== 'root') return;
		expect(decision.directory).toBe(fs.realpathSync(project));
	});

	it('returns root for a directory with an .opencode directory', () => {
		const project = path.join(root, 'opencode-root');
		fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });

		const decision = resolveProjectRootDecision(project);
		expect(decision.kind).toBe('root');
		if (decision.kind !== 'root') return;
		expect(decision.directory).toBe(fs.realpathSync(project));
	});
});

describe('resolveProjectRootDecision — redirect and independence (#2679)', () => {
	it('redirects an ordinary child of a parent owning .git + .swarm to the parent', () => {
		const parent = path.join(root, 'outer');
		const child = path.join(parent, 'child');
		fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
		fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
		fs.mkdirSync(child, { recursive: true });

		const decision = resolveProjectRootDecision(child);
		expect(decision.kind).toBe('redirect');
		if (decision.kind !== 'redirect') return;
		// The decision names BOTH the canonicalized input and the owning root.
		expect(decision.directory).toBe(fs.realpathSync(child));
		expect(decision.owningRoot).toBe(fs.realpathSync(parent));
	});

	it('returns root (standalone) for a plain directory with package.json and no ancestor .swarm', () => {
		const standalone = path.join(root, 'standalone');
		fs.mkdirSync(standalone, { recursive: true });
		fs.writeFileSync(
			path.join(standalone, 'package.json'),
			JSON.stringify({ name: 'standalone-2679', version: '0.0.0' }),
		);

		const decision = resolveProjectRootDecision(standalone);
		expect(decision.kind).toBe('root');
		if (decision.kind !== 'root') return;
		expect(decision.directory).toBe(fs.realpathSync(standalone));
	});

	it('does NOT capture an ordinary child of an indicator-only parent (no .swarm)', () => {
		// C8 semantics: .git + package.json WITHOUT .swarm must not redirect —
		// an indicator alone never claims ownership of swarm state.
		const parent = path.join(root, 'indicator-only');
		const child = path.join(parent, 'child');
		fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(parent, 'package.json'),
			JSON.stringify({ name: 'indicator-only-2679', version: '0.0.0' }),
		);
		fs.mkdirSync(child, { recursive: true });

		const decision = resolveProjectRootDecision(child);
		expect(decision.kind).toBe('root');
		if (decision.kind !== 'root') return;
		expect(decision.directory).toBe(fs.realpathSync(child));
	});
});

describe('resolveProjectRootDecision — fail-closed outcomes (#2679)', () => {
	it('fails closed for a nonexistent directory input', () => {
		const decision = resolveProjectRootDecision(
			path.join(root, 'does-not-exist'),
		);
		expect(decision.kind).toBe('fail-closed');
		if (decision.kind !== 'fail-closed') return;
		expect(decision.reason).toContain('cannot canonicalize');
	});

	it('fails closed when the claiming ancestor is deeper than MAX_PROJECT_ROOT_DEPTH', () => {
		// Depth counts upward from the resolved directory, so exceeding 20
		// levels requires the CLAIMING ancestor (.git + .swarm) to sit more
		// than MAX_PROJECT_ROOT_DEPTH levels above the probed directory.
		const parent = path.join(root, 'deep-outer');
		fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
		fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
		let deepest = parent;
		for (let i = 0; i < MAX_PROJECT_ROOT_DEPTH + 5; i += 1) {
			deepest = path.join(deepest, `level-${i}`);
		}
		fs.mkdirSync(deepest, { recursive: true });

		const decision = resolveProjectRootDecision(deepest);
		expect(decision.kind).toBe('fail-closed');
		if (decision.kind !== 'fail-closed') return;
		expect(decision.reason).toContain('exceeded');
		expect(decision.reason).toContain(String(MAX_PROJECT_ROOT_DEPTH));
	});

	// Weak-container behavior (a .swarm directly under the OS temp/hometree
	// strips .opencode-only indicators) is intentionally NOT covered here:
	// probing it requires placing a .swarm + .opencode in the REAL
	// real OS temp/hometree root, which this suite must never pollute. The
	// tmpdir-weak-container branch stays covered by implementation review,
	// not by a real-root fixture.
});

describe('assertProjectRoot — legacy throw contract preserved (#2679)', () => {
	it('still throws the exact redirect message for an ordinary child of a claiming parent', () => {
		const parent = path.join(root, 'legacy-outer');
		const child = path.join(parent, 'child');
		fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
		fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
		fs.mkdirSync(child, { recursive: true });

		const resolved = fs.realpathSync(child);
		const canonicalParent = fs.realpathSync(parent);
		expect(() => assertProjectRoot(child)).toThrow(
			`Cannot write runtime state in "${resolved}" — parent directory "${canonicalParent}" already contains a .swarm/ folder. Runtime state must be written to the project root.`,
		);
	});
});
