/**
 * 2026-11-25 swarm_communication_debug (layer 3): the binding store's
 * `catch { return false }` discarded the write failure's CAUSE entirely — the
 * gate's always-emitted criticalWarn goes to the host process's stderr, which
 * `opencode serve --service` pipes into a supervisor socket, leaving zero
 * diagnosable signal (observed live: every Stage-B dispatch in the consumer
 * project left an empty session dir across days). The store now records the
 * exact failure (message + errno code) in a bounded, project-visible
 * `.write-errors.jsonl` inside the store root, best-effort by contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordStageBDispatchBindings } from '../../../src/background/stage-b-dispatch-binding-store';
import { _internals as atomicInternals } from '../../../src/utils/atomic-write';

const SESSION = 'ses_diagnostic00000000000000000';
const CALL = 'call_diagnostic0000000000000000';
const realAtomicRename = atomicInternals.renameSync;

let dir: string;

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'sb-binding-diag-')),
	);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	atomicInternals.renameSync = realAtomicRename;
	fs.rmSync(dir, { recursive: true, force: true });
});

function failRenamesWith(code: string): void {
	atomicInternals.renameSync = (() => {
		const err = new Error(`EACCES: permission denied, rename '${code}'`) as Error &
			{ code?: string };
		err.code = code;
		throw err;
	}) as unknown as typeof fs.renameSync;
}

describe('stage-b binding store write-failure diagnostics', () => {
	test('a failing atomic write surfaces the errno in the bounded store-root diagnostic file', () => {
		failRenamesWith('EACCES');
		const persisted = recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [{ taskId: '1.1', generation: 1 }],
		});
		expect(persisted).toBe(false);

		const diagPath = path.join(
			dir,
			'.swarm',
			'stage-b-dispatch-bindings',
			'.write-errors.jsonl',
		);
		expect(fs.existsSync(diagPath)).toBe(true);
		const lines = fs
			.readFileSync(diagPath, 'utf8')
			.split('\n')
			.filter((line) => line.trim().length > 0);
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const last = JSON.parse(lines[lines.length - 1]) as {
			sessionID?: string;
			callID?: string;
			error?: string;
			code?: string;
		};
		expect(last.sessionID).toBe(SESSION);
		expect(last.callID).toBe(CALL);
		expect(last.error).toContain('EACCES');
		expect(last.code).toBe('EACCES');
	});

	test('a healthy write leaves no diagnostic file and persists the record', () => {
		const persisted = recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [{ taskId: '1.1', generation: 1 }],
		});
		expect(persisted).toBe(true);
		const diagPath = path.join(
			dir,
			'.swarm',
			'stage-b-dispatch-bindings',
			'.write-errors.jsonl',
		);
		expect(fs.existsSync(diagPath)).toBe(false);
		const sessionDir = createHash('sha256')
			.update(SESSION)
			.digest('hex')
			.slice(0, 24);
		const recordPath = path.join(
			dir,
			'.swarm',
			'stage-b-dispatch-bindings',
			sessionDir,
			`${CALL}.json`,
		);
		expect(fs.existsSync(recordPath)).toBe(true);
	});
});
