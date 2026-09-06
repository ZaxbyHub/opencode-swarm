import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';

/**
 * Seed the store with a candidate and return the created record.
 *
 * The default `fetched_at` is derived from the monotonic clock at run time
 * (5 days before now): a hardcoded date here (2026-06-08) crossed the
 * 90-day TTL on 2026-09-06 and deterministically failed every
 * promote-success test on main (unit (ubuntu-latest, 1) on unrelated PRs).
 */
export async function seedCandidate(
	directory: string,
	overrides: {
		evaluation_verdict?: string;
		evaluation_history?: Array<{
			verdict: string;
			timestamp: string;
			actor: string;
			reason?: string;
			gate_results?: Array<{ gate: string; verdict: string }>;
			risk_assessment?: {
				total_flags: number;
				findings: Array<{ severity: string; category: string }>;
			};
		}>;
		skill_body?: string;
		sha256?: string;
		fetched_at?: string;
	},
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const skillBody =
		overrides.skill_body ??
		'This is a safe skill body with no dangerous patterns.';

	// Compute correct SHA-256 if not overridden, so provenance_integrity gate passes
	let sha256 = overrides.sha256;
	if (sha256 === undefined) {
		const { createHash } = await import('node:crypto');
		sha256 = createHash('sha256').update(skillBody).digest('hex');
	}

	const fetchedAt =
		overrides.fetched_at ??
		new Date(
			performance.timeOrigin + performance.now() - 5 * 86_400_000,
		).toISOString();

	return store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		sha256,
		fetched_at: fetchedAt,
		skill_name: 'test-skill',
		skill_body: skillBody,
		risk_flags: [],
		evaluation_verdict: (overrides.evaluation_verdict ??
			'passed') as ExternalSkillCandidate['evaluation_verdict'],
		evaluation_history: overrides.evaluation_history ?? [],
	});
}
