import { z } from 'zod';
export declare const EVIDENCE_MAX_JSON_BYTES: number;
export declare const EVIDENCE_MAX_PATCH_BYTES: number;
export declare const EVIDENCE_MAX_TASK_BYTES: number;
export declare const EvidenceTypeSchema: z.ZodEnum<{
    diff: "diff";
    secretscan: "secretscan";
    quality_budget: "quality_budget";
    placeholder: "placeholder";
    test: "test";
    build: "build";
    review: "review";
    approval: "approval";
    note: "note";
    retrospective: "retrospective";
    syntax: "syntax";
    sast: "sast";
    sbom: "sbom";
}>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export declare const EvidenceVerdictSchema: z.ZodEnum<{
    pass: "pass";
    fail: "fail";
    approved: "approved";
    rejected: "rejected";
    info: "info";
}>;
export type EvidenceVerdict = z.infer<typeof EvidenceVerdictSchema>;
export declare const BaseEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    type: z.ZodEnum<{
        diff: "diff";
        secretscan: "secretscan";
        quality_budget: "quality_budget";
        placeholder: "placeholder";
        test: "test";
        build: "build";
        review: "review";
        approval: "approval";
        note: "note";
        retrospective: "retrospective";
        syntax: "syntax";
        sast: "sast";
        sbom: "sbom";
    }>;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type BaseEvidence = z.infer<typeof BaseEvidenceSchema>;
export declare const ReviewEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"review">;
    risk: z.ZodEnum<{
        medium: "medium";
        low: "low";
        high: "high";
        critical: "critical";
    }>;
    issues: z.ZodDefault<z.ZodArray<z.ZodObject<{
        severity: z.ZodEnum<{
            error: "error";
            info: "info";
            warning: "warning";
        }>;
        message: z.ZodString;
        file: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;
export declare const TestEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"test">;
    tests_passed: z.ZodNumber;
    tests_failed: z.ZodNumber;
    test_file: z.ZodOptional<z.ZodString>;
    failures: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;
export declare const DiffEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"diff">;
    files_changed: z.ZodDefault<z.ZodArray<z.ZodString>>;
    additions: z.ZodDefault<z.ZodNumber>;
    deletions: z.ZodDefault<z.ZodNumber>;
    patch_path: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type DiffEvidence = z.infer<typeof DiffEvidenceSchema>;
export declare const ApprovalEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"approval">;
}, z.core.$strip>;
export type ApprovalEvidence = z.infer<typeof ApprovalEvidenceSchema>;
export declare const NoteEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"note">;
}, z.core.$strip>;
export type NoteEvidence = z.infer<typeof NoteEvidenceSchema>;
export declare const RetrospectiveEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"retrospective">;
    phase_number: z.ZodNumber;
    total_tool_calls: z.ZodNumber;
    coder_revisions: z.ZodNumber;
    reviewer_rejections: z.ZodNumber;
    loop_detections: z.ZodOptional<z.ZodNumber>;
    circuit_breaker_trips: z.ZodOptional<z.ZodNumber>;
    test_failures: z.ZodNumber;
    security_findings: z.ZodNumber;
    integration_issues: z.ZodNumber;
    task_count: z.ZodNumber;
    task_complexity: z.ZodEnum<{
        trivial: "trivial";
        simple: "simple";
        moderate: "moderate";
        complex: "complex";
    }>;
    top_rejection_reasons: z.ZodDefault<z.ZodArray<z.ZodString>>;
    lessons_learned: z.ZodDefault<z.ZodArray<z.ZodString>>;
    user_directives: z.ZodDefault<z.ZodArray<z.ZodObject<{
        directive: z.ZodString;
        category: z.ZodEnum<{
            tooling: "tooling";
            code_style: "code_style";
            architecture: "architecture";
            process: "process";
            other: "other";
        }>;
        scope: z.ZodEnum<{
            global: "global";
            session: "session";
            project: "project";
        }>;
    }, z.core.$strip>>>;
    approaches_tried: z.ZodDefault<z.ZodArray<z.ZodObject<{
        approach: z.ZodString;
        result: z.ZodEnum<{
            success: "success";
            failure: "failure";
            partial: "partial";
        }>;
        abandoned_reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    error_taxonomy: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        planning_error: "planning_error";
        interface_mismatch: "interface_mismatch";
        logic_error: "logic_error";
        scope_creep: "scope_creep";
        gate_evasion: "gate_evasion";
    }>>>;
}, z.core.$strip>;
export type RetrospectiveEvidence = z.infer<typeof RetrospectiveEvidenceSchema>;
export declare const SyntaxEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"syntax">;
    files_checked: z.ZodNumber;
    files_failed: z.ZodNumber;
    skipped_count: z.ZodDefault<z.ZodNumber>;
    files: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        language: z.ZodString;
        ok: z.ZodBoolean;
        errors: z.ZodDefault<z.ZodArray<z.ZodObject<{
            line: z.ZodNumber;
            column: z.ZodNumber;
            message: z.ZodString;
        }, z.core.$strip>>>;
        skipped_reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type SyntaxEvidence = z.infer<typeof SyntaxEvidenceSchema>;
