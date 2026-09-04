/**
 * Tri-state task-evidence reader tests (issue #2470 / #2199).
 *
 * readTaskEvidenceState must distinguish:
 *  - ok:          valid evidence parses and is returned
 *  - missing:     ENOENT, ENAMETOOLONG-class "file cannot exist", and
 *                 grammar-invalid taskIds (no valid filename can exist, so
 *                 pointing at repair_gate_evidence would misdirect)
 *  - unparseable: malformed JSON, version-skew workflow.state, permission
 *                 errors — a real file exists but cannot be used
 *
 * readTaskEvidence must keep its historical fail-open contract: null for BOTH
 * missing and unparseable.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import {
	readTaskEvidence,
	readTaskEvidenceState,
	transitionTaskWorkflowEvidence,
} from '../../src/gate-evidence';
import { canonicalMkdtemp } from '../helpers/tmpdir.js';

/** Schema-valid evidence produced through the real writer (coder_delegated). */
async function seedValidEvidence(dir: string, taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(dir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${taskId}`,
	});
}

const VALID_EVIDENCE = {
	taskId: '1.1',
	required_gates: [],
	gates: {},
	turbo: {},
	requirements_state: 'unspecified',
	test_engineer_exempt: false,
	workflow: {
		schema: 'exact-task-v1',
		generation: 1,
		state: 'coder_delegated',
		retryCount: 0,
		retryHistory: [],
		retryEpoch: 0,
		updatedAt: '2026-01-01T00:00:00Z',
	},
	repair_provenance: [],
};

/** Version-skew fixture: a NEWER build wrote a workflow.state this build does not know. */
const VERSION_SKEW_EVIDENCE = {
	...VALID_EVIDENCE,
	workflow: {
		...VALID_EVIDENCE.workflow,
		state: 'future_state_v9',
	},
};

function evidencePath(dir: string, taskId: string): string {
	return path.join(dir, '.swarm', 'evidence', `${taskId}.json`);
}

function writeEvidence(dir: string, taskId: string, content: string): void {
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(evidencePath(dir, taskId), content, 'utf-8');
}

describe('readTaskEvidenceState (issue #2470 tri-state reader)', () => {
	test('ok: valid evidence returns {kind:"ok"} with the parsed evidence', async () => {
		const dir = canonicalMkdtemp('read-state-ok-');
		try {
			await seedValidEvidence(dir, '1.1');
			const state = await readTaskEvidenceState(dir, '1.1');
			expect(state.kind).toBe('ok');
			if (state.kind === 'ok') {
				expect(state.evidence.taskId).toBe('1.1');
				expect(state.evidence.workflow?.state).toBe('coder_delegated');
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('missing: absent file returns {kind:"missing"} (ENOENT)', async () => {
		const dir = canonicalMkdtemp('read-state-missing-');
		try {
			const state = await readTaskEvidenceState(dir, '3.1');
			expect(state.kind).toBe('missing');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('unparseable: malformed JSON is reported with the evidence path', async () => {
		const dir = canonicalMkdtemp('read-state-malformed-');
		try {
			writeEvidence(dir, '2.1', '{not json');
			const state = await readTaskEvidenceState(dir, '2.1');
			expect(state.kind).toBe('unparseable');
			if (state.kind === 'unparseable') {
				expect(state.evidencePath).toBe(evidencePath(dir, '2.1'));
				expect(state.error).toBeDefined();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('unparseable: version-skew workflow.state (valid JSON, unknown enum) fails closed', async () => {
		const dir = canonicalMkdtemp('read-state-skew-');
		try {
			writeEvidence(dir, '1.1', JSON.stringify(VERSION_SKEW_EVIDENCE));
			const state = await readTaskEvidenceState(dir, '1.1');
			expect(state.kind).toBe('unparseable');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('missing: grammar-invalid taskId cannot produce an evidence filename', async () => {
		const dir = canonicalMkdtemp('read-state-badid-');
		try {
			const state = await readTaskEvidenceState(dir, '../escape');
			// "missing", not "unparseable": no file can exist for an invalid
			// taskId, and a corrupt-evidence diagnostic would send operators
			// to repair_gate_evidence, which cannot fix a format problem.
			expect(state.kind).toBe('missing');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('readTaskEvidence keeps its fail-open wrapper contract (null for all three)', async () => {
		const dir = canonicalMkdtemp('read-state-wrapper-');
		try {
			await seedValidEvidence(dir, '1.1');
			writeEvidence(dir, '2.1', '{not json');
			writeEvidence(dir, '3.1', JSON.stringify(VERSION_SKEW_EVIDENCE));
			expect((await readTaskEvidence(dir, '1.1'))?.taskId).toBe('1.1');
			expect(await readTaskEvidence(dir, '2.1')).toBeNull();
			expect(await readTaskEvidence(dir, '3.1')).toBeNull();
			expect(await readTaskEvidence(dir, '4.1')).toBeNull();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
