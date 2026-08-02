/**
 * Issue #2002 follow-up: `AgentSessionState.workspaceDirectory` is
 * deliberately NOT persisted to the session snapshot.
 *
 * See the "DELIBERATELY NOT SNAPSHOTTED" block at the field declaration in
 * `src/state.ts` for the full rationale: `.swarm/session/state.json` lives
 * under the project-root `.swarm/` directory, which the architect agent can
 * write, so a restored string is not a trusted resolution root, and no
 * durable, plugin-owned record exists that can revalidate a restored value
 * against every `recordSessionWorkspaceRoot` call site.
 *
 * This suite pins two behaviours so a future change cannot silently regress
 * the trust decision:
 *  1. `serializeAgentSession` never emits a `workspaceDirectory` key, even
 *     when the live session has one set.
 *  2. A full write -> read -> rehydrate round trip degrades fail-closed: the
 *     restored session resolves to the caller-supplied fallback (the
 *     plugin-root directory), not the pre-restart lane path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	readSnapshot,
	rehydrateState,
	TRANSIENT_SESSION_FIELDS,
} from '../../../src/session/snapshot-reader.js';
import {
	serializeAgentSession,
	writeSnapshot,
} from '../../../src/session/snapshot-writer.js';
import {
	ensureAgentSession,
	recordSessionWorkspaceRoot,
	resetSwarmState,
	resolveSessionWorkspaceDirectory,
	swarmState,
} from '../../../src/state.js';

describe('workspaceDirectory is deliberately not persisted (issue #2002)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'swarm-workspace-dir-omission-'));
		resetSwarmState();
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		resetSwarmState();
	});

	it('serializeAgentSession never emits a workspaceDirectory key', () => {
		const sessionId = 'wd-omission-serialize';
		const laneRoot = '/some/lane/root/for/wd-omission-serialize';
		ensureAgentSession(sessionId, 'coder', '/project/root');
		recordSessionWorkspaceRoot(sessionId, laneRoot);

		const session = swarmState.agentSessions.get(sessionId);
		expect(session).toBeDefined();
		expect(session?.workspaceDirectory).toBe(laneRoot);

		const serialized = serializeAgentSession(session!);
		expect('workspaceDirectory' in serialized).toBe(false);
		// Belt-and-suspenders: the lane path itself must not leak into the
		// serialized payload through any other key.
		expect(JSON.stringify(serialized)).not.toContain(laneRoot);
	});

	it('is never listed as a transient field to reset on rehydration', () => {
		// workspaceDirectory is never restored in the first place (it isn't part
		// of SerializedAgentSession), so it must not appear in the reset list —
		// that would misleadingly imply a restore-then-reset lifecycle it never
		// has. See the comment above TRANSIENT_SESSION_FIELDS.
		expect(
			TRANSIENT_SESSION_FIELDS.some((f) => f.name === 'workspaceDirectory'),
		).toBe(false);
	});

	it('a restart round trip degrades fail-closed to the caller-supplied fallback', async () => {
		const sessionId = 'wd-omission-roundtrip';
		const laneRoot = join(tempDir, 'lane-root-marker');
		const projectRoot = join(tempDir, 'project-root');

		ensureAgentSession(sessionId, 'coder', projectRoot);
		recordSessionWorkspaceRoot(sessionId, laneRoot);
		expect(resolveSessionWorkspaceDirectory(sessionId, projectRoot)).toBe(
			laneRoot,
		);

		await writeSnapshot(tempDir, swarmState);

		// Assert the on-disk snapshot text does not contain the lane path at all
		// — not just that the typed field is absent from the writer's return
		// value, but that nothing downstream (e.g. a stray string field) leaked
		// it into the actual bytes written to .swarm/.
		const statePath = join(tempDir, '.swarm', 'session', 'state.json');
		const raw = readFileSync(statePath, 'utf8');
		expect(raw).not.toContain('lane-root-marker');

		// Simulate a plugin restart: clear in-memory state, then rehydrate from
		// the snapshot that was just written to disk.
		resetSwarmState();
		expect(swarmState.agentSessions.has(sessionId)).toBe(false);

		const snapshot = await readSnapshot(tempDir);
		expect(snapshot).not.toBeNull();
		await rehydrateState(snapshot!, tempDir);

		const restored = swarmState.agentSessions.get(sessionId);
		expect(restored).toBeDefined();
		expect(restored?.workspaceDirectory).toBeUndefined();

		// This is the actual security requirement: post-restart resolution must
		// re-root onto the caller-supplied fallback (the plugin-root directory),
		// never onto the pre-restart lane — a lane coder that resumes after a
		// restart is blocked (SCOPE_NOT_DECLARED) rather than granted a wider or
		// mismatched resolution root.
		expect(resolveSessionWorkspaceDirectory(sessionId, projectRoot)).toBe(
			projectRoot,
		);
	});
});