export declare const PlaceholderEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"placeholder">;
    findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        line: z.ZodNumber;
        kind: z.ZodEnum<{
            string: "string";
            other: "other";
            comment: "comment";
            function_body: "function_body";
        }>;
        excerpt: z.ZodString;
        rule_id: z.ZodString;
    }, z.core.$strip>>>;
    files_scanned: z.ZodNumber;
    files_with_findings: z.ZodNumber;
    findings_count: z.ZodNumber;
}, z.core.$strip>;
export type PlaceholderEvidence = z.infer<typeof PlaceholderEvidenceSchema>;
export declare const SastFindingSchema: z.ZodObject<{
    rule_id: z.ZodString;
    severity: z.ZodEnum<{
        medium: "medium";
        low: "low";
        high: "high";
        critical: "critical";
    }>;
    message: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        column: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    remediation: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SastEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"sast">;
    findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        rule_id: z.ZodString;
        severity: z.ZodEnum<{
            medium: "medium";
            low: "low";
            high: "high";
            critical: "critical";
        }>;
        message: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            column: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        remediation: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    engine: z.ZodEnum<{
        tier_a: "tier_a";
        "tier_a+tier_b": "tier_a+tier_b";
    }>;
    files_scanned: z.ZodNumber;
    findings_count: z.ZodNumber;
    findings_by_severity: z.ZodObject<{
        critical: z.ZodNumber;
        high: z.ZodNumber;
        medium: z.ZodNumber;
        low: z.ZodNumber;
    }, z.core.$strip>;
    new_findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        rule_id: z.ZodString;
        severity: z.ZodEnum<{
            medium: "medium";
            low: "low";
            high: "high";
            critical: "critical";
        }>;
        message: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            column: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        remediation: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    pre_existing_findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        rule_id: z.ZodString;
        severity: z.ZodEnum<{
            medium: "medium";
            low: "low";
            high: "high";
            critical: "critical";
        }>;
        message: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            column: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        remediation: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    baseline_used: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type SastEvidence = z.infer<typeof SastEvidenceSchema>;
export declare const SbomEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    type: z.ZodLiteral<"sbom">;
    components: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        type: z.ZodEnum<{
            library: "library";
            framework: "framework";
            application: "application";
        }>;
        purl: z.ZodOptional<z.ZodString>;
        license: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    metadata: z.ZodObject<{
        timestamp: z.ZodString;
        tool: z.ZodString;
        tool_version: z.ZodString;
    }, z.core.$strip>;
    files: z.ZodArray<z.ZodString>;
    components_count: z.ZodNumber;
    output_path: z.ZodString;
}, z.core.$strip>;
export type SbomEvidence = z.infer<typeof SbomEvidenceSchema>;
export declare const BuildEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"build">;
    runs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            test: "test";
            build: "build";
            typecheck: "typecheck";
        }>;
        command: z.ZodString;
        cwd: z.ZodString;
        exit_code: z.ZodNumber;
        duration_ms: z.ZodNumber;
        stdout_tail: z.ZodString;
        stderr_tail: z.ZodString;
    }, z.core.$strip>>>;
    files_scanned: z.ZodNumber;
    runs_count: z.ZodNumber;
    failed_count: z.ZodNumber;
    skipped_reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type BuildEvidence = z.infer<typeof BuildEvidenceSchema>;
