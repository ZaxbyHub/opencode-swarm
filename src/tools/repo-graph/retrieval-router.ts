import { askGraph } from './ask';
import { buildTestPack, traceData, traceRoute } from './pack-query';
import { buildOntologyPreflightPacket, getCallers } from './query';
import {
	explainGraphEntry,
	getDiffContext,
	getImpactCone,
	searchSymbols,
} from './symbol-query';
import type { RepoGraph, RouteMethod } from './types';

export const RETRIEVAL_MODES = [
	'graph',
	'lexical',
	'semantic',
	'security',
	'test',
	'hybrid',
] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
export const ROUTER_METADATA_OVERHEAD_TOKENS = 2048;

export interface RetrievalRequest {
	question: string;
	file?: string;
	files?: string[];
	symbol?: string;
	diff?: string;
	entity?: string;
	routePath?: string;
	method?: RouteMethod;
	maxTokens?: number;
	topN?: number;
}

export interface LexicalResult {
	matches?: unknown[];
	total?: number;
	truncated?: boolean;
	engine?: string;
	warning?: string;
	error?: boolean;
}

export interface RetrievalResult {
	mode: RetrievalMode;
	algorithm: 'literal' | 'graph' | 'fuzzy_graph' | 'graph_packs' | 'mixed';
	reason: string;
	actions: string[];
	graphHit: boolean;
	fallbackReason: string | null;
	context: Array<{ action: string; data: unknown }>;
	explanation: string[];
	warnings: string[];
	budget: {
		requestedTokens: number;
		usedTokens: number;
		omittedContextCount: number;
		metadataOverheadTokens: number;
	};
}

const MODE_METADATA: Record<
	RetrievalMode,
	{ algorithm: RetrievalResult['algorithm'] }
> = {
	graph: { algorithm: 'graph' },
	lexical: { algorithm: 'literal' },
	semantic: { algorithm: 'fuzzy_graph' },
	security: { algorithm: 'graph_packs' },
	test: { algorithm: 'graph_packs' },
	hybrid: { algorithm: 'mixed' },
};

