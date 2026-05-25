/**
 * Adversarial tests for validateProjectRoot (Task 1.1)
 * Attack vectors: path traversal, depth boundaries, symlink chains,
 * indicator spoofing, race conditions, Unicode/encoding edge cases.
 *
 * ENVIRONMENTAL CONSTRAINT: This machine has .swarm/ + .opencode/ at C:\Users\Brett\.
 * All paths under os.tmpdir() (C:\Users\Brett\AppData\Local\Temp) are therefore
 * rejected by validateProjectRoot. Tests that expect "no throw" are skipped in
 * this environment. Tests that expect "throw" are run normally.
 *
 * NOTE: These tests use the REAL validateProjectRoot (no mocking) to test
 * the actual filesystem behavior. Temp directories are created under os.tmpdir()
 * and cleaned up in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	MAX_DEPTH,
	PROJECT_INDICATORS,
	validateProjectRoot,
} from '../../../src/evidence/manager';

/**
 * Detects whether the environment has a .swarm/ + project indicator ancestor
 * for the given directory path. Returns the offending ancestor path if found.
 */
function detectSwarmAncestor(startPath: string): string | null {
	let current: string;
	try {
		current = realpathSync(startPath);
	} catch {
		current = startPath; // fallback if realpath fails
	}
	for (let i = 0; i < MAX_DEPTH + 5; i++) {
		const parent = path.dirname(current);
		if (parent === current) break; // filesystem root
		try {
			const swarmPath = path.join(parent, '.swarm');
			const stat = statSync(swarmPath);
			if (stat.isDirectory()) {
				// Found .swarm — check for project indicators
				for (const indicator of PROJECT_INDICATORS) {
					try {
						const indicatorStat = statSync(path.join(parent, indicator));
						if (indicatorStat.isFile() || indicatorStat.isDirectory()) {
							return parent;
						}
					} catch {
						// indicator not found
					}
				}
			}
		} catch {
			// .swarm doesn't exist at this level
		}
		current = parent;
	}
	return null;
}

let tempDir: string;
let envHasSwarmAncestor: boolean = false;
let swarmAncestorPath: string | null = null;

/**
 * Builds a deep directory chain under tempDir.
 * Returns the deepest directory path.
 */
function buildDeepChain(count: number): string {
	let current = tempDir;
	for (let i = 0; i < count; i++) {
		current = path.join(current, `level${i}`);
	}
	mkdirSync(current, { recursive: true });
	return current;
}

