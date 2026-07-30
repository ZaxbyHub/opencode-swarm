# Checkpoint config documentation for auto_checkpoint_threshold (issue #1660)

## What

CheckpointConfigSchema.auto_checkpoint_threshold now carries a Zod .describe() so that help surfaces, /swarm config, and schema introspection tools can render a human-readable description without guessing.

## Why

The field had no schema-level description. Operators configuring checkpoint.auto_checkpoint_threshold in opencode-swarm.json saw only the raw type (number) and constraints (min: 1, max: 20) - nothing explaining what the value *does* (retention cap) or what happens at the boundary (oldest evicted).

## Fix

- Added .describe() after .default(3) on the auto_checkpoint_threshold Zod chain with text: Maximum number of checkpoints to retain. Oldest checkpoints are evicted when this limit is exceeded.
- SC-006 test assertion verifies the .description accessor returns the expected text via CheckpointConfigSchema.out.shape.auto_checkpoint_threshold.description.

## Behavior / compatibility

- No behavior change. The default (3), type (number), and validation bounds (min(1).max(20)) are unchanged.
- Existing checkpoint configurations are preserved with no migration required.
- Existing checkpoint tests pass unmodified (SC-007).