export function classifyRetrieval(question: string): {
	mode: RetrievalMode;
	reason: string;
} {
	const q = question.toLowerCase();
	if (
		/\b(exact|literal|find\s+(?:the\s+)?string)\b/.test(q) ||
		/[`"'][^`"']+[`"']/.test(question)
	)
		return { mode: 'lexical', reason: 'exact_string_cue' };
	if (/\b(review|diff|patch|pull request|pr)\b/.test(q))
		return { mode: 'hybrid', reason: 'review_or_diff_cue' };
	if (/\b(test|tests|spec|fixture|coverage)\b/.test(q))
		return { mode: 'test', reason: 'test_cue' };
	if (/\b(auth|security|permission|authorize|validation|risk)\b/.test(q))
		return { mode: 'security', reason: 'security_cue' };
	if (
		/\b(who calls|caller|dependency|dependencies|impact|breaks? if|structural)\b/.test(
			q,
		)
	)
		return { mode: 'graph', reason: 'structural_cue' };
	if (/\b(where|how)\b.*\b(implemented|defined|handled|works)\b/.test(q))
		return { mode: 'hybrid', reason: 'feature_discovery_cue' };
	return { mode: 'semantic', reason: 'vague_discovery_default' };
}

function literalFrom(question: string, req: RetrievalRequest): string {
	const match = question.match(/[`"']([^`"']+)[`"']/);
	return (match?.[1] || req.symbol || req.entity || req.file || question)
		.trim()
		.slice(0, 500);
}

function hasArray(value: unknown, key: string): boolean {
	return Boolean(
		value &&
			typeof value === 'object' &&
			Array.isArray((value as Record<string, unknown>)[key]) &&
			((value as Record<string, unknown>)[key] as unknown[]).length > 0,
	);
}

function hasActionContext(action: string, value: unknown): boolean {
	if (action === 'callers') return Array.isArray(value) && value.length > 0;
	if (action === 'diff_context' && value && typeof value === 'object') {
		const result = value as Record<string, unknown>;
		const files = Array.isArray(result.files) ? result.files : [];
		const impact =
			result.impact && typeof result.impact === 'object'
				? (result.impact as Record<string, unknown>)
				: {};
		return (
			files.some(
				(file) =>
					file &&
					typeof file === 'object' &&
					(file as Record<string, unknown>).known === true,
			) ||
			(Array.isArray(impact.files) && impact.files.length > 0) ||
			(Array.isArray(impact.tests) && impact.tests.length > 0)
		);
	}
	const evidenceKeys: Record<string, string[]> = {
		impact_cone: [
			'entries',
			'tests',
			'routes',
			'dataFacts',
			'securityFacts',
			'boundaries',
		],
		route_trace: ['routes'],
		data_trace: [
			'readers',
			'writers',
			'deleters',
			'configurers',
			'routes',
			'tests',
		],
		preflight_packet: [
			'targets',
			'findings',
			'routes',
			'dataOperations',
			'security',
		],
		test_pack: ['tests', 'fixtures', 'helpers', 'associations'],
		graph_explain: ['entries', 'edges'],
	};
	return (evidenceKeys[action] ?? []).some((key) => hasArray(value, key));
}

function tokenEstimate(value: unknown): number {
	return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

function packContext(
	items: Array<{ action: string; data: unknown }>,
	maxTokens: number,
) {
	const context: Array<{ action: string; data: unknown }> = [];
	let used = 0;
	for (const item of items) {
		const cost = tokenEstimate(item);
		if (used + cost > maxTokens) continue;
		context.push(item);
		used += cost;
	}
	return { context, used, omitted: items.length - context.length };
}

export async function routeRetrieval(
	graph: RepoGraph | null,
	request: RetrievalRequest,
	lexical: (query: string) => Promise<LexicalResult>,
	graphUnavailableReason?: string,
): Promise<RetrievalResult> {
	const classified = classifyRetrieval(request.question);
	const requestedFiles = request.files?.length ? request.files : undefined;
	const mode: RetrievalMode =
		request.routePath || request.method || request.entity
			? 'security'
			: request.diff || requestedFiles
				? classified.mode === 'test'
					? 'test'
					: 'hybrid'
				: request.file || request.symbol
					? classified.mode === 'security' || classified.mode === 'test'
						? classified.mode
						: 'graph'
					: classified.mode;
	const reason =
		mode === classified.mode
			? classified.reason
			: request.routePath || request.method || request.entity
				? 'explicit_security_hint'
				: request.diff || requestedFiles
					? 'explicit_change_scope'
					: 'explicit_graph_target';
	const actions: string[] = [];
	const candidates: Array<{ action: string; data: unknown }> = [];
	const warnings: string[] = [];
	let graphHit = false;
	let fallbackReason: string | null = null;
	const topN = Math.max(
		1,
		Math.min(25, request.topN ?? Math.floor((request.maxTokens ?? 4000) / 200)),
	);

	if (mode !== 'lexical' && graph) {
		switch (mode) {
			case 'graph': {
				if (
					request.symbol &&
					/\b(who calls|caller)\b/i.test(request.question)
				) {
					const hits = searchSymbols(graph, { query: request.symbol, topN: 1 });
					const hit = hits.hits[0];
					const data = hit ? getCallers(graph, hit.file, hit.symbol) : [];
					actions.push('symbol_search', 'callers');
					candidates.push({ action: 'callers', data });
					graphHit = hasActionContext('callers', data);
				} else if (request.file) {
					const data = getImpactCone(graph, {
						file: request.file,
						symbol: request.symbol,
						maxDepth: 3,
						topN,
					});
					actions.push('impact_cone');
					candidates.push({ action: 'impact_cone', data });
					graphHit = hasActionContext('impact_cone', data);
				} else {
					const data = askGraph(graph, request.question, { topN });
					actions.push('ask');
					candidates.push({ action: 'ask', data });
					graphHit = data.hits.length > 0;
				}
				break;
			}
			case 'semantic': {
				const data = askGraph(graph, request.question, { topN });
				actions.push('ask');
				candidates.push({ action: 'ask', data });
				graphHit = data.hits.length > 0;
				break;
			}
			case 'security': {
				const ask =
					request.routePath ||
					request.method ||
					request.file ||
					request.symbol ||
					request.entity
						? null
						: askGraph(graph, request.question, { topN });
				const data =
					request.routePath || request.method || request.file || request.symbol
						? traceRoute(graph, {
								routePath: request.routePath,
								file: request.file,
								symbol: request.symbol,
								method: request.method,
								topN,
							})
						: request.entity
							? traceData(graph, { entity: request.entity, topN })
							: ask?.hits.length
								? buildOntologyPreflightPacket(
										graph,
										ask.hits.map((h) => h.file),
										{ maxFiles: topN },
									)
								: { targets: [] };
				actions.push(
					request.entity
						? 'data_trace'
						: request.routePath || request.file || request.symbol
							? 'route_trace'
							: 'preflight_packet',
				);
				candidates.push({ action: actions.at(-1)!, data });
				graphHit = hasActionContext(actions.at(-1)!, data);
				break;
			}
			case 'test': {
				const files =
					requestedFiles ??
					(request.file
						? [request.file]
						: askGraph(graph, request.question, { topN }).hits.map(
								(h) => h.file,
							));
				const data = buildTestPack(graph, {
					files,
					symbol: request.symbol,
					diff: request.diff,
					topN,
				});
				actions.push('test_pack');
				candidates.push({ action: 'test_pack', data });
				graphHit = hasActionContext('test_pack', data);
				break;
			}
			case 'hybrid': {
				if (request.diff || requestedFiles || request.file) {
					const files =
						requestedFiles ?? (request.file ? [request.file] : undefined);
					const diff = getDiffContext(graph, {
						files,
						diff: request.diff,
						maxDepth: 2,
						topN,
					});
					const tests = buildTestPack(graph, {
						files,
						symbol: request.symbol,
						diff: request.diff,
						topN,
					});
					actions.push('diff_context', 'test_pack');
					candidates.push(
						{ action: 'diff_context', data: diff },
						{ action: 'test_pack', data: tests },
					);
					graphHit =
						hasActionContext('diff_context', diff) ||
						hasActionContext('test_pack', tests);
				} else {
					const ask = askGraph(graph, request.question, { topN });
					actions.push('ask');
					candidates.push({ action: 'ask', data: ask });
					if (ask.hits[0]) {
						const exp = explainGraphEntry(graph, {
							file: ask.hits[0].file,
							topN,
						});
						actions.push('graph_explain');
						candidates.push({ action: 'graph_explain', data: exp });
					}
					graphHit = ask.hits.length > 0;
				}
				break;
			}
		}
	}

	if (mode === 'lexical' || !graphHit) {
		fallbackReason =
			mode === 'lexical' ? null : (graphUnavailableReason ?? 'graph_miss');
		const data = await lexical(literalFrom(request.question, request));
		actions.push('lexical_search');
		candidates.push({ action: 'lexical_search', data });
		if (data.warning) warnings.push(data.warning);
	}
	const maxTokens = request.maxTokens ?? 4000;
	const packed = packContext(candidates, maxTokens);
	return {
		mode,
		algorithm: MODE_METADATA[mode].algorithm,
		reason,
		actions: actions.slice(0, 8),
		graphHit,
		fallbackReason,
		context: packed.context,
		explanation: [
			`classified:${reason}`,
			...actions.map((a) => `action:${a}`),
		].slice(0, 8),
		warnings: warnings.slice(0, 8),
		budget: {
			requestedTokens: maxTokens,
			usedTokens: packed.used,
			omittedContextCount: packed.omitted,
			metadataOverheadTokens: ROUTER_METADATA_OVERHEAD_TOKENS,
		},
	};
}