export declare const QualityBudgetEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"quality_budget">;
    metrics: z.ZodObject<{
        complexity_delta: z.ZodNumber;
        public_api_delta: z.ZodNumber;
        duplication_ratio: z.ZodNumber;
        test_to_code_ratio: z.ZodNumber;
    }, z.core.$strip>;
    thresholds: z.ZodObject<{
        max_complexity_delta: z.ZodNumber;
        max_public_api_delta: z.ZodNumber;
        max_duplication_ratio: z.ZodNumber;
        min_test_to_code_ratio: z.ZodNumber;
    }, z.core.$strip>;
    violations: z.ZodDefault<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            complexity: "complexity";
            api: "api";
            duplication: "duplication";
            test_ratio: "test_ratio";
        }>;
        message: z.ZodString;
        severity: z.ZodEnum<{
            error: "error";
            warning: "warning";
        }>;
        files: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>>;
    files_analyzed: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type QualityBudgetEvidence = z.infer<typeof QualityBudgetEvidenceSchema>;
export declare const SecretscanEvidenceSchema: z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"secretscan">;
    findings_count: z.ZodDefault<z.ZodNumber>;
    scan_directory: z.ZodOptional<z.ZodString>;
    files_scanned: z.ZodDefault<z.ZodNumber>;
    skipped_files: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type SecretscanEvidence = z.infer<typeof SecretscanEvidenceSchema>;
