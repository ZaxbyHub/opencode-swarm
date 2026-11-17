import { test } from 'bun:test';
import { runReleaseAdmission } from './dispatch-3600-release-review-fixture';

test(
	'release recovery abort revokes a receipt from interrupted completion',
	() => runReleaseAdmission('RECOVERY_ABORT'),
	150_000,
);
