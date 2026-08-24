import type { ReviewDiffManifest } from '../../src/review/diff-source';

export function createReviewManifest(
	hash = 'd'.repeat(64),
): ReviewDiffManifest {
	return {
		schema_version: 2,
		hash,
		content_hash: 'e'.repeat(64),
		selector: { kind: 'default' },
		selector_key: 'default',
		review_target_kind: 'checkout-history-index-working-tree',
		completeness: { complete: true, truncated: false, skip_reason_codes: [] },
		path_records: [],
	};
}