export declare const EvidenceSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"review">;
    risk: z.ZodEnum<{
        medium: "medium";
        low: "low";
        high: "high";
        critical: "critical";
    }>;
    issues: z.ZodDefault<z.ZodArray<z.ZodObject<{
        severity: z.ZodEnum<{
            error: "error";
            info: "info";
            warning: "warning";
        }>;
        message: z.ZodString;
        file: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"test">;
    tests_passed: z.ZodNumber;
    tests_failed: z.ZodNumber;
    test_file: z.ZodOptional<z.ZodString>;
    failures: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"diff">;
    files_changed: z.ZodDefault<z.ZodArray<z.ZodString>>;
    additions: z.ZodDefault<z.ZodNumber>;
    deletions: z.ZodDefault<z.ZodNumber>;
    patch_path: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"approval">;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"note">;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"retrospective">;
    phase_number: z.ZodNumber;
    total_tool_calls: z.ZodNumber;
    coder_revisions: z.ZodNumber;
    reviewer_rejections: z.ZodNumber;
    loop_detections: z.ZodOptional<z.ZodNumber>;
    circuit_breaker_trips: z.ZodOptional<z.ZodNumber>;
    test_failures: z.ZodNumber;
    security_findings: z.ZodNumber;
    integration_issues: z.ZodNumber;
    task_count: z.ZodNumber;
    task_complexity: z.ZodEnum<{
        trivial: "trivial";
        simple: "simple";
        moderate: "moderate";
        complex: "complex";
    }>;
    top_rejection_reasons: z.ZodDefault<z.ZodArray<z.ZodString>>;
    lessons_learned: z.ZodDefault<z.ZodArray<z.ZodString>>;
    user_directives: z.ZodDefault<z.ZodArray<z.ZodObject<{
        directive: z.ZodString;
        category: z.ZodEnum<{
            tooling: "tooling";
            code_style: "code_style";
            architecture: "architecture";
            process: "process";
            other: "other";
        }>;
        scope: z.ZodEnum<{
            global: "global";
            session: "session";
            project: "project";
        }>;
    }, z.core.$strip>>>;
    approaches_tried: z.ZodDefault<z.ZodArray<z.ZodObject<{
        approach: z.ZodString;
        result: z.ZodEnum<{
            success: "success";
            failure: "failure";
            partial: "partial";
        }>;
        abandoned_reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    error_taxonomy: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        planning_error: "planning_error";
        interface_mismatch: "interface_mismatch";
        logic_error: "logic_error";
        scope_creep: "scope_creep";
        gate_evasion: "gate_evasion";
    }>>>;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"syntax">;
    files_checked: z.ZodNumber;
    files_failed: z.ZodNumber;
    skipped_count: z.ZodDefault<z.ZodNumber>;
    files: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        language: z.ZodString;
        ok: z.ZodBoolean;
        errors: z.ZodDefault<z.ZodArray<z.ZodObject<{
            line: z.ZodNumber;
            column: z.ZodNumber;
            message: z.ZodString;
        }, z.core.$strip>>>;
        skipped_reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"placeholder">;
    findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        line: z.ZodNumber;
        kind: z.ZodEnum<{
            string: "string";
            other: "other";
            comment: "comment";
            function_body: "function_body";
        }>;
        excerpt: z.ZodString;
        rule_id: z.ZodString;
    }, z.core.$strip>>>;
    files_scanned: z.ZodNumber;
    files_with_findings: z.ZodNumber;
    findings_count: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"sast">;
    findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        rule_id: z.ZodString;
        severity: z.ZodEnum<{
            medium: "medium";
            low: "low";
            high: "high";
            critical: "critical";
        }>;
        message: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            column: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        remediation: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    engine: z.ZodEnum<{
        tier_a: "tier_a";
        "tier_a+tier_b": "tier_a+tier_b";
    }>;
    files_scanned: z.ZodNumber;
    findings_count: z.ZodNumber;
    findings_by_severity: z.ZodObject<{
        critical: z.ZodNumber;
        high: z.ZodNumber;
        medium: z.ZodNumber;
        low: z.ZodNumber;
    }, z.core.$strip>;
    new_findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        rule_id: z.ZodString;
        severity: z.ZodEnum<{
            medium: "medium";
            low: "low";
            high: "high";
            critical: "critical";
        }>;
        message: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            column: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        remediation: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    pre_existing_findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        rule_id: z.ZodString;
        severity: z.ZodEnum<{
            medium: "medium";
            low: "low";
            high: "high";
            critical: "critical";
        }>;
        message: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            column: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        remediation: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    baseline_used: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    type: z.ZodLiteral<"sbom">;
    components: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        type: z.ZodEnum<{
            library: "library";
            framework: "framework";
            application: "application";
        }>;
        purl: z.ZodOptional<z.ZodString>;
        license: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    metadata: z.ZodObject<{
        timestamp: z.ZodString;
        tool: z.ZodString;
        tool_version: z.ZodString;
    }, z.core.$strip>;
    files: z.ZodArray<z.ZodString>;
    components_count: z.ZodNumber;
    output_path: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"build">;
    runs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            test: "test";
            build: "build";
            typecheck: "typecheck";
        }>;
        command: z.ZodString;
        cwd: z.ZodString;
        exit_code: z.ZodNumber;
        duration_ms: z.ZodNumber;
        stdout_tail: z.ZodString;
        stderr_tail: z.ZodString;
    }, z.core.$strip>>>;
    files_scanned: z.ZodNumber;
    runs_count: z.ZodNumber;
    failed_count: z.ZodNumber;
    skipped_reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"quality_budget">;
    metrics: z.ZodObject<{
        complexity_delta: z.ZodNumber;
        public_api_delta: z.ZodNumber;
        duplication_ratio: z.ZodNumber;
        test_to_code_ratio: z.ZodNumber;
    }, z.core.$strip>;
    thresholds: z.ZodObject<{
        max_complexity_delta: z.ZodNumber;
        max_public_api_delta: z.ZodNumber;
        max_duplication_ratio: z.ZodNumber;
        min_test_to_code_ratio: z.ZodNumber;
    }, z.core.$strip>;
    violations: z.ZodDefault<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            complexity: "complexity";
            api: "api";
            duplication: "duplication";
            test_ratio: "test_ratio";
        }>;
        message: z.ZodString;
        severity: z.ZodEnum<{
            error: "error";
            warning: "warning";
        }>;
        files: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>>;
    files_analyzed: z.ZodArray<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    task_id: z.ZodString;
    timestamp: z.ZodString;
    agent: z.ZodString;
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        approved: "approved";
        rejected: "rejected";
        info: "info";
    }>;
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    type: z.ZodLiteral<"secretscan">;
    findings_count: z.ZodDefault<z.ZodNumber>;
    scan_directory: z.ZodOptional<z.ZodString>;
    files_scanned: z.ZodDefault<z.ZodNumber>;
    skipped_files: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>], "type">;
