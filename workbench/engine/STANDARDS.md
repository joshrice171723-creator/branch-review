# Engineering standards

Prioritize correctness, readability, simplicity, maintainability, and applicable performance. Follow project and framework conventions. Use descriptive names and direct control flow. Keep each rule close to the writes or result it controls.

Read the entry point first. Make the main sequence, transaction owner, expected failure, and caller result easy to find. Extract a private step when its name reduces reading effort. Do not use quotas for classes, services, methods, or lines.

Keep HTTP inputs and responses in controllers. Keep screen-specific queries and response assembly in named private controller methods when they improve comprehension. Models own persistence and record rules. A separate workflow object needs shared callers or a business and transaction boundary that warrants its own owner and tests. Do not add a wrapper only to move code.

Use plain Active Record for application queries. Rails-generated SQL is normal. Keep SQL strings, SQL expressions, Arel, and authored query views or functions out of application query logic where Active Record expresses the rule. Check the real data source behind relations. Do not trade this readability requirement for a faster SQL string.

Query for the result the caller needs. Use scoped existence checks, scalar projections, database aggregation, bounded lists, and required association loading. Check repeated work across the complete operation. A lower query count alone does not establish better performance.

Make transaction boundaries visible. Identify expected failures where their cause is known. Preserve unexpected causes. Use a savepoint only when an inner failure has a defined recovery path. Persist required failure state outside the rollback it must survive. Do not hide defects with broad rescue or invented fallback values.

Use constraints and indexes when integrity requires them. Check concurrency and retry behavior where effects can repeat. Bulk APIs need evidence that callbacks, validation, timestamps, uniqueness, and rollback still satisfy the contract.

Use framework naming and loading conventions. Keep components, hooks, services, classes, and dependencies only when their responsibility is clear. Avoid speculative abstractions, duplicate rule owners, unnecessary state, and unrelated cleanup.

For React, prefer explicit props, local state, semantic HTML, and clear loading, error, empty, and success states. Use effects to synchronize with external systems. Do not store values that can be derived directly. Add shared state or dependencies only for a demonstrated need.

Write tests for observable behavior and meaningful failure paths. Avoid assertions that only mirror internal implementation. Write comments that explain the reason. Keep private details private. Follow established bang-method conventions instead of adding exclamation marks to ordinary custom methods.
