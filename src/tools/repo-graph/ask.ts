import { isAssetEdge } from './builder';
import type {
	AskHit,
	AskOptions,
	AskResult,
	GraphNode,
	RepoGraph,
} from './types';
import { inferPackageBoundary, normalizeGraphPath } from './types';

const DEFAULT_TOP_N = 8;
const MAX_TOP_N = 25;
const ALPHA = 0.25;
const MAX_ITERATIONS = 25;
const CONVERGENCE_THRESHOLD = 1e-6;

const FIELD_WEIGHTS = { moduleName: 3, exports: 2, imports: 1 } as const;
const TEST_PATH_FACTOR = 0.35;
const TEST_PATH_RE =
	/(?:^|[/\\])(?:tests?|__tests?__|spec|__spec__|__mocks?__)[/\\]|\.(?:test|spec|stories)\./i;

function tokenize(text: string): string[] {
	const raw = text
		.replace(/[^a-zA-Z0-9_]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1);
	const expanded: string[] = [];
	for (const token of raw) {
		expanded.push(token.toLowerCase());
		for (const sub of splitCompound(token)) {
			const lower = sub.toLowerCase();
			if (lower !== token.toLowerCase()) expanded.push(lower);
		}
	}
	return [...new Set(expanded)];
}

function splitCompound(token: string): string[] {
	const parts: string[] = [];
	// camelCase / PascalCase split
	const camel = token.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/);
	if (camel.length > 1) {
		for (const p of camel) if (p.length > 1) parts.push(p);
	}
	// snake_case split
	const snake = token.split('_');
	if (snake.length > 1) {
		for (const p of snake) if (p.length > 1) parts.push(p);
	}
	return parts;
}

function buildVocabulary(graph: RepoGraph): Set<string> {
	const vocab = new Set<string>();
	for (const node of Object.values(graph.nodes)) {
		for (const sub of splitCompound(node.moduleName)) {
			vocab.add(sub.toLowerCase());
		}
		const baseName = node.moduleName
			.replace(/^.*[/\\]/, '')
			.replace(/\.[^.]+$/, '');
		vocab.add(baseName.toLowerCase());
		for (const exp of node.exports) {
			vocab.add(exp.toLowerCase());
			for (const sub of splitCompound(exp)) vocab.add(sub.toLowerCase());
		}
		if (node.ontology) {
			for (const role of node.ontology.roles) vocab.add(role.toLowerCase());
		}
	}
	return vocab;
}

function expandTerms(tokens: string[], vocab: Set<string>): string[] {
	const expanded = new Set<string>();
	for (const token of tokens) {
		if (vocab.has(token)) expanded.add(token);
		for (const sub of splitCompound(token)) {
			const lower = sub.toLowerCase();
			if (vocab.has(lower)) expanded.add(lower);
		}
	}
	return [...expanded].sort();
}

function computeIDF(term: string, nodes: GraphNode[]): number {
	let docFreq = 0;
	const lower = term.toLowerCase();
	for (const node of nodes) {
		const moduleLower = node.moduleName.toLowerCase();
		const baseName = moduleLower
			.replace(/^.*[/\\]/, '')
			.replace(/\.[^.]+$/, '');
		if (
			moduleLower.includes(lower) ||
			baseName === lower ||
			node.exports.some((e) => e.toLowerCase().includes(lower)) ||
			node.imports.some((i) => i.toLowerCase().includes(lower))
		) {
			docFreq++;
		}
	}
	if (docFreq === 0) return 0;
	return Math.log((nodes.length + 1) / (docFreq + 1)) + 1;
}

function lexicalScore(
	node: GraphNode,
	terms: string[],
	idfMap: Map<string, number>,
): { score: number; matchedTerms: string[] } {
	let score = 0;
	const matched: string[] = [];
	const moduleLower = node.moduleName.toLowerCase();
	const baseName = moduleLower.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '');

	for (const term of terms) {
		const idf = idfMap.get(term) ?? 0;
		if (idf === 0) continue;
		let termScore = 0;

		if (moduleLower.includes(term) || baseName === term) {
			termScore += FIELD_WEIGHTS.moduleName * idf;
		}
		if (node.exports.some((e) => e.toLowerCase().includes(term))) {
			termScore += FIELD_WEIGHTS.exports * idf;
		}
		if (node.imports.some((i) => i.toLowerCase().includes(term))) {
			termScore += FIELD_WEIGHTS.imports * idf;
		}

		if (termScore > 0) {
			score += termScore;
			matched.push(term);
		}
	}

	if (TEST_PATH_RE.test(node.moduleName)) {
		score *= TEST_PATH_FACTOR;
	}

	return { score, matchedTerms: matched };
}

function buildUndirectedAdjacency(
	graph: RepoGraph,
	nodeKeys: string[],
): Map<string, Set<string>> {
	const adj = new Map<string, Set<string>>();
	for (const key of nodeKeys) adj.set(key, new Set());
	for (const edge of graph.edges) {
		if (isAssetEdge(edge)) continue;
		const s = normalizeGraphPath(edge.source);
		const t = normalizeGraphPath(edge.target);
		if (adj.has(s) && adj.has(t)) {
			adj.get(s)!.add(t);
			adj.get(t)!.add(s);
		}
	}
	return adj;
}

