import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { archiveEvaluationArtifacts } from '../../../src/evaluation/retention';
import { writeEvidenceDocuments } from '../../../src/evidence/documents';
import { pruneEvidenceDocuments } from '../../../src/evidence/documents-retention';
import { writeImmutableArtifact } from '../../../src/evidence/immutable-store';
import { deleteEvidence, loadEvidence } from '../../../src/evidence/manager';
import {
	createNestedBoundaryFixture,
	type NestedBoundaryFixture,
	removeNestedBoundaryFixture,
} from '../../helpers/nested-project-boundary';

const fixtures: NestedBoundaryFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		removeNestedBoundaryFixture(fixture);
	}
});

function fixture(
	marker: 'git-directory' | 'opencode' = 'git-directory',
): NestedBoundaryFixture {
	const created = createNestedBoundaryFixture(marker);
	fixtures.push(created);
	return created;
}

function legacyRetrospective(taskId: string): Record<string, unknown> {
	return {
		type: 'retrospective',
		task_id: taskId,
		timestamp: '2024-01-01T00:00:00.000Z',
		agent: 'test-agent',
		verdict: 'info',
		summary: 'Legacy retrospective',
		phase_number: 1,
		total_tool_calls: 12,
		coder_revisions: 1,
		reviewer_rejections: 0,
		test_failures: 0,
		security_findings: 0,
		integration_issues: 0,
		task_count: 1,
		task_complexity: 'moderate',
		top_rejection_reasons: [],
		lessons_learned: [],
	};
}

function auditResult(runId: string): Record<string, unknown> {
	return {
		v: 1,
		runId,
		manifestHash: 'f'.repeat(64),
		createdAt: '2024-01-01T00:00:00.000Z',
		status: 'complete',
		cells: [],
		cost: { source: 'reported', usd: 0 },
		qualityMetricAvailability: {
			complexity_delta: 'unavailable',
			public_api_delta: 'unavailable',
		},
	};
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value));
}

function documentRow(id: string, capturedAt: string): string {
	return JSON.stringify({
		id,
		ref: `evidence-cache:${id}`,
		sourceType: 'manual',
		text: `document ${id}`,
		capturedAt,
	});
}

function immutableOptions(directory: string) {
	const filePath = path.join(
		directory,
		'.swarm',
		'evolution',
		'custom',
		'artifact.json',
	);
	return {
		filePath,
		options: {
			directory,
			relativeLockPath: path.join('evolution', 'custom', 'artifact.json'),
			filePath,
			agent: 'containment-test',
			taskId: 'artifact',
			value: { id: 'artifact', value: 1 },
			serialize: (value: unknown) => JSON.stringify(value),
			parse: (value: unknown) => value as { id: string; value: number },
			conflictError: () => new Error('immutable conflict'),
		},
	};
}

