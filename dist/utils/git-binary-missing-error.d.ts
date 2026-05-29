export declare class GitBinaryMissingError extends Error {
    readonly name = "GitBinaryMissingError";
    constructor(message?: string, options?: {
        cause?: unknown;
    });
}
export declare function isGitBinaryMissing(err: unknown): err is {
    code?: string;
};
