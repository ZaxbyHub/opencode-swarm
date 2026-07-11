import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	deriveRequiredGates,
	readTaskEvidence,
	recordAgentDispatch,
} from './gate-evidence';

describe('doc-only required gate persistence', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-gate-evidence-'));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('trusted exemption requires reviewer but not test_engineer', async () => {
		expect(deriveRequiredGates('coder', { testEngineerExempt: true })).toEqual([
			'reviewer',
		]);
		await recordAgentDispatch(directory, '1.1', 'coder', false, {
			testEngineerExempt: true,
		});
		const evidence = await readTaskEvidence(directory, '1.1');
		expect(evidence?.required_gates).toEqual(['reviewer']);
		expect(evidence?.test_engineer_exempt).toBe(true);
	});

	test('missing classification fails closed to the full pair', async () => {
		await recordAgentDispatch(directory, '1.2', 'coder');
		const evidence = await readTaskEvidence(directory, '1.2');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(evidence?.test_engineer_exempt).toBe(false);
	});

	test('append-only evidence never downgrades an existing code task', async () => {
		await recordAgentDispatch(directory, '1.3', 'coder');
		await recordAgentDispatch(directory, '1.3', 'coder', false, {
			testEngineerExempt: true,
		});
		const evidence = await readTaskEvidence(directory, '1.3');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(evidence?.test_engineer_exempt).toBe(false);
	});
});
