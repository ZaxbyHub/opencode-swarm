# Codex skill adapters for repo workflows

- Added Codex-native `.agents/skills/` adapters for the existing `.opencode` and `.claude` repository skills so Codex can discover and trigger the same workflows from this repo.
- The adapters point at the canonical source skills instead of duplicating long bodies, with Codex-specific tool guidance for shell execution, `apply_patch`, `multi_tool_use.parallel`, validation, and review behavior.
- Added `agents/openai.yaml` metadata for the Codex-facing skills to improve skill list display and default prompts.
