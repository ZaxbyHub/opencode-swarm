/**
 * ADVERSARIAL: update_task_status with a fallbackDir built from a reserved
 * Windows device name plus traversal (`NUL/../../../etc`).
 *
 * `<name>/../../../etc` resolves to `../../etc` from the cwd. This case lived
 * in update-task-status.adversarial.test.ts and ran from the repository root,
 * where that target is outside the checkout (e.g. ~/etc): any plan another run
 * left there made the update succeed and the test fail. It now runs from a
 * sandbox three levels deep and pins the target inside it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import { resetSwarmState } from '../state';
import { executeUpdateTaskStatus } from './update-task-status';

const originalCwd = process.cwd();
let sandbox = '';

beforeEach(() => {
	resetSwarmState();
	sandbox = canonicalMkdtemp('uts-reserved-');
	const sandboxCwd = path.join(sandbox, 'a', 'b', 'c');
	mkdirSync(sandboxCwd, { recursive: true });
	process.chdir(sandboxCwd);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(sandbox, { recursive: true, force: true });
	resetSwarmState();
});

describe('ADVERSARIAL: fallbackDir reserved Windows names', () => {
	it('should reject fallbackDir with reserved Windows names (CON, AUX, NUL)', async () => {
		for (const name of ['NUL', 'CON', 'AUX', 'COM1', 'LPT1']) {
			const reservedPath = path.join(name, '..', '..', '..', 'etc');
			expect(path.resolve(reservedPath).startsWith(sandbox)).toBe(true);

			const result = await executeUpdateTaskStatus(
				{ task_id: '1.1', status: 'pending' },
				reservedPath,
			);

			// Reserved names can cause issues on Windows
			expect(result.success).toBe(false);
		}
	});
});
