/**
 * Preload script for Bun #32056 workaround.
 *
 * Bun's per-test --timeout cannot fire when a hung test leaves the event
 * loop idle (https://github.com/oven-sh/bun/issues/32056). This preload
 * starts a 1-second keepalive interval that wakes the event loop regularly,
 * allowing the timeout mechanism to work correctly.
 *
 * Loaded via `bun --smol test --preload <this-file>` by the CI wrapper.
 * The interval is cleared automatically when the bun process exits.
 */
setInterval(() => {}, 1000);
