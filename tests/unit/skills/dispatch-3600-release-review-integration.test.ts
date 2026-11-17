import { test } from 'bun:test';
import { runReleaseAdmission } from './dispatch-3600-release-review-fixture';

test('release review approve', () => runReleaseAdmission('APPROVE'), 150_000);
