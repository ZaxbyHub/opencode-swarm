import { test } from 'bun:test';
import { runReleaseAdmission } from './dispatch-3600-release-review-fixture';

test(
	'release review incomplete',
	() => runReleaseAdmission('INCOMPLETE'),
	150_000,
);
