/**
 * Unified Injection Budget Pool (WP5, issue #1234).
 *
 * Coordinates char budgets across all injection systems that share the
 * same LLM context window. Two pool scopes exist:
 *   - Architect pool (messagesTransform): memory recall + knowledge + curator briefing
 *   - Delegate pool (tool.execute.before): delegate directives + skill recommendations
 *
 * Each source has a proportional share. Draws are first-come-first-served,
 * capped at the source's share (or minChars if higher). Pools are created
 * fresh each hook-chain invocation (per-request), so commit() is available
 * for multi-pass scenarios but not required in the current single-pass flow.
 *
 * Architecture decision (WP5): Memory = episodic recall (auto-retrieved),
 * Knowledge = enforceable directives (curator-curated, compliance-tracked).
 * Formally partitioned, not converged.
 */

export type InjectionSourceId =
	| 'knowledge_directives'
	| 'curator_briefing'
	| 'memory_recall'
	| 'delegate_directives'
	| 'skill_recommendations';

export interface InjectionSourceConfig {
	id: InjectionSourceId;
	share: number;
	minChars: number;
}

export interface InjectionBudgetPool {
	readonly totalBudget: number;
	readonly remaining: number;
	allocate(sourceId: InjectionSourceId, requestedChars: number): number;
	commit(sourceId: InjectionSourceId, usedChars: number): void;
	getShare(sourceId: InjectionSourceId): number;
	snapshot(): Record<
		string,
		{ share: number; allocated: number; committed: number }
	>;
}

export const DEFAULT_ARCHITECT_SOURCES: InjectionSourceConfig[] = [
	{ id: 'knowledge_directives', share: 0.45, minChars: 300 },
	{ id: 'memory_recall', share: 0.4, minChars: 200 },
	{ id: 'curator_briefing', share: 0.15, minChars: 0 },
];

export const DEFAULT_DELEGATE_SOURCES: InjectionSourceConfig[] = [
	{ id: 'delegate_directives', share: 0.6, minChars: 200 },
	{ id: 'skill_recommendations', share: 0.4, minChars: 200 },
];

class InjectionBudgetPoolImpl implements InjectionBudgetPool {
	readonly totalBudget: number;
	private readonly shares: Map<InjectionSourceId, number>;
	private readonly minChars: Map<InjectionSourceId, number>;
	private readonly allocated: Map<InjectionSourceId, number> = new Map();
	private readonly committed: Map<InjectionSourceId, number> = new Map();
	private usedTotal = 0;

	constructor(totalBudget: number, sources: InjectionSourceConfig[]) {
		this.totalBudget = totalBudget;
		this.shares = new Map();
		this.minChars = new Map();
		for (const src of sources) {
			this.shares.set(src.id, Math.floor(totalBudget * src.share));
			this.minChars.set(src.id, src.minChars);
		}
	}

	get remaining(): number {
		return Math.max(0, this.totalBudget - this.usedTotal);
	}

	getShare(sourceId: InjectionSourceId): number {
		return this.shares.get(sourceId) ?? 0;
	}

	allocate(sourceId: InjectionSourceId, requestedChars: number): number {
		if (requestedChars <= 0) return 0;
		const share = this.shares.get(sourceId) ?? 0;
		const min = this.minChars.get(sourceId) ?? 0;
		const alreadyAllocated = this.allocated.get(sourceId) ?? 0;

		const shareRemaining = Math.max(0, share - alreadyAllocated);
		const poolRemaining = this.remaining;

		// Grant up to share remaining (capped by pool remaining), or minChars floor if higher
		const available = Math.max(
			Math.min(shareRemaining, poolRemaining),
			Math.min(min, poolRemaining),
		);
		const granted = Math.min(requestedChars, available);

		this.allocated.set(sourceId, alreadyAllocated + granted);
		this.usedTotal += granted;
		return granted;
	}

	commit(sourceId: InjectionSourceId, usedChars: number): void {
		const alloc = this.allocated.get(sourceId) ?? 0;
		const actual = Math.min(usedChars, alloc);
		this.committed.set(sourceId, actual);
		const returned = alloc - actual;
		if (returned > 0) {
			this.usedTotal = Math.max(0, this.usedTotal - returned);
		}
	}

	snapshot(): Record<
		string,
		{ share: number; allocated: number; committed: number }
	> {
		const result: Record<
			string,
			{ share: number; allocated: number; committed: number }
		> = {};
		for (const [id, share] of this.shares) {
			result[id] = {
				share,
				allocated: this.allocated.get(id) ?? 0,
				committed: this.committed.get(id) ?? 0,
			};
		}
		return result;
	}
}

export function createInjectionBudgetPool(
	totalBudget: number,
	sources: InjectionSourceConfig[],
): InjectionBudgetPool {
	return new InjectionBudgetPoolImpl(totalBudget, sources);
}

export function applyShareOverrides(
	sources: InjectionSourceConfig[],
	overrides: Record<string, number> | undefined,
): InjectionSourceConfig[] {
	if (!overrides || Object.keys(overrides).length === 0) return sources;
	return sources.map((src) => {
		const override = overrides[src.id];
		if (override !== undefined && override >= 0 && override <= 1) {
			return { ...src, share: override };
		}
		return src;
	});
}

export const _internals = {
	createInjectionBudgetPool,
	applyShareOverrides,
};
