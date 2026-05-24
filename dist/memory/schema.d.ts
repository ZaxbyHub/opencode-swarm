import { z } from 'zod';
import type { MemoryKind, MemoryProposal, MemoryRecord, MemoryScopeRef } from './types';
export declare const MemoryScopeTypeSchema: z.ZodEnum<{
    agent: "agent";
    project: "project";
    run: "run";
    global_user: "global_user";
    workspace: "workspace";
    repository: "repository";
}>;
export declare const MemoryScopeRefSchema: z.ZodObject<{
    type: z.ZodEnum<{
        agent: "agent";
        project: "project";
        run: "run";
        global_user: "global_user";
        workspace: "workspace";
        repository: "repository";
    }>;
    userId: z.ZodOptional<z.ZodString>;
    workspaceId: z.ZodOptional<z.ZodString>;
    projectId: z.ZodOptional<z.ZodString>;
    repoId: z.ZodOptional<z.ZodString>;
    repoRoot: z.ZodOptional<z.ZodString>;
    runId: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const MemoryKindSchema: z.ZodEnum<{
    evidence: "evidence";
    todo: "todo";
    user_preference: "user_preference";
    project_fact: "project_fact";
    architecture_decision: "architecture_decision";
    repo_convention: "repo_convention";
    api_finding: "api_finding";
    code_pattern: "code_pattern";
    test_pattern: "test_pattern";
    failure_pattern: "failure_pattern";
    security_note: "security_note";
    scratch: "scratch";
}>;
export declare const MemorySourceSchema: z.ZodObject<{
    type: z.ZodEnum<{
        agent: "agent";
        file: "file";
        manual: "manual";
        test: "test";
        tool: "tool";
        user: "user";
        commit: "commit";
        repo: "repo";
        web: "web";
    }>;
    ref: z.ZodOptional<z.ZodString>;
    url: z.ZodOptional<z.ZodString>;
    filePath: z.ZodOptional<z.ZodString>;
    commitSha: z.ZodOptional<z.ZodString>;
    createdBy: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const MemoryRecordSchema: z.ZodObject<{
    id: z.ZodString;
    scope: z.ZodObject<{
        type: z.ZodEnum<{
            agent: "agent";
            project: "project";
            run: "run";
            global_user: "global_user";
            workspace: "workspace";
            repository: "repository";
        }>;
        userId: z.ZodOptional<z.ZodString>;
        workspaceId: z.ZodOptional<z.ZodString>;
        projectId: z.ZodOptional<z.ZodString>;
        repoId: z.ZodOptional<z.ZodString>;
        repoRoot: z.ZodOptional<z.ZodString>;
        runId: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    kind: z.ZodEnum<{
        evidence: "evidence";
        todo: "todo";
        user_preference: "user_preference";
        project_fact: "project_fact";
        architecture_decision: "architecture_decision";
        repo_convention: "repo_convention";
        api_finding: "api_finding";
        code_pattern: "code_pattern";
        test_pattern: "test_pattern";
        failure_pattern: "failure_pattern";
        security_note: "security_note";
        scratch: "scratch";
    }>;
    text: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    confidence: z.ZodNumber;
    stability: z.ZodEnum<{
        session: "session";
        ephemeral: "ephemeral";
        durable: "durable";
    }>;
    source: z.ZodObject<{
        type: z.ZodEnum<{
            agent: "agent";
            file: "file";
            manual: "manual";
            test: "test";
            tool: "tool";
            user: "user";
            commit: "commit";
            repo: "repo";
            web: "web";
        }>;
        ref: z.ZodOptional<z.ZodString>;
        url: z.ZodOptional<z.ZodString>;
        filePath: z.ZodOptional<z.ZodString>;
        commitSha: z.ZodOptional<z.ZodString>;
        createdBy: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    lastAccessedAt: z.ZodOptional<z.ZodString>;
    expiresAt: z.ZodOptional<z.ZodString>;
    supersedes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    supersededBy: z.ZodOptional<z.ZodString>;
    contentHash: z.ZodString;
    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>;
export declare const MemoryProposalSchema: z.ZodObject<{
    id: z.ZodString;
    operation: z.ZodEnum<{
        ignore: "ignore";
        add: "add";
        delete: "delete";
        update: "update";
        merge: "merge";
        supersede: "supersede";
    }>;
    proposedRecord: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        scope: z.ZodObject<{
            type: z.ZodEnum<{
                agent: "agent";
                project: "project";
                run: "run";
                global_user: "global_user";
                workspace: "workspace";
                repository: "repository";
            }>;
            userId: z.ZodOptional<z.ZodString>;
            workspaceId: z.ZodOptional<z.ZodString>;
            projectId: z.ZodOptional<z.ZodString>;
            repoId: z.ZodOptional<z.ZodString>;
            repoRoot: z.ZodOptional<z.ZodString>;
            runId: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        kind: z.ZodEnum<{
            evidence: "evidence";
            todo: "todo";
            user_preference: "user_preference";
            project_fact: "project_fact";
            architecture_decision: "architecture_decision";
            repo_convention: "repo_convention";
            api_finding: "api_finding";
            code_pattern: "code_pattern";
            test_pattern: "test_pattern";
            failure_pattern: "failure_pattern";
            security_note: "security_note";
            scratch: "scratch";
        }>;
        text: z.ZodString;
        tags: z.ZodArray<z.ZodString>;
        confidence: z.ZodNumber;
        stability: z.ZodEnum<{
            session: "session";
            ephemeral: "ephemeral";
            durable: "durable";
        }>;
        source: z.ZodObject<{
            type: z.ZodEnum<{
                agent: "agent";
                file: "file";
                manual: "manual";
                test: "test";
                tool: "tool";
                user: "user";
                commit: "commit";
                repo: "repo";
                web: "web";
            }>;
            ref: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodString>;
            filePath: z.ZodOptional<z.ZodString>;
            commitSha: z.ZodOptional<z.ZodString>;
            createdBy: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        lastAccessedAt: z.ZodOptional<z.ZodString>;
        expiresAt: z.ZodOptional<z.ZodString>;
        supersedes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        supersededBy: z.ZodOptional<z.ZodString>;
        contentHash: z.ZodString;
        metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    targetMemoryId: z.ZodOptional<z.ZodString>;
    relatedMemoryIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    proposedBy: z.ZodObject<{
        agentRole: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodString>;
        runId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    rationale: z.ZodString;
    evidenceRefs: z.ZodArray<z.ZodString>;
    status: z.ZodEnum<{
        approved: "approved";
        rejected: "rejected";
        pending: "pending";
        applied: "applied";
        superseded: "superseded";
    }>;
    reviewer: z.ZodOptional<z.ZodEnum<{
        user: "user";
        controller: "controller";
        curator_agent: "curator_agent";
        auto_policy: "auto_policy";
    }>>;
    reviewedAt: z.ZodOptional<z.ZodString>;
    rejectionReason: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>;
export declare function normalizeMemoryText(text: string): string;
export declare function stableScopeKey(scope: MemoryScopeRef): string;
export declare function computeMemoryContentHash(recordLike: {
    scope: MemoryScopeRef;
    kind: MemoryKind;
    text: string;
}): string;
export declare function createMemoryId(recordLike: {
    scope: MemoryScopeRef;
    kind: MemoryKind;
    text: string;
}): string;
export declare function createProposalId(input: {
    createdAt: string;
    proposer: string;
    text: string;
}): string;
export declare function createBundleId(query: string, generatedAt: string): string;
export declare function isExpired(record: MemoryRecord, now?: Date): boolean;
export declare function hasEvidenceSource(record: MemoryRecord): boolean;
export declare function validateMemoryRecordRules(record: MemoryRecord, options: {
    rejectDurableSecrets: boolean;
}): MemoryRecord;
export declare function validateMemoryProposal(proposal: MemoryProposal): MemoryProposal;