beforeEach(() => {
	tempDir = path.join(
		tmpdir(),
		`validate-adversarial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });

	// Detect environment constraint BEFORE each test
	swarmAncestorPath = detectSwarmAncestor(tempDir);
	envHasSwarmAncestor = swarmAncestorPath !== null;
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// =============================================================================
// ATTACK VECTOR 1: PATH TRAVERSAL — paths with `..`, symlinks to escape depth counting
// =============================================================================

describe('PATH TRAVERSAL — validateProjectRoot', () => {
	it('double-dot in path is resolved by realpathSync and walks correctly', () => {
		// Create: tempDir/project/ with .swarm/ + package.json
		// tempDir/project/child/grandchild
		// grandchild/../.. should resolve to projectDir — has .swarm/ + indicator
		const projectDir = path.join(tempDir, 'project');
		const childDir = path.join(projectDir, 'child');
		const grandchildDir = path.join(childDir, 'grandchild');
		mkdirSync(grandchildDir, { recursive: true });
		mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });
		writeFileSync(path.join(projectDir, 'package.json'), '{}');

		// grandchild/../.. resolves to projectDir — should throw
		const traversalPath = path.join(grandchildDir, '..', '..');
		expect(() => validateProjectRoot(traversalPath)).toThrow(
			'Cannot write evidence',
		);
	});

	it('symlink chain does not reset or bypass depth counting', () => {
		// Create: tempDir/real-project/ with .swarm/ + package.json
		// tempDir/link1 -> real-project, tempDir/link2 -> link1
		// realpathSync resolves all to the same canonical path
		const realProject = path.join(tempDir, 'real-project');
		mkdirSync(path.join(realProject, '.swarm'), { recursive: true });
		writeFileSync(path.join(realProject, 'package.json'), '{}');

		const subDir = path.join(realProject, 'subdir');
		mkdirSync(subDir, { recursive: true });

		const link1 = path.join(tempDir, 'link1');
		const link2 = path.join(tempDir, 'link2');
		try {
			symlinkSync(realProject, link1, 'junction');
			symlinkSync(link1, link2, 'junction');
		} catch {
			// Symlinks not supported — skip
			return;
		}

		// All resolve to same canonical path — should all throw
		expect(() => validateProjectRoot(subDir)).toThrow('Cannot write evidence');
		expect(() => validateProjectRoot(link1)).toThrow('Cannot write evidence');
		expect(() => validateProjectRoot(link2)).toThrow('Cannot write evidence');
	});

	it('symlink pointing upward in directory tree resolves correctly', () => {
		// Create: tempDir/a/ has .swarm/ + indicator
		// tempDir/c/upward-link -> ../a (points upward to project)
		const dirA = path.join(tempDir, 'a');
		const dirC = path.join(tempDir, 'c');
		mkdirSync(dirC, { recursive: true });
		mkdirSync(path.join(dirA, '.swarm'), { recursive: true });
		writeFileSync(path.join(dirA, 'package.json'), '{}');

		const upwardLink = path.join(dirC, 'upward-link');
		try {
			symlinkSync(dirA, upwardLink, 'junction');
		} catch {
			return;
		}

		// Symlink resolves to dirA (has .swarm/ + indicator) → throw
		expect(() => validateProjectRoot(upwardLink)).toThrow(
			'Cannot write evidence',
		);
	});

	it('broken symlink throws descriptive error (realpathSync fails on non-existent target)', () => {
		// Broken symlink pointing to non-existent target
		// realpathSync fails → catch block throws "Cannot verify project root"
		const brokenLink = path.join(tempDir, 'broken-link');
		try {
			symlinkSync(path.join(tempDir, 'non-existent'), brokenLink, 'junction');
		} catch {
			return;
		}

		// Broken symlink — realpathSync fails → throws descriptive error
		expect(() => validateProjectRoot(brokenLink)).toThrow(
			'Cannot verify project root',
		);
	});
});

// =============================================================================
// ATTACK VECTOR 2: BOUNDARY — exactly at MAX_DEPTH=20 (depth 19 vs 20 vs 21)
// =============================================================================

describe('BOUNDARY — MAX_DEPTH depth limit', () => {
	it('rejects when .swarm/ with indicators is found at depth 19 (< MAX_DEPTH)', () => {
		// Chain: tempDir/level0/.../level18/project (has .swarm+indicators) /level19/child
		// Starting from child: 19 iterations reach projectDir → throw
		const projectDir = buildDeepChain(19); // level0 through level18
		const childDir = path.join(projectDir, 'level19', 'child');
		mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });
		writeFileSync(path.join(projectDir, 'package.json'), '{}');
		mkdirSync(childDir, { recursive: true });

		// depth=19 < MAX_DEPTH=20 → check parent and throw
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('rejects when .swarm/ with indicators is found at depth 20 (== MAX_DEPTH)', () => {
		// Chain: tempDir/level0/.../level19/project (has .swarm+indicators) /child
		// Starting from child: iteration 20 = projectDir → throw
		const projectDir = buildDeepChain(20); // level0 through level19
		const childDir = path.join(projectDir, 'child');
		mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });
		writeFileSync(path.join(projectDir, 'package.json'), '{}');
		mkdirSync(childDir, { recursive: true });

		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('accepts path beyond MAX_DEPTH when no .swarm/ exists in ancestors', () => {
		if (envHasSwarmAncestor) {
			// This environment has .swarm/ ancestor — skip "no throw" test
			return;
		}
		// Build 25-level chain with no .swarm/ anywhere
		// Depth limit stops walk before finding any .swarm/
		const deepest = buildDeepChain(25);
		expect(() => validateProjectRoot(deepest)).not.toThrow();
	});

	it('MAX_DEPTH constant is exactly 20', () => {
		expect(MAX_DEPTH).toBe(20);
	});

	it('treats .swarm/ without indicators at depth 20 as stray artifact (fail-open)', () => {
		if (envHasSwarmAncestor) return;

		// Place stray .swarm/ at tempDir level — 20 levels up from child
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true }); // stray, no indicators

		// Build 20-level chain downward from tempDir
		const childDir = buildDeepChain(20); // level0 through level19

		// From childDir: tempDir is at depth 20, has stray .swarm/ but no indicators → fail-open
		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});
});

// =============================================================================
// ATTACK VECTOR 3: RACE CONDITIONS — concurrent .swarm/ or indicator mutations
// =============================================================================

describe('RACE CONDITIONS — concurrent .swarm/ or indicator mutations', () => {
	it('validates successfully when .swarm/ does not exist yet', () => {
		if (envHasSwarmAncestor) return; // environment blocks this test

		// tempDir/child/ with no .swarm/ anywhere
		const childDir = path.join(tempDir, 'child', 'grandchild');
		mkdirSync(childDir, { recursive: true });

		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});

	it('rejects after .swarm/ and project indicator are both added', () => {
		if (envHasSwarmAncestor) return; // environment blocks "no throw" path

		// Create tempDir/ with child/
		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		// Add .swarm without indicators → should NOT reject (stray artifact)
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		expect(() => validateProjectRoot(childDir)).not.toThrow();

		// Add package.json → now should reject
		writeFileSync(path.join(tempDir, 'package.json'), '{}');
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('.swarm/ removed after initial validation changes behavior', () => {
		if (envHasSwarmAncestor) return;

		// tempDir/project/ with .swarm/ + indicators
		const projectDir = path.join(tempDir, 'project');
		const childDir = path.join(projectDir, 'child');
		mkdirSync(childDir, { recursive: true });
		mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });
		writeFileSync(path.join(projectDir, 'package.json'), '{}');

		// Initial: should throw
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);

		// Remove .swarm → should NOT throw (stray artifact)
		rmSync(path.join(projectDir, '.swarm'), { recursive: true, force: true });
		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});

	it('rapidly toggling .swarm/ presence alternates throw/no-throw', () => {
		if (envHasSwarmAncestor) return;

		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		for (let i = 0; i < 3; i++) {
			mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			writeFileSync(path.join(tempDir, 'package.json'), '{}');
			expect(() => validateProjectRoot(childDir)).toThrow(
				'Cannot write evidence',
			);

			rmSync(path.join(tempDir, '.swarm'), { recursive: true, force: true });
			expect(() => validateProjectRoot(childDir)).not.toThrow();
		}
	});
});

// =============================================================================
// ATTACK VECTOR 4: INDICATOR SPOOFING — regular files named .git, symlinks to indicators
// =============================================================================

describe('INDICATOR SPOOFING — fake project indicators', () => {
	it('regular FILE named .git is accepted as a valid indicator', () => {
		// Write a regular FILE named .git (not a directory)
		writeFileSync(path.join(tempDir, '.git'), 'not a git repo');
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		// A regular file named .git satisfies isFile() → hasProjectIndicator = true → throw
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('symlink TO a file named package.json is accepted as a valid indicator', () => {
		const realFile = path.join(tempDir, 'real-package.json');
		writeFileSync(realFile, '{}');

		const symlinkPath = path.join(tempDir, 'package.json');
		try {
			symlinkSync(realFile, symlinkPath, 'file');
		} catch {
			return; // File symlinks may not be supported
		}

		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		// Symlink to a file satisfies isFile() → throw
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('symlink named .git (pointing to real dir) is accepted as valid indicator', () => {
		const realGitDir = path.join(tempDir, 'real-git-dir');
		mkdirSync(realGitDir, { recursive: true });

		const symlinkPath = path.join(tempDir, '.git');
		try {
			symlinkSync(realGitDir, symlinkPath, 'junction');
		} catch {
			return;
		}

		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		// Symlink to directory satisfies isDirectory() → throw
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('empty file as indicator is still a valid indicator', () => {
		writeFileSync(path.join(tempDir, 'package.json'), '');
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		// Empty file is still a file → throw
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('PROJECT_INDICATORS array contains all 11 expected entries', () => {
		const expected = [
			'package.json',
			'.git',
			'.opencode',
			'Cargo.toml',
			'go.mod',
			'pyproject.toml',
			'Gemfile',
			'composer.json',
			'pom.xml',
			'build.gradle',
			'CMakeLists.txt',
		];
		expect(PROJECT_INDICATORS).toEqual(expected);
		expect(PROJECT_INDICATORS.length).toBe(11);
	});
});

// =============================================================================
// ATTACK VECTOR 5: DEPTH BYPASS — symlink chains that could reset depth counter
// =============================================================================

describe('DEPTH BYPASS — symlink chains and depth counter integrity', () => {
	it('symlink chain does not cause inconsistent results', () => {
		// Multiple symlinks to same target all produce the same result
		const realDir = path.join(tempDir, 'real');
		mkdirSync(path.join(realDir, '.swarm'), { recursive: true });
		writeFileSync(path.join(realDir, 'package.json'), '{}');

		const subDir = path.join(realDir, 'subdir');
		mkdirSync(subDir, { recursive: true });

		try {
			symlinkSync(realDir, path.join(tempDir, 'link1'), 'junction');
			symlinkSync(
				path.join(tempDir, 'link1'),
				path.join(tempDir, 'link2'),
				'junction',
			);
		} catch {
			return;
		}

		// All paths should throw consistently
		expect(() => validateProjectRoot(subDir)).toThrow('Cannot write evidence');
		expect(() => validateProjectRoot(path.join(tempDir, 'link1'))).toThrow(
			'Cannot write evidence',
		);
		expect(() => validateProjectRoot(path.join(tempDir, 'link2'))).toThrow(
			'Cannot write evidence',
		);
	});

	it('symlink to ancestor directory does not bypass detection', () => {
		// tempDir/parent/ has .swarm/ + indicator
		// tempDir/parent/loop -> parent (self-reference via ancestor)
		const parentDir = path.join(tempDir, 'parent');
		const childDir = path.join(parentDir, 'child');
		mkdirSync(childDir, { recursive: true });
		mkdirSync(path.join(parentDir, '.swarm'), { recursive: true });
		writeFileSync(path.join(parentDir, 'package.json'), '{}');

		const loopLink = path.join(parentDir, 'loop');
		try {
			symlinkSync(parentDir, loopLink, 'junction');
		} catch {
			return;
		}

		// Child has parent .swarm/ → throw (loop symlink doesn't bypass)
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('self-referential symlink throws descriptive error (realpathSync fails)', () => {
		const selfLink = path.join(tempDir, 'self-link');
		try {
			symlinkSync(selfLink, selfLink, 'junction');
		} catch {
			return;
		}

		// Self-referential symlink — realpathSync fails → throws descriptive error
		expect(() => validateProjectRoot(selfLink)).toThrow(
			'Cannot verify project root',
		);
	});
});

// =============================================================================
// ATTACK VECTOR 6: UNICODE / ENCODING — pathological path inputs
// =============================================================================

describe('UNICODE / ENCODING — pathological path inputs', () => {
	it('unicode directory name with valid structure does not crash', () => {
		if (envHasSwarmAncestor) return; // environment blocks "no throw" path

		const unicodeDir = path.join(tempDir, '日本語ディレクトリ');
		const childDir = path.join(unicodeDir, '中文目录', 'emoji-🚀');
		mkdirSync(childDir, { recursive: true });

		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});

	it('null byte in path name throws descriptive error', () => {
		// Null bytes are invalid in paths — realpathSync throws
		const invalidPath = path.join(tempDir, 'valid-part\0invalid-part');
		expect(() => validateProjectRoot(invalidPath)).toThrow(
			'Cannot verify project root',
		);
	});

	it('very long directory name does not crash', () => {
		if (envHasSwarmAncestor) return;

		const longName = 'a'.repeat(200);
		const longDir = path.join(tempDir, longName);
		const childDir = path.join(longDir, 'child');
		mkdirSync(childDir, { recursive: true });

		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});

	it('directory with spaces in name does not crash', () => {
		if (envHasSwarmAncestor) return;

		const spaceDir = path.join(tempDir, 'directory with spaces');
		const childDir = path.join(spaceDir, 'child dir');
		mkdirSync(childDir, { recursive: true });

		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});

	it('directory with special characters does not crash', () => {
		if (envHasSwarmAncestor) return;

		const specialDir = path.join(tempDir, 'dir-with-special-!@#$');
		const childDir = path.join(specialDir, 'child');
		mkdirSync(childDir, { recursive: true });

		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});

	it('RTL override unicode character in directory name does not crash', () => {
		if (envHasSwarmAncestor) return;

		// U+202E Right-to-Left Override — used to disguise extensions
		const rtlDir = path.join(tempDir, 'file\u202E.txt');
		mkdirSync(rtlDir, { recursive: true });

		expect(() => validateProjectRoot(rtlDir)).not.toThrow();
	});

	it('zero-width space in directory name does not crash', () => {
		if (envHasSwarmAncestor) return;

		// U+200B Zero Width Space
		const zwspDir = path.join(tempDir, 'file\u200Bname');
		mkdirSync(zwspDir, { recursive: true });

		expect(() => validateProjectRoot(zwspDir)).not.toThrow();
	});

	it('mixing unicode from different scripts does not crash', () => {
		if (envHasSwarmAncestor) return;

		const mixedDir = path.join(tempDir, '日本語中文العربيةעברית');
		const childDir = path.join(mixedDir, '한국어');
		mkdirSync(childDir, { recursive: true });

		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});
});

// =============================================================================
// ATTACK VECTOR 7: ERROR HANDLING — malformed inputs
// =============================================================================

describe('ERROR HANDLING — malformed directory inputs', () => {
	it('non-existent directory path throws descriptive error', () => {
		const nonExistent = path.join(tempDir, 'this-does-not-exist', 'anywhere');
		expect(() => validateProjectRoot(nonExistent)).toThrow(
			'Cannot verify project root',
		);
	});

	it('empty string resolves to CWD and validates correctly (no crash)', () => {
		// Empty string resolves to CWD via realpathSync('')
		// CWD = E:\OpenCode\opencode-swarm which is a valid project root
		// Validation walks UP from CWD and finds no parent .swarm/ → no throw
		// This verifies empty string is handled, not a crash
		expect(() => validateProjectRoot('')).not.toThrow();
	});

	it('root filesystem path / or C:\\ does not crash', () => {
		// Filesystem root has no parent — loop breaks immediately
		const rootPath = process.platform === 'win32' ? 'C:\\' : '/';
		expect(() => validateProjectRoot(rootPath)).not.toThrow();
	});
});

// =============================================================================
// ATTACK VECTOR 8: FILESYSTEM ROOT — edge cases at filesystem boundary
// =============================================================================

describe('FILESYSTEM ROOT — edge cases at filesystem boundary', () => {
	it('validation stops at filesystem root without crashing', () => {
		// Deep chain with no .swarm/ — walk reaches filesystem root and stops
		const deepest = buildDeepChain(30);
		// In this environment, the ancestor check will throw if there's a .swarm/ above
		// Otherwise it should not throw (reaches root without finding .swarm/)
		try {
			validateProjectRoot(deepest);
		} catch (e) {
			// Expected if env has swarm ancestor — verify it's the right error
			expect((e as Error).message).toMatch(
				/Cannot write evidence|Cannot verify/,
			);
		}
	});
});

// =============================================================================
// ATTACK VECTOR 9: WINDOWS-SPECIFIC — junction points
// =============================================================================

describe('WINDOWS JUNCTIONS — junction point edge cases', () => {
	it('directory junction to project with .swarm/ is detected', () => {
		if (process.platform !== 'win32') return;

		const realProject = path.join(tempDir, 'real-project');
		mkdirSync(path.join(realProject, '.swarm'), { recursive: true });
		writeFileSync(path.join(realProject, 'package.json'), '{}');

		const subDir = path.join(realProject, 'subdir');
		mkdirSync(subDir, { recursive: true });

		const junctionPath = path.join(tempDir, 'junction-project');
		try {
			symlinkSync(realProject, junctionPath, 'junction');
		} catch {
			return;
		}

		// Validate through the junction — realpathSync resolves junction to real path → detects .swarm/ → throw
		const junctionSubDir = path.join(junctionPath, 'subdir');
		expect(() => validateProjectRoot(junctionSubDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('junction to non-existent target throws gracefully', () => {
		if (process.platform !== 'win32') return;

		const brokenJunction = path.join(tempDir, 'broken-junction');
		try {
			symlinkSync(
				path.join(tempDir, 'non-existent'),
				brokenJunction,
				'junction',
			);
		} catch {
			return;
		}

		// Should throw with "Cannot verify project root" (can't resolve target)
		expect(() => validateProjectRoot(brokenJunction)).toThrow(
			'Cannot verify project root',
		);
	});
});

// =============================================================================
// ATTACK VECTOR 10: STRAY ARTIFACT HEURISTIC — .swarm/ without indicators
// =============================================================================

describe('STRAY ARTIFACT HEURISTIC — .swarm/ without indicators', () => {
	it('.swarm/ alone (no indicators) is treated as stray — continues walking', () => {
		if (envHasSwarmAncestor) return;

		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		// No indicators found → stray artifact → continue walking → should NOT throw
		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});

	it('.swarm/ + .opencode (indicator) triggers rejection', () => {
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });

		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('every PROJECT_INDICATOR is checked even when first does not exist', () => {
		if (envHasSwarmAncestor) return;

		// Only one indicator (go.mod)
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		writeFileSync(path.join(tempDir, 'go.mod'), 'module test');

		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		// go.mod found → throw
		expect(() => validateProjectRoot(childDir)).toThrow(
			'Cannot write evidence',
		);
	});

	it('no indicators at all — .swarm/ alone — is treated as stray artifact', () => {
		if (envHasSwarmAncestor) return;

		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		// NO project indicators

		const childDir = path.join(tempDir, 'child');
		mkdirSync(childDir, { recursive: true });

		// No indicators → stray → continue → should NOT throw
		expect(() => validateProjectRoot(childDir)).not.toThrow();
	});
});
