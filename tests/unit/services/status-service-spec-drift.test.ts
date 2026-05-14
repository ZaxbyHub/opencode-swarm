/**
 * Tests for the spec-drift surfacing in /swarm status (issue #853 Layer C).
 *
 * Covers getStatusData populating specStale + reason + hashes from
 * .swarm/spec-staleness.json, and formatStatusMarkdown rendering a
 * **Spec drift detected** line.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	formatStatusMarkdown,
	getStatusData,
	handleStatusCommand,
} from '../../../src/services/status-service';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-spec-drift-'));
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

async function writeStalenessFile(): Promise<void> {
	await fs.writeFile(
		path.join(tmpDir, '.swarm', 'spec-staleness.json'),
		JSON.stringify({
			specHash_plan: 'def456',
			specHash_current: 'abc123',
			reason: 'spec.md changed since plan saved',
		}),
	);
}

describe('getStatusData spec drift surfacing', () => {
	test('exposes specStale + reason + hashes when spec-staleness.json exists', async () => {
		await writeStalenessFile();
		const data = await getStatusData(tmpDir, {});
		expect(data.specStale).toBe(true);
		expect(data.specStaleReason).toBe('spec.md changed since plan saved');
		expect(data.specStaleStoredHash).toBe('def456');
		expect(data.specStaleCurrentHash).toBe('abc123');
	});

	test('omits specStale when no drift signal is present', async () => {
		const data = await getStatusData(tmpDir, {});
		expect(data.specStale).toBeUndefined();
	});

	test('surfaces drift even when no plan loaded (cross-session case)', async () => {
		await writeStalenessFile();
		const data = await getStatusData(tmpDir, {});
		expect(data.hasPlan).toBe(false);
		expect(data.specStale).toBe(true);
	});
});

describe('formatStatusMarkdown spec drift line', () => {
	test('renders **Spec drift detected** line with stored/current hashes', async () => {
		await writeStalenessFile();
		const data = await getStatusData(tmpDir, {});
		const md = formatStatusMarkdown(data);
		expect(md).toContain('**Spec drift detected**');
		expect(md).toContain('stored: def456');
		expect(md).toContain('current: abc123');
		expect(md).toContain('/swarm clarify');
		expect(md).toContain('/swarm acknowledge-spec-drift');
	});
});

describe('handleStatusCommand spec drift fallback (PR #855 follow-up)', () => {
	test('emits the drift block even when no plan is loaded', async () => {
		await writeStalenessFile();
		const md = await handleStatusCommand(tmpDir, {});
		expect(md).toContain('No active swarm plan found.');
		expect(md).toContain('**Spec drift detected**');
		expect(md).toContain('stored: def456');
		expect(md).toContain('current: abc123');
		expect(md).toContain('/swarm clarify');
		expect(md).toContain('/swarm acknowledge-spec-drift');
	});

	test('falls back to plain no-plan message when drift signal is absent', async () => {
		const md = await handleStatusCommand(tmpDir, {});
		expect(md).toBe('No active swarm plan found.');
	});
});
