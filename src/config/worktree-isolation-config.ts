import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from './constants';
import type { PluginConfig, WorktreeIsolationConfig } from './schema';

/**
 * Pure config helper that resolves the worktree-isolation configuration
 * from a PluginConfig. Lives in this leaf module (no heavy imports) so
 * the plugin entry (src/index.ts) can call it during init without
 * pulling in the worktree lifecycle module.
 *
 * @see tests/unit/turbo/lean/init-safety.test.ts (static source check)
 */
export function resolveWorktreeIsolationConfig(
	config: PluginConfig,
): WorktreeIsolationConfig {
	if (config.worktree) {
		return { ...DEFAULT_WORKTREE_ISOLATION_CONFIG, ...config.worktree };
	}
	const lean =
		config.turbo?.strategy === 'lean' ? config.turbo.lean : undefined;
	if (lean?.worktree_isolation) {
		return {
			...DEFAULT_WORKTREE_ISOLATION_CONFIG,
			policy: 'auto',
			merge_strategy: lean.merge_strategy ?? 'merge',
			worktree_dir: lean.worktree_dir,
			deps_strategy: lean.deps_strategy ?? 'skip',
			session_create_timeout_ms:
				DEFAULT_WORKTREE_ISOLATION_CONFIG.session_create_timeout_ms,
			runtime_isolation:
				lean.runtime_isolation ??
				DEFAULT_WORKTREE_ISOLATION_CONFIG.runtime_isolation,
		};
	}
	return DEFAULT_WORKTREE_ISOLATION_CONFIG;
}
