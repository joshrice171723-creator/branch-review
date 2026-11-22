# Review and repair

Record a source checkpoint before grading. Review the actual implementation through its normal callers. Confirm findings against current source. Distinguish defects, risks, preferences, and missing evidence.

Use pass only when the current criterion has relevant evidence. Use revise for a confirmed material issue. Use unverified when required evidence is missing. Name a genuine prerequisite when blocked. Missing or failed required verification prevents completion.

Review these criteria:

1. Correctness. Check the accepted result, neighboring behavior, identities, and side effects.
2. Human readability. Trace the entry point, main sequence, rule owners, writes, failures, and result.
3. Maintainability. Identify a plausible rule change and its owner. Use a disposable change exercise when it materially tests the claim.
4. Performance. Measure complete operations and growth where applicable. Preserve plain Active Record.
5. Failure handling. Check what persists, rolls back, retries, and reaches the caller.
6. Scope and constraints. Preserve accepted decisions, unrelated work, fixed external contracts, and permission boundaries.

For each claim, state a concrete failure and the evidence that addresses it. Relevant assertions matter more than test names or green summaries. Mark not applicable only with a concrete reason and evidence.

Use separate review when available. Label dedicated self-review accurately. Neither a synthetic review fixture nor structural JSON validation proves code quality. The agent owns the grade and repairs. The user does not need to validate the grade by reading code.

Record a repair round before changes. Fix the smallest responsible area. Run affected checks. Regrade the current source. Carry forward evidence only when its source and inputs still apply. Run final configured gates before task finish.

Stop when all required current gates pass. Stop and report when the configured repair limit is reached or a prerequisite is genuinely unavailable. Do not widen scope or weaken checks to obtain a pass. Keep failed attempts and remaining issues visible.
