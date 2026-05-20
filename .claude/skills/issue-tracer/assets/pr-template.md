# PR Description Template

### Root Cause

[One paragraph explaining what was broken, where, and why. Include file paths, symbols, line ranges, and triggering conditions.]

### Fix

[Concise description of the minimal patch and why it is necessary and sufficient.]

- [Specific code change]
- [Specific code change]
- [Specific code change]

### Tests

- Regression test: `[command]` -> PASS
- Impacted suite: `[command]` -> PASS
- Lint/type/build/security checks: `[commands]` -> PASS

### Regression Protection

- [New/updated test path and scenario]
- [Negative/boundary/adversarial case if relevant]
- [Test drift review result]

### Risk and Rollback

- Risk level: [low/medium/high]
- Rollback: [revert commit / disable flag / restore config / migration rollback]
- Residual risk: [none or explicit risk]

### Issue Closure

Closes #[issue-number]

