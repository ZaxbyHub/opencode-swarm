/**
 * external_skill_discover — Discover external skill candidates from configured sources.
 *
 * Fetches skill content from URLs or accepts manual imports, validates them
 * through the security gates (prompt-injection, unsafe-instructions,
 * provenance-integrity), and stores them as quarantined candidates in the
 * external skill store.
 *
 * Uses an `_internals` DI seam for testability — no `mock.module` leakage.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader.js';
import type {
	DiscoverySource,
	ExternalSkillCandidate,
	ExternalSkillsConfig,
} from '../config/schema.js';
import { createExternalSkillStore } from '../services/external-skill-store.js';
import { evaluateCandidate } from '../services/external-skill-validator.js';
import { createSwarmTool } from './create-tool.js';

// ---------------------------------------------------------------------------
// DI Seam — _internals
// ---------------------------------------------------------------------------

export const _internals = {
	fetchContent: async (
		_url: string,
		_timeoutMs: number,
	): Promise<{ content: string; finalUrl: string }> => {
		const response = await fetch(_url, {
			signal: AbortSignal.timeout(_timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}
		const content = await response.text();
		return { content, finalUrl: response.url };
	},
	getTimestamp: (): string => new Date().toISOString(),
	computeSha256: (content: string): string =>
		createHash('sha256').update(content).digest('hex'),
	uuid: (): string => randomUUID(),
};

// ---------------------------------------------------------------------------
// Trust level mapping (FR-004)
// ---------------------------------------------------------------------------

const SOURCE_TRUST_LEVELS: Record<string, 'low' | 'medium' | 'high'> = {
	github: 'low',
	url: 'low',
	collection: 'low',
	manual_import: 'medium',
};

// ---------------------------------------------------------------------------
// Source matching (FR-011)
// ---------------------------------------------------------------------------

/**
 * Safely compare a request URL against a configured source location,
 * preventing boundary bypass (e.g. `trusted.example.com.evil.com` matching
 * `trusted.example.com`).
 *
 * Returns true when the request URL is a sub-resource of (or exactly equal to)
 * the configured location, using origin + pathname boundary checking.
 */
function isSubpathUrl(requestUrl: string, configuredLocation: string): boolean {
	try {
		const configUrl = new URL(configuredLocation);
		const request = new URL(requestUrl);
		if (request.origin !== configUrl.origin) return false;
		const normalizedConfigPath = configUrl.pathname.replace(/\/$/, '');
		const normalizedRequestPath = request.pathname.replace(/\/$/, '');
		if (normalizedRequestPath === normalizedConfigPath) return true;
		if (normalizedRequestPath.startsWith(normalizedConfigPath + '/'))
			return true;
		return false;
	} catch {
		return false;
	}
}

/**
 * Match a provided source against configured discovery sources.
 *
 * - `manual_import`: Always allowed (user-initiated ad-hoc operation).
 * - For `url`/`github`/`collection`: If `config.sources` has entries, the
 *   provided `sourceUrl` must be a sub-resource of (or exactly equal to) the
 *   `location` of an enabled source whose `type` matches `sourceType`.
 *   Uses origin + pathname boundary checking to prevent bypass attacks.
 * - If `config.sources` is empty, any URL is allowed with default trust.
 *
 * Returns the matched DiscoverySource, or null when sources is empty
 * (caller should fall back to default trust). Throws for mismatched or
 * disabled sources.
 */
function matchSourceConfig(
	sourceType: string,
	sourceUrl: string,
	config: ExternalSkillsConfig,
): DiscoverySource | null {
	if (sourceType === 'manual_import') {
		return null;
	}

	const sources = config.sources ?? [];

	if (sources.length === 0) {
		return null;
	}

	const match = sources.find(
		(s: DiscoverySource) =>
			s.type === sourceType && isSubpathUrl(sourceUrl, s.location),
	);

	if (!match) {
		throw new Error(
			'Source not found in configured sources. Add it to external_skills.sources in your opencode config.',
		);
	}

	if (match.enabled === false) {
		throw new Error('Source is disabled in configuration.');
	}

	return match;
}