describe('evidence-family mutation sinks — nested project containment', () => {
	test('ordinary descendants preserve every pre-existing artifact byte-for-byte', async () => {
		const { ordinary } = fixture();
		const legacyPath = path.join(
			ordinary,
			'.swarm',
			'evidence',
			'legacy-task',
			'evidence.json',
		);
		const deletePath = path.join(
			ordinary,
			'.swarm',
			'evidence',
			'delete-task',
			'evidence.json',
		);
		const documentsPath = path.join(
			ordinary,
			'.swarm',
			'evidence-cache',
			'documents.jsonl',
		);
		const immutableSentinel = path.join(
			ordinary,
			'.swarm',
			'evolution',
			'custom',
			'sentinel.txt',
		);
		const auditPath = path.join(
			ordinary,
			'.swarm',
			'evidence',
			'gate-audit',
			'old-audit',
			'results.json',
		);

		writeJson(legacyPath, legacyRetrospective('legacy-task'));
		writeJson(deletePath, { keep: 'delete evidence sentinel' });
		fs.mkdirSync(path.dirname(documentsPath), { recursive: true });
		fs.writeFileSync(
			documentsPath,
			`${documentRow('old-1', '2024-01-01T00:00:00.000Z')}\n${documentRow('old-2', '2024-01-02T00:00:00.000Z')}\n`,
		);
		fs.mkdirSync(path.dirname(immutableSentinel), { recursive: true });
		fs.writeFileSync(immutableSentinel, 'immutable sentinel');
		writeJson(auditPath, auditResult('old-audit'));

		const snapshots = new Map(
			[legacyPath, deletePath, documentsPath, immutableSentinel, auditPath].map(
				(filePath) => [filePath, fs.readFileSync(filePath)],
			),
		);

		// Before the fix, the legacy read rewrote the file under an evidence lock.
		const loaded = await loadEvidence(ordinary, 'legacy-task');
		expect(loaded.status).toBe('found');
		expect(await deleteEvidence(ordinary, 'delete-task')).toBe(false);
		await expect(
			writeEvidenceDocuments(ordinary, [
				{ sourceType: 'manual', text: 'new document' },
			]),
		).rejects.toThrow('project root');
		const immutable = immutableOptions(ordinary);
		await expect(writeImmutableArtifact(immutable.options)).rejects.toThrow(
			'project root',
		);
		await expect(
			pruneEvidenceDocuments({ directory: ordinary, maxRecords: 1 }),
		).rejects.toThrow('project root');
		await expect(
			archiveEvaluationArtifacts({
				directory: ordinary,
				maxAgeDays: 1,
				now: new Date('2026-01-01T00:00:00.000Z'),
			}),
		).rejects.toThrow('project root');

		for (const [filePath, snapshot] of snapshots) {
			expect(fs.readFileSync(filePath)).toEqual(snapshot);
		}
		expect(fs.existsSync(immutable.filePath)).toBe(false);
		expect(fs.existsSync(path.dirname(auditPath))).toBe(true);
	});

	test.each([
		['direct .git directory', 'git-directory'],
		['direct .opencode directory', 'opencode'],
	] as const)('%s allows every evidence-family mutation sink', async (_label, marker) => {
		const { nested } = fixture(marker);
		const legacyPath = path.join(
			nested,
			'.swarm',
			'evidence',
			'legacy-task',
			'evidence.json',
		);
		const deleteDir = path.join(nested, '.swarm', 'evidence', 'delete-task');
		const documentsPath = path.join(
			nested,
			'.swarm',
			'evidence-cache',
			'documents.jsonl',
		);
		const auditDir = path.join(
			nested,
			'.swarm',
			'evidence',
			'gate-audit',
			'old-audit',
		);

		writeJson(legacyPath, legacyRetrospective('legacy-task'));
		writeJson(path.join(deleteDir, 'evidence.json'), { delete: true });
		writeJson(path.join(auditDir, 'results.json'), auditResult('old-audit'));

		const loaded = await loadEvidence(nested, 'legacy-task');
		expect(loaded.status).toBe('found');
		expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).schema_version).toBe(
			'1.0.0',
		);
		expect(await deleteEvidence(nested, 'delete-task')).toBe(true);
		expect(fs.existsSync(deleteDir)).toBe(false);

		await writeEvidenceDocuments(
			nested,
			[
				{ sourceType: 'manual', text: 'older document' },
				{ sourceType: 'manual', text: 'newer document' },
			],
			() => new Date('2025-01-01T00:00:00.000Z'),
		);
		const beforePrune = fs.readFileSync(documentsPath, 'utf8');
		const pruned = await pruneEvidenceDocuments({
			directory: nested,
			maxRecords: 1,
		});
		expect(pruned.archived).toBe(1);
		expect(fs.readFileSync(documentsPath, 'utf8')).not.toBe(beforePrune);

		const immutable = immutableOptions(nested);
		const stored = await writeImmutableArtifact(immutable.options);
		expect(stored).toEqual({ id: 'artifact', value: 1 });
		expect(fs.existsSync(immutable.filePath)).toBe(true);

		const archived = await archiveEvaluationArtifacts({
			directory: nested,
			maxAgeDays: 1,
			now: new Date('2026-01-01T00:00:00.000Z'),
		});
		expect(archived.archived).toContainEqual({
			namespace: 'gate-audit',
			id: 'old-audit',
		});
		expect(fs.existsSync(auditDir)).toBe(false);
	});
});