function personalizedPageRank(
	adj: Map<string, Set<string>>,
	restart: Map<string, number>,
	nodeKeys: string[],
): Map<string, number> {
	const n = nodeKeys.length;
	if (n === 0) return new Map();

	let scores = new Map<string, number>();
	for (const key of nodeKeys) scores.set(key, restart.get(key) ?? 0);

	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		const next = new Map<string, number>();
		for (const key of nodeKeys) next.set(key, 0);

		let danglingMass = 0;
		for (const key of nodeKeys) {
			const neighbors = adj.get(key);
			if (!neighbors || neighbors.size === 0) {
				danglingMass += scores.get(key) ?? 0;
			} else {
				const share = (scores.get(key) ?? 0) / neighbors.size;
				for (const neighbor of neighbors) {
					next.set(neighbor, (next.get(neighbor) ?? 0) + share);
				}
			}
		}

		const danglingShare = danglingMass / n;

		// ALPHA = walk weight (graph re-rank); (1-ALPHA) = restart weight (lexical seed)
		let l1Delta = 0;
		for (const key of nodeKeys) {
			const damped =
				(1 - ALPHA) * (restart.get(key) ?? 0) +
				ALPHA * ((next.get(key) ?? 0) + danglingShare);
			l1Delta += Math.abs(damped - (scores.get(key) ?? 0));
			next.set(key, damped);
		}

		scores = next;
		if (l1Delta < CONVERGENCE_THRESHOLD) break;
	}

	return scores;
}

export function askGraph(
	graph: RepoGraph,
	question: string,
	options: AskOptions = {},
): AskResult {
	const topN = Math.min(options.topN ?? DEFAULT_TOP_N, MAX_TOP_N);
	const nodes = Object.values(graph.nodes);
	const nodeKeys = Object.keys(graph.nodes).sort();

	if (!question.trim() || nodes.length === 0) {
		return {
			hits: [],
			expandedTerms: [],
			budget: { requested: topN, returned: 0, dropped: 0 },
		};
	}

	const vocab = buildVocabulary(graph);
	const rawTokens = tokenize(question);
	const expandedTerms = expandTerms(rawTokens, vocab);

	if (expandedTerms.length === 0) {
		return {
			hits: [],
			expandedTerms: [],
			budget: { requested: topN, returned: 0, dropped: 0 },
		};
	}

	// Compute IDF for each expanded term
	const idfMap = new Map<string, number>();
	for (const term of expandedTerms) {
		idfMap.set(term, computeIDF(term, nodes));
	}

	// Compute lexical scores for each node
	const lexScores = new Map<
		string,
		{ score: number; matchedTerms: string[] }
	>();
	let totalLexScore = 0;
	for (const key of nodeKeys) {
		const node = graph.nodes[key];
		const result = lexicalScore(node, expandedTerms, idfMap);
		lexScores.set(key, result);
		totalLexScore += result.score;
	}

	// Build restart vector (normalized lexical scores)
	const restart = new Map<string, number>();
	if (totalLexScore > 0) {
		for (const key of nodeKeys) {
			restart.set(key, (lexScores.get(key)?.score ?? 0) / totalLexScore);
		}
	} else {
		const uniform = 1 / nodeKeys.length;
		for (const key of nodeKeys) restart.set(key, uniform);
	}

	// Build adjacency and run PageRank
	const adj = buildUndirectedAdjacency(graph, nodeKeys);
	const prScores = personalizedPageRank(adj, restart, nodeKeys);

	// Rank and build hits
	const scored: { key: string; score: number; matchedTerms: string[] }[] = [];
	for (const key of nodeKeys) {
		const pr = prScores.get(key) ?? 0;
		const lex = lexScores.get(key);
		if (pr > 0 || (lex && lex.score > 0)) {
			scored.push({
				key,
				score: Math.round(pr * 1e6) / 1e6,
				matchedTerms: lex?.matchedTerms ?? [],
			});
		}
	}

	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.key.localeCompare(b.key);
	});

	const total = scored.length;
	const topHits = scored.slice(0, topN);

	const hits: AskHit[] = topHits.map(({ key, score, matchedTerms }) => {
		const node = graph.nodes[key];
		return {
			file: node.moduleName,
			score,
			matchedTerms,
			topExports: node.exports.slice(0, 5),
			role: node.ontology?.roles[0] ?? 'source_module',
			community:
				node.ontology?.packageBoundary ?? inferPackageBoundary(node.moduleName),
		};
	});

	return {
		hits,
		expandedTerms,
		budget: {
			requested: topN,
			returned: hits.length,
			dropped: Math.max(0, total - topN),
		},
	};
}

export const _internals = {
	tokenize,
	splitCompound,
	expandTerms,
	buildVocabulary,
	computeIDF,
	lexicalScore,
	personalizedPageRank,
	buildUndirectedAdjacency,
};
