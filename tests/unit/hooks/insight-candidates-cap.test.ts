/**
 * Tests for insight-candidates.jsonl FIFO cap (#1234 Part 3C).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	INSIGHT_CANDIDATES_MAX_ENTRIES,
	resolveInsightCandidatesPath,
} from '../../../src/hooks/micro-reflector.js';

describe('insight candidates FIFO cap', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-cap-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('exports the expected max entries constant', () => {
		expect(INSIGHT_CANDIDATES_MAX_ENTRIES).toBe(500);
	});

	it('resolves the correct path', () => {
		const p = resolveInsightCandidatesPath(dir);
		expect(p).toContain('.swarm');
		expect(p).toContain('insight-candidates.jsonl');
	});
});
