import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTaskToolId } from '../../../src/hooks/normalize-tool-name';
import {
	HOST_TASK_TOOL_ID,
	PINNED_HOST_PACKAGE_VERSION,
} from '../../helpers/host-task-tool-contract-v1_18_3';

/**
 * Issue #2529: pin the host's REAL task tool id at the pinned host version so
 * a host-side rename fails loudly here instead of silently disabling the
 * plugin's delegation guards (model-route registration, loop detector,
 * incremental verify, memory recall).
 *
 * The installed npm packages ship type declarations only — not the native
 * tool registry — so the id itself is pinned in the provenance fixture
 * `tests/helpers/host-task-tool-contract-v1_18_3.ts` (host source
 * `packages/opencode/src/tool/task.ts`, tag v1.18.3, commit 127bdb30:
 * `const id = "task"`), and the installed/locked package versions are
 * asserted live, mirroring `host-message-role-contract-2526.test.ts`.
 */

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');

function readInstalledVersion(pkg: string): string {
	const manifest = JSON.parse(
		fs.readFileSync(
			path.join(REPO_ROOT, 'node_modules', '@opencode-ai', pkg, 'package.json'),
			'utf8',
		),
	) as { version?: string };
	return manifest.version ?? '';
}

describe('host task tool id contract (issue #2529)', () => {
	test('installed host packages are at the pinned version', () => {
		expect(readInstalledVersion('plugin')).toBe(PINNED_HOST_PACKAGE_VERSION);
		expect(readInstalledVersion('sdk')).toBe(PINNED_HOST_PACKAGE_VERSION);
	});

	test('bun.lock pins both host packages at the pinned version', () => {
		const lock = fs.readFileSync(path.join(REPO_ROOT, 'bun.lock'), 'utf8');
		expect(lock).toContain(
			`"@opencode-ai/plugin@${PINNED_HOST_PACKAGE_VERSION}"`,
		);
		expect(lock).toContain(`"@opencode-ai/sdk@${PINNED_HOST_PACKAGE_VERSION}"`);
	});

	test('the pinned host task tool id is the lowercase `task`', () => {
		// The provenance fixture pins the host source fact. If the host ever
		// renames the tool, this assertion fails and the fixture (plus every
		// isTaskToolId consumer) must be re-verified against the new host.
		expect(HOST_TASK_TOOL_ID).toBe('task');
	});

	test('the plugin task-tool boundary accepts exactly the host id', () => {
		expect(isTaskToolId(HOST_TASK_TOOL_ID)).toBe(true);
		// A host rename to, say, `subtask` breaks the boundary loudly:
		expect(isTaskToolId('subtask')).toBe(false);
	});
});