// ---------------------------------------------------------------------------
// Disabled message (shared across all external-skill stubs)
// ---------------------------------------------------------------------------

const DISABLED_MESSAGE =
	'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const external_skill_discover: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Discover external skill candidates from configured sources. Fetch content from a URL or provide inline content for manual import, validate through security gates, and store as a quarantined candidate.',
		args: {
			source_type: z
				.enum(['github', 'url', 'collection', 'manual_import'])
				.describe(
					'The type of source: github, url, collection, or manual_import',
				),
			source_url: z
				.string()
				.optional()
				.describe(
					'The URL to fetch content from (optional for manual_import, defaults to https://manual.local/import)',
				),
			content: z
				.string()
				.optional()
				.describe('The inline skill body content (required for manual_import)'),
			publisher: z
				.string()
				.min(1)
				.describe('The publisher or author of the skill'),
			skill_name: z.string().optional().describe('Optional name for the skill'),
			skill_description: z
				.string()
				.optional()
				.describe('Optional description of the skill'),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let sourceType: unknown;
			let sourceUrl: unknown;
			let content: unknown;
			let publisher: unknown;
			let skillName: unknown;
			let skillDescription: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					sourceType = obj.source_type;
					sourceUrl = obj.source_url;
					content = obj.content;
					publisher = obj.publisher;
					skillName = obj.skill_name;
					skillDescription = obj.skill_description;
				}
			} catch {
				// Malicious getter threw
			}

			// Resolve config — if curation is not enabled, return disabled message
			let config: ExternalSkillsConfig | undefined;
			try {
				const pluginConfig = loadPluginConfig(directory);
				config = pluginConfig.external_skills;
			} catch {
				return JSON.stringify({
					success: false,
					error: 'Failed to load plugin configuration',
				});
			}

			if (!config || !config.curation_enabled) {
				return DISABLED_MESSAGE;
			}

			// Validate source_type
			if (
				typeof sourceType !== 'string' ||
				!['github', 'url', 'collection', 'manual_import'].includes(sourceType)
			) {
				return JSON.stringify({
					success: false,
					error:
						'source_type is required and must be one of: github, url, collection, manual_import',
				});
			}

			// Validate publisher
			if (typeof publisher !== 'string' || publisher.trim().length === 0) {
				return JSON.stringify({
					success: false,
					error: 'publisher is required and must be a non-empty string',
				});
			}

			// For manual_import, content is required
			if (sourceType === 'manual_import') {
				if (typeof content !== 'string' || content.length === 0) {
					return JSON.stringify({
						success: false,
						error:
							'content is required for manual_import and must be a non-empty string',
					});
				}
			}

			// For url/github/collection, source_url is required
			if (
				sourceType !== 'manual_import' &&
				(typeof sourceUrl !== 'string' || sourceUrl.trim().length === 0)
			) {
				return JSON.stringify({
					success: false,
					error: `source_url is required for source_type '${sourceType as string}'`,
				});
			}

			// Create store and enforce rate limit
			const store = createExternalSkillStore(directory, {
				max_candidates: config.max_candidates,
			});

			try {
				const existing = await store.list();
				if (existing.length >= config.max_candidates_per_discovery) {
					return JSON.stringify({
						success: false,
						error: `Rate limit exceeded: ${existing.length} candidates already exist (max_candidates_per_discovery: ${config.max_candidates_per_discovery})`,
					});
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to check rate limit: ${message}`,
				});
			}

			// Resolve the URL early (needed for source matching)
			const resolvedUrl =
				typeof sourceUrl === 'string' && sourceUrl.length > 0
					? sourceUrl
					: 'https://manual.local/import';

			// Match source against configured sources BEFORE fetch (FR-011)
			// Rejects unconfigured / disabled sources without triggering network I/O.
			let matchedSource: DiscoverySource | null;
			try {
				matchedSource = matchSourceConfig(
					sourceType as string,
					resolvedUrl,
					config,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: message,
				});
			}

			// Fetch content (only for url/github/collection — manual_import uses content)
			let resolvedContent: string;

			if (sourceType === 'manual_import') {
				resolvedContent = content as string;
			} else {
				try {
					const fetched = await _internals.fetchContent(
						resolvedUrl,
						config.fetch_timeout_ms,
					);
					// Validate redirect destination against source config (FR-011)
					if (
						fetched.finalUrl !== resolvedUrl &&
						matchedSource &&
						!isSubpathUrl(fetched.finalUrl, matchedSource.location)
					) {
						return JSON.stringify({
							success: false,
							error: `Redirect destination ${fetched.finalUrl} is not within configured source ${matchedSource.location}. Possible redirect attack.`,
						});
					}
					resolvedContent = fetched.content;
				} catch (err) {
					const message = err instanceof Error ? err.message : 'Unknown error';
					return JSON.stringify({
						success: false,
						error: `Failed to fetch content from ${resolvedUrl}: ${message}`,
					});
				}
			}

			// Reject oversized content
			if (resolvedContent.length > config.max_bytes_per_candidate) {
				return JSON.stringify({
					success: false,
					error: `Content too large: ${resolvedContent.length} bytes exceeds max_bytes_per_candidate (${config.max_bytes_per_candidate})`,
				});
			}

			// Compute SHA-256
			const sha256 = _internals.computeSha256(resolvedContent);

			// Build candidate object — use a placeholder id for validation;
			// the store generates the real id on add().
			const candidate: ExternalSkillCandidate = {
				id: _internals.uuid(),
				source_url: resolvedUrl,
				source_type: sourceType as ExternalSkillCandidate['source_type'],
				publisher: publisher as string,
				sha256,
				fetched_at: _internals.getTimestamp(),
				skill_name: typeof skillName === 'string' ? skillName : undefined,
				skill_description:
					typeof skillDescription === 'string' ? skillDescription : undefined,
				skill_body: resolvedContent,
				risk_flags: [],
				evaluation_verdict: 'pending',
				evaluation_history: [],
			};

			// Resolve trust level from matched source, falling back to defaults
			const trustLevel =
				matchedSource?.trust_level ??
				SOURCE_TRUST_LEVELS[sourceType as string] ??
				'low';

			// Run validation gates
			const result = evaluateCandidate(candidate, {
				trust_level: trustLevel,
				ttl_days: config.ttl_days,
			});

			// Update candidate based on evaluation results
			candidate.risk_flags = result.risk_flags;
			candidate.evaluation_verdict = result.overall_verdict;
			candidate.evaluation_history = [
				{
					verdict: result.overall_verdict,
					timestamp: _internals.getTimestamp(),
					actor: 'system',
					reason: `Validation: ${result.gate_results.length} gates, ${result.all_findings.length} findings`,
					gate_results: result.gate_results.map((gr) => ({
						gate: gr.gate,
						verdict: gr.verdict,
					})),
					risk_assessment: {
						total_flags: result.risk_flags?.length ?? 0,
						findings:
							result.all_findings?.map((f) => ({
								severity: f.severity,
								category: f.pattern,
							})) ?? [],
					},
				},
			];

			// Store candidate
			let stored: ExternalSkillCandidate;
			try {
				stored = await store.add(candidate);
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to store candidate: ${message}`,
				});
			}

			// Build gate summary
			const gateSummary = result.gate_results.map((gr) => ({
				gate: gr.gate,
				verdict: gr.verdict,
				findings_count: gr.findings.length,
			}));

			return JSON.stringify({
				success: true,
				candidate_id: stored.id,
				evaluation_verdict: result.overall_verdict,
				risk_flags_count: result.risk_flags.length,
				gate_results: gateSummary,
			});
		},
	});
