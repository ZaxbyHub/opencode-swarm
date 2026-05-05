declare function isDebug(): boolean;
export declare function log(message: string, data?: unknown): void;
export declare function warn(message: string, data?: unknown): void;
export declare function error(message: string, data?: unknown): void;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    isDebug: typeof isDebug;
    log: typeof log;
    warn: typeof warn;
    error: typeof error;
};
export {};
