import { test } from 'bun:test';
import { runReleaseAdmission } from './dispatch-3600-release-review-fixture';

test('release review merged', () => runReleaseAdmission('MERGED'), 150_000);
