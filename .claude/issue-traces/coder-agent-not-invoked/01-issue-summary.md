# Issue Summary: Coder Agent Not Invoked

## Observed Behavior
The Architect agent performs direct code writes instead of delegating to the Coder agent.
The screenshot shows the Architect (Kimi K2.6) writing code directly (file writes shown in green/red diff output) instead of delegating to the Coder agent.

## Expected Behavior
All code implementation work should flow through the Coder agent.
Architect should only write to `.swarm/` files and orchestrate delegation.

## Root Cause Patterns (per owner's comments)
Models rationalize skipping delegation with:
1. **Time pressure hallucination**: "fix is time-critical", "this is urgent", "blocking"
2. **Complexity minimization**: "fix is small", "it's trivial", "just a one-liner"
3. **Overhead rationalization**: "explaining to coder takes more time than doing it"
4. **False urgency**: "user needs this quickly" 

## Constraints
- Owner: "I don't want to ban the architect from coding because there are legitimate cases"
- Owner: "It's impossible to close the loop with a prompt, models will reason their way out"
- Must NOT hard-block (legitimate self-coding fallback after QA_RETRY_LIMIT failures)

## Acceptance Criteria
1. Anti-rationalization bullets include time-pressure and urgency patterns
2. The runtime warning (SELF-CODING DETECTED) names the specific rationalizations to reject
3. Section 6h (EDIT AUTHORITY) also references time pressure rationalization
4. Tests verify the new anti-rationalization text is present in the prompt
