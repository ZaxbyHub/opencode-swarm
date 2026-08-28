/** Deterministic clean overlap result for synthetic merge-back harnesses. */
export const cleanMergeOverlapSnapshot = {
	snapshot: {
		targetHead: '0'.repeat(40),
		laneHead: '1'.repeat(40),
		mergeBase: '0'.repeat(40),
		indexDigest: '',
		statusDigest: '',
		incomingDigest: '',
		overlapPaths: [],
	},
};
