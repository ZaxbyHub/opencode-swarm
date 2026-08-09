/**
 * Shared fixture for the `lane-permissions` test files.
 *
 * Extracted when `lane-permissions.test.ts` crossed the FR-006 500-line cap and
 * was split into allowlist CONSTRUCTION (`lane-permissions.test.ts`) and rule
 * PRECEDENCE (`lane-permissions-precedence.test.ts`). Both files need the same
 * lane and the same two thin wrappers, so this is the split protocol's
 * preferred "extract to a shared utility" option rather than duplication.
 *
 * Contains no assertions and no mocks — it is pure data plus two pass-throughs,
 * so it cannot introduce cross-file mock leakage.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { LaneContext } from '../../src/config/lane-context';
import { _test_exports } from '../../src/config/lane-permissions';

export const { buildLaneAllowlist, buildLaneExternalDirectoryRules } =
	_test_exports;

export const lane: LaneContext = {
	lanePath: path.resolve(
		path.join(os.tmpdir(), 'wt', '.swarm-worktrees', 's', '1.1'),
	),
	parentProjectPath: path.resolve(path.join(os.tmpdir(), 'wt', 'my-project')),
};

/** Builds rules, unwrapping the {rules, coercedAskPatterns} envelope. */
export function build(
	mode: 'scoped_allow' | 'deny' | 'off',
	existing?: unknown,
): Record<string, string> | null {
	const out = buildLaneExternalDirectoryRules(mode, lane, existing);
	return out ? out.rules : null;
}

/** Wraps rules the way `applyLanePermissions` writes them into the config. */
export function asPermission(
	rules: Record<string, string> | null,
): Record<string, unknown> {
	return rules ? { external_directory: rules } : {};
}
