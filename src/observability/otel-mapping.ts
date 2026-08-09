/**
 * External-convention attribute mappings (issue #2029 item 6).
 *
 * These are INERT LOOKUP TABLES. There is no OpenTelemetry SDK dependency, no
 * exporter, and no runtime consumer in this change: the tables are consumed as
 * data by the static contract check (which asserts every catalog entry records a
 * mapping decision) and by `docs/observability-event-contract.md`. The runtime
 * consumer lands in #2049.
 *
 * Import rules: no filesystem, network, subprocess, or OTel SDK.
 */
import type { OtelMappingKind } from './catalog.js';

/**
 * OpenTelemetry semantic-convention generation these GenAI attribute names track.
 *
 * Pinned SEPARATELY from `OBSERVABILITY_SCHEMA_VERSION`. That separation is the
 * whole point of issue #2029 item 6: the GenAI conventions are an external,
 * still-unstable vocabulary. If they were versioned together, an upstream rename
 * would force a bump of the internal envelope version and every consumer would
 * be told the domain shape changed when nothing about the domain changed.
 * External convention churn must never change internal domain state.
 */
export const OTEL_GENAI_MAPPING_VERSION = '1.29.0';

/**
 * OpenInference specification generation these attribute names track. Pinned
 * separately from both {@link OTEL_GENAI_MAPPING_VERSION} and
 * `OBSERVABILITY_SCHEMA_VERSION`, for the same reason.
 */
export const OPENINFERENCE_MAPPING_VERSION = '0.1.14';

/**
 * Prefix for an attribute this repository defines because the external
 * convention has no equivalent. Marked explicitly rather than squeezed into a
 * near-miss standard name, so a consumer is never misled about provenance.
 */
const SWARM_EXTENSION_PREFIX = 'swarm.';

/**
 * Internal envelope path to OTel GenAI attribute name.
 *
 * Keys are dotted paths into `ObservabilityEvent`. `legacy.raw.*` paths reach
 * into the aliased producer payload, which is where token counts and the
 * resolved model live today.
 */
export const OTEL_GENAI_ATTRIBUTES: Readonly<Record<string, string>> =
	Object.freeze({
		kind: 'gen_ai.operation.name',
		'provenance.provider': 'gen_ai.system',
		'provenance.model': 'gen_ai.request.model',
		'legacy.raw.model': 'gen_ai.response.model',
		'legacy.raw.agentName': 'gen_ai.agent.name',
		'workflow.hostSessionId': 'gen_ai.conversation.id',
		'outcome.status': 'gen_ai.response.finish_reasons',
		'legacy.raw.tokens_input': 'gen_ai.usage.input_tokens',
		'legacy.raw.tokens_output': 'gen_ai.usage.output_tokens',
		'legacy.raw.tokens_cache': 'gen_ai.usage.cache_read_input_tokens',
		// No GenAI convention exists for reasoning tokens at the pinned version,
		// so this is declared as a repository extension rather than mapped onto a
		// standard name it does not mean.
		'legacy.raw.tokens_reasoning': `${SWARM_EXTENSION_PREFIX}gen_ai.usage.reasoning_tokens`,
		'legacy.raw.cost_usd': `${SWARM_EXTENSION_PREFIX}gen_ai.usage.cost_usd`,
	});

/** Internal envelope path to OpenInference attribute name. */
export const OPENINFERENCE_ATTRIBUTES: Readonly<Record<string, string>> =
	Object.freeze({
		kind: 'openinference.span.kind',
		'provenance.model': 'llm.model_name',
		'provenance.provider': 'llm.provider',
		'legacy.raw.agentName': 'agent.name',
		'workflow.hostSessionId': 'session.id',
		'legacy.raw.tokens_input': 'llm.token_count.prompt',
		'legacy.raw.tokens_output': 'llm.token_count.completion',
		'legacy.raw.tokens_cache': 'llm.token_count.prompt_details.cache_read',
		'legacy.raw.tokens_reasoning':
			'llm.token_count.completion_details.reasoning',
		'legacy.raw.cost_usd': `${SWARM_EXTENSION_PREFIX}llm.cost_usd`,
	});

/** Shared empty table for entries that declare `otelMapping: 'none'`. */
const NO_ATTRIBUTES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Resolve the attribute table a catalog entry projects onto.
 *
 * `'none'` is a real, recorded decision — "this kind has no external
 * equivalent" — not a missing value. It returns an empty table, never
 * `undefined`, so a consumer never has to distinguish "no mapping" from "not
 * asked".
 */
export function mappingForEntry(
	mapping: OtelMappingKind,
): Readonly<Record<string, string>> {
	if (mapping === 'genai') return OTEL_GENAI_ATTRIBUTES;
	if (mapping === 'openinference') return OPENINFERENCE_ATTRIBUTES;
	return NO_ATTRIBUTES;
}
