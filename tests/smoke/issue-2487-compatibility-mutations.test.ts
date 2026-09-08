import { expect, test } from 'bun:test';
import {
	type CompatibilityCheckOptions,
	collectIssue2487CompatibilityErrors,
} from '../../scripts/check-issue-2487-compatibility';
import {
	type CompatibilityRow,
	ISSUE_2487_COMPATIBILITY_ROWS,
	SQLITE_EQUIVALENCE_PARTITIONS,
} from '../../scripts/issue-2487-compatibility.data';
import {
	collectPartitionEvidenceErrors,
	collectPartitionRecoveryEvidenceErrors,
} from '../../scripts/repro-2487.mjs';
import { RETENTION_REGISTRY } from '../../scripts/retention-registry.data';

function check(options: CompatibilityCheckOptions) {
	return collectIssue2487CompatibilityErrors(undefined, options);
}

test('compatibility gate rejects a removed SQLite table row', () => {
	const rows = ISSUE_2487_COMPATIBILITY_ROWS.filter(
		(row) => row.table !== 'observability_event',
	);
	const errors = check({ rows });
	expect(
		errors.some((error) =>
			error.includes('unregistered SQLite table: observability_event'),
		),
	).toBe(true);
});

test('compatibility gate rejects a removed reachable legacy row', () => {
	const rows = ISSUE_2487_COMPATIBILITY_ROWS.filter(
		(row) => row.id !== 'telemetry-jsonl',
	);
	const errors = check({ rows });
	expect(
		errors.some((error) =>
			error.includes(
				'reachable legacy surface is unregistered: telemetry-jsonl',
			),
		),
	).toBe(true);
});

test('compatibility gate rejects omission of retention-owned knowledge application history', () => {
	const rows = ISSUE_2487_COMPATIBILITY_ROWS.filter(
		(row) => row.id !== 'knowledge-application-legacy',
	);
	const errors = check({ rows });
	expect(
		errors.some((error) =>
			error.includes(
				'reachable legacy surface is unregistered: knowledge-application-legacy',
			),
		),
	).toBe(true);
});

test('independently discovered retirement candidate cannot lose its optional tag', () => {
	const retentionRows = RETENTION_REGISTRY.map((row) =>
		row.id === 'knowledge-application-legacy'
			? { ...row, issue2487Legacy: undefined }
			: row,
	);
	const errors = check({ retentionRows });
	expect(
		errors.some((error) =>
			error.includes(
				'retention legacy candidate is missing issue2487Legacy metadata: knowledge-application-legacy',
			),
		),
	).toBe(true);
});

test('independent census catches omitted coordination-import scope metadata', () => {
	const retentionRows = RETENTION_REGISTRY.map((row) =>
		row.id === 'scopes-family' ? { ...row, issue2487Legacy: undefined } : row,
	);
	const errors = check({ retentionRows });
	expect(
		errors.some((error) =>
			error.includes(
				'retention legacy candidate is missing issue2487Legacy metadata: scopes-family',
			),
		),
	).toBe(true);
});

test('compatibility gate rejects a fake production read switch', () => {
	const rows = ISSUE_2487_COMPATIBILITY_ROWS.map(
		(row): CompatibilityRow =>
			row.id === 'observability-event'
				? {
						...row,
						control: {
							kind: 'production-read-switch',
							name: 'FAKE_ISSUE_2487_SWITCH',
							enabledEvidence: 'enabled evidence',
							disabledEvidence: 'disabled evidence',
							scenario: 'kill-switches',
						},
					}
				: row,
	);
	const errors = check({ rows });
	expect(
		errors.some((error) =>
			error.includes('not a real source control: FAKE_ISSUE_2487_SWITCH'),
		),
	).toBe(true);
});

test('compatibility gate rejects a stale supported schema claim', () => {
	const errors = check({ supportedProjectSchemaVersion: 36 });
	expect(errors.some((error) => error.includes('stale schema claim'))).toBe(
		true,
	);
});

test('qualification gate rejects a partition when a declared production API invocation is removed', () => {
	const expected = SQLITE_EQUIVALENCE_PARTITIONS;
	const actual = {
		partitions: expected.map((partition) => ({
			id: partition.id,
			invokedApis: partition.productionApis.filter(
				(api) => api !== 'queryObservabilityEvents',
			),
			evidence: { proof: 'present' },
		})),
	};
	const errors = collectPartitionEvidenceErrors(actual, expected);
	expect(errors).toContain(
		'observability: production API was not invoked: queryObservabilityEvents',
	);
});

test('qualification gate rejects vacuous partition evidence when an assertion is removed', () => {
	const expected = SQLITE_EQUIVALENCE_PARTITIONS;
	const actual = {
		partitions: expected.map((partition) => ({
			id: partition.id,
			invokedApis: [...partition.productionApis],
			evidence: partition.id === 'observability' ? {} : { proof: 'present' },
		})),
	};
	const errors = collectPartitionEvidenceErrors(actual, expected);
	expect(errors).toContain('observability: evidence is vacuous');
});

test('qualification gate rejects a removed always-on recovery assertion for a declared partition', () => {
	const expected = SQLITE_EQUIVALENCE_PARTITIONS;
	const actual = {
		tables: expected.flatMap((partition) => partition.tables),
		partitions: expected
			.filter((partition) => partition.id !== 'coordination')
			.map((partition) => ({
				id: partition.id,
				tables: [...partition.tables],
				evidence: {
					recovered: true,
					tableCounts: Object.fromEntries(
						partition.tables.map((table) => [table, 1]),
					),
				},
			})),
	};
	const errors = collectPartitionRecoveryEvidenceErrors(actual, expected);
	expect(errors).toContain('missing partition recovery evidence: coordination');
});

test('qualification gate rejects a vacuous always-on recovery witness', () => {
	const expected = SQLITE_EQUIVALENCE_PARTITIONS;
	const actual = {
		tables: expected.flatMap((partition) => partition.tables),
		partitions: expected.map((partition) => ({
			id: partition.id,
			tables: [...partition.tables],
			evidence: {
				recovered: true,
				tableCounts: Object.fromEntries(
					partition.tables.map((table) => [table, 1]),
				),
				witness: {
					restored: partition.id !== 'observability',
					marker: `issue-2487-policy:${partition.id}`,
				},
			},
		})),
	};
	const errors = collectPartitionRecoveryEvidenceErrors(actual, expected);
	expect(errors).toContain(
		'observability: recovered production witness is missing',
	);
});
