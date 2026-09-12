import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
	MAX_REPORT_BYTES,
	verifyReports,
} from '../../../../scripts/ci/verify-repository-validation-reports';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

describe('issue #2675 report size bounds', () => {
	test('rejects oversized report artifacts before parsing or unbounded allocation', () => {
		const root = canonicalMkdtemp('validation-verifier-');
		try {
			const reports = path.join(root, 'reports');
			mkdirSync(reports);
			writeFileSync(
				path.join(reports, 'unit-shard-1-0.json'),
				'x'.repeat(MAX_REPORT_BYTES + 1),
				'utf8',
			);
			expect(() =>
				verifyReports({
					directory: reports,
					root,
					surface: 'unit',
					filePrefix: 'unit-shard-1-',
				}),
			).toThrow(`JSON report exceeds ${MAX_REPORT_BYTES} bytes`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
