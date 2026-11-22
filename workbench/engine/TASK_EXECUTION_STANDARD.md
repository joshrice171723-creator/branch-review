# Task execution standard

Every agent must use this standard for every coding task in a project that uses this harness. It applies to fresh projects, existing projects, reviewers, and repair agents. Read this standard and the applicable project rules before changing code.

## ACTION

State the exact change, the affected components, and the expected result. Review the relevant code and its callers. Record the action in the existing plan or task notes before editing.

## CONSTRAINTS

Preserve behavior unless the task explicitly changes it. Follow the project's conventions and architecture. Keep the change focused. Avoid unnecessary dependencies, abstractions, and files. Get approval before fixing an unrelated problem. Report conflicts with established rules and preserve those rules until the conflict is resolved.

## VERIFICATION

Check current behavior before editing. Run the relevant tests before and after the change. If the application or test does not yet exist, record why a baseline cannot run. Run the test when the relevant behavior becomes available. Add or update a test when necessary. Verify the requested result and applicable regressions. Run relevant lint and static checks. Measure comparable before-and-after workloads when performance matters. Record the commands and their actual results. Name every required check that could not run and give the reason. Treat failed or missing required verification as incomplete work.

## REPORTING

Use these headings in the final report, in this order. Reuse the existing build log or review report for longer evidence. A short task can keep its record in the task conversation.

- **ACTION** Describe the problem, the change, and the result.
- **CONSTRAINTS** State what the change preserves and explain material decisions.
- **VERIFICATION** Give the tests, results, and comparable measurements where relevant. State which checks failed or could not run.
- **REPORTING** List changed files, remaining problems, risks, and limitations.

## Writing

Apply ASD-STE100 principles to instructions, task specifications, documentation, README files, development plans, comments, test descriptions, reports, and AI-generated explanations. Use short, clear sentences and prefer active voice. Use precise words and consistent terms. Give one main action per instruction. Use complete sentences when they improve clarity. Remove ambiguous, redundant, or unnecessary wording. Preserve technical detail and accuracy.

Apply the wording rules to prose, comments, and natural-language test descriptions. Keep programming identifiers under normal Ruby, Rails, React, JavaScript, and TypeScript conventions. Claim formal ASD-STE100 compliance only after a separate compliance check.

## Code quality

Prioritize correctness, readability, simplicity, and maintainability in that order. Address performance when it matters. Apply all existing required safety and performance checks. Use descriptive names, direct control flow, and focused functions. Follow framework conventions. Remove duplication when it makes the rule easier to understand or change. Avoid speculative abstractions and premature optimization. Explain the reason for a decision in a comment when the code cannot show it clearly. Add a service, hook, helper, class, file, or dependency only when it has a clear purpose. Keep the diff easy to review.

## Task examples

| Task | Action and scope | Verification |
|---|---|---|
| Performance | Find the bottleneck and fix the confirmed cause. | Compare equivalent results and work before and after the change. |
| Code quality | Audit for defects and maintenance problems. Fix confirmed issues in scope. | Verify the fix and preserved behavior. |
| Refactoring | Improve readability where necessary. Preserve public behavior. | Run relevant regression tests before and after the change. |
| Security | Verify the vulnerability. Fix the cause while preserving valid behavior where possible. | Run focused security and regression checks. |
| Feature development | Review the requirements and affected code. Implement the smallest complete feature. | Test the expected behavior and relevant existing behavior. |
| Bug fix | Reproduce the defect. Identify the cause and make a focused fix. | Reproduce the original failure and verify the fix. Keep a regression test when practical. |

Use all four elements for each example. Report findings, changes, and evidence.

## Completion gate

Review the diff and the evidence before marking a task complete.

- [ ] The requested action is complete.
- [ ] The implementation follows project conventions.
- [ ] The diff stays within the necessary scope.
- [ ] The change preserves required behavior.
- [ ] The relevant tests ran.
- [ ] The report gives the test results.
- [ ] The report gives the required measurements.
- [ ] Each new dependency has a clear reason.
- [ ] A developer can read and maintain the change.
- [ ] The report gives the remaining risks.

A failed or incomplete required check prevents a completion claim. Report the failure and its effect. Never invent evidence. Use checks that apply to the task. The review gate supplements the project's existing test, safety, performance, and review gates.