export type Evidence = z.infer<typeof EvidenceSchema>;
export declare const EvidenceBundleSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"1.0.0">;
    task_id: z.ZodString;
    entries: z.ZodDefault<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"review">;
        risk: z.ZodEnum<{
            medium: "medium";
            low: "low";
            high: "high";
            critical: "critical";
        }>;
        issues: z.ZodDefault<z.ZodArray<z.ZodObject<{
            severity: z.ZodEnum<{
                error: "error";
                info: "info";
                warning: "warning";
            }>;
            message: z.ZodString;
            file: z.ZodOptional<z.ZodString>;
            line: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"test">;
        tests_passed: z.ZodNumber;
        tests_failed: z.ZodNumber;
        test_file: z.ZodOptional<z.ZodString>;
        failures: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            message: z.ZodString;
        }, z.core.$strip>>>;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"diff">;
        files_changed: z.ZodDefault<z.ZodArray<z.ZodString>>;
        additions: z.ZodDefault<z.ZodNumber>;
        deletions: z.ZodDefault<z.ZodNumber>;
        patch_path: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"approval">;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"note">;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"retrospective">;
        phase_number: z.ZodNumber;
        total_tool_calls: z.ZodNumber;
        coder_revisions: z.ZodNumber;
        reviewer_rejections: z.ZodNumber;
        loop_detections: z.ZodOptional<z.ZodNumber>;
        circuit_breaker_trips: z.ZodOptional<z.ZodNumber>;
        test_failures: z.ZodNumber;
        security_findings: z.ZodNumber;
        integration_issues: z.ZodNumber;
        task_count: z.ZodNumber;
        task_complexity: z.ZodEnum<{
            trivial: "trivial";
            simple: "simple";
            moderate: "moderate";
            complex: "complex";
        }>;
        top_rejection_reasons: z.ZodDefault<z.ZodArray<z.ZodString>>;
        lessons_learned: z.ZodDefault<z.ZodArray<z.ZodString>>;
        user_directives: z.ZodDefault<z.ZodArray<z.ZodObject<{
            directive: z.ZodString;
            category: z.ZodEnum<{
                tooling: "tooling";
                code_style: "code_style";
                architecture: "architecture";
                process: "process";
                other: "other";
            }>;
            scope: z.ZodEnum<{
                global: "global";
                session: "session";
                project: "project";
            }>;
        }, z.core.$strip>>>;
        approaches_tried: z.ZodDefault<z.ZodArray<z.ZodObject<{
            approach: z.ZodString;
            result: z.ZodEnum<{
                success: "success";
                failure: "failure";
                partial: "partial";
            }>;
            abandoned_reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        error_taxonomy: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            planning_error: "planning_error";
            interface_mismatch: "interface_mismatch";
            logic_error: "logic_error";
            scope_creep: "scope_creep";
            gate_evasion: "gate_evasion";
        }>>>;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"syntax">;
        files_checked: z.ZodNumber;
        files_failed: z.ZodNumber;
        skipped_count: z.ZodDefault<z.ZodNumber>;
        files: z.ZodDefault<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            language: z.ZodString;
            ok: z.ZodBoolean;
            errors: z.ZodDefault<z.ZodArray<z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
                message: z.ZodString;
            }, z.core.$strip>>>;
            skipped_reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"placeholder">;
        findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            line: z.ZodNumber;
            kind: z.ZodEnum<{
                string: "string";
                other: "other";
                comment: "comment";
                function_body: "function_body";
            }>;
            excerpt: z.ZodString;
            rule_id: z.ZodString;
        }, z.core.$strip>>>;
        files_scanned: z.ZodNumber;
        files_with_findings: z.ZodNumber;
        findings_count: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"sast">;
        findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
            rule_id: z.ZodString;
            severity: z.ZodEnum<{
                medium: "medium";
                low: "low";
                high: "high";
                critical: "critical";
            }>;
            message: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                column: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>;
            remediation: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        engine: z.ZodEnum<{
            tier_a: "tier_a";
            "tier_a+tier_b": "tier_a+tier_b";
        }>;
        files_scanned: z.ZodNumber;
        findings_count: z.ZodNumber;
        findings_by_severity: z.ZodObject<{
            critical: z.ZodNumber;
            high: z.ZodNumber;
            medium: z.ZodNumber;
            low: z.ZodNumber;
        }, z.core.$strip>;
        new_findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            rule_id: z.ZodString;
            severity: z.ZodEnum<{
                medium: "medium";
                low: "low";
                high: "high";
                critical: "critical";
            }>;
            message: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                column: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>;
            remediation: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        pre_existing_findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            rule_id: z.ZodString;
            severity: z.ZodEnum<{
                medium: "medium";
                low: "low";
                high: "high";
                critical: "critical";
            }>;
            message: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                column: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>;
            remediation: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        baseline_used: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        type: z.ZodLiteral<"sbom">;
        components: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
            type: z.ZodEnum<{
                library: "library";
                framework: "framework";
                application: "application";
            }>;
            purl: z.ZodOptional<z.ZodString>;
            license: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        metadata: z.ZodObject<{
            timestamp: z.ZodString;
            tool: z.ZodString;
            tool_version: z.ZodString;
        }, z.core.$strip>;
        files: z.ZodArray<z.ZodString>;
        components_count: z.ZodNumber;
        output_path: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"build">;
        runs: z.ZodDefault<z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                test: "test";
                build: "build";
                typecheck: "typecheck";
            }>;
            command: z.ZodString;
            cwd: z.ZodString;
            exit_code: z.ZodNumber;
            duration_ms: z.ZodNumber;
            stdout_tail: z.ZodString;
            stderr_tail: z.ZodString;
        }, z.core.$strip>>>;
        files_scanned: z.ZodNumber;
        runs_count: z.ZodNumber;
        failed_count: z.ZodNumber;
        skipped_reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"quality_budget">;
        metrics: z.ZodObject<{
            complexity_delta: z.ZodNumber;
            public_api_delta: z.ZodNumber;
            duplication_ratio: z.ZodNumber;
            test_to_code_ratio: z.ZodNumber;
        }, z.core.$strip>;
        thresholds: z.ZodObject<{
            max_complexity_delta: z.ZodNumber;
            max_public_api_delta: z.ZodNumber;
            max_duplication_ratio: z.ZodNumber;
            min_test_to_code_ratio: z.ZodNumber;
        }, z.core.$strip>;
        violations: z.ZodDefault<z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<{
                complexity: "complexity";
                api: "api";
                duplication: "duplication";
                test_ratio: "test_ratio";
            }>;
            message: z.ZodString;
            severity: z.ZodEnum<{
                error: "error";
                warning: "warning";
            }>;
            files: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>>;
        files_analyzed: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        task_id: z.ZodString;
        timestamp: z.ZodString;
        agent: z.ZodString;
        verdict: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            approved: "approved";
            rejected: "rejected";
            info: "info";
        }>;
        summary: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        type: z.ZodLiteral<"secretscan">;
        findings_count: z.ZodDefault<z.ZodNumber>;
        scan_directory: z.ZodOptional<z.ZodString>;
        files_scanned: z.ZodDefault<z.ZodNumber>;
        skipped_files: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>], "type">>>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
