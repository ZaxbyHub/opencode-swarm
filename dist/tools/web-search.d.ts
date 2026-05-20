/**
 * web_search tool — owned by the architect for MODE: COUNCIL pre-search.
 *
 * Thin wrapper around `src/council/web-search-provider.ts`. Returns structured
 * results on success and structured errors on failure (never throws). Config-
 * gated on `council.general.enabled`. The provider itself surfaces missing-key
 * configuration via WebSearchConfigError, which this tool maps to a structured
 * `success: false` response.
 *
 * Hard cap on max_results = 10 (clamped silently). Default sourced from council.general.maxSourcesPerMember.
 */
import type { tool } from '@opencode-ai/plugin';
export declare const web_search: ReturnType<typeof tool>;
