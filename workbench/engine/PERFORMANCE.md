# Performance evidence

Trace material operations from the actual caller through source reads, local writes, serialization, and external calls. Choose work by frequency, consequence, and expected growth. Keep the plain Active Record standard.

Before implementation, identify the required rows and smallest useful result. Filter, order, bound, and aggregate before materialization where the rule permits it. Reuse already loaded values within the required consistency boundary. Check association queries during serialization and repeated reads or writes in loops.

Create a project benchmark from accepted requirements. Record caller, starting state, fixture construction, workload, expected identities and effects, metrics, repetitions, and reset procedure. Freeze the contract, scripts, and relevant fixed inputs before baseline measurement.

Measure the complete operation. Separate database bootstrap from first population. Include source transfer, mirror import, derived-value creation and maintenance, applicable locks, writes, and retries. Do not prepare derived application fields outside timing when production must maintain them.

Measure added unrelated data with a fixed result separately from added required work with a larger expected result. Check first population and unchanged repeats. Confirm exact responses, identities, ordering, permissions, and persisted effects before interpreting cost.

Record applicable statements, returned rows, model objects, affected rows, source bytes, response bytes, external calls, elapsed time, and memory. State unavailable telemetry. A scalar result can hide a large scan. Read-only diagnostic plans can explain database work without introducing SQL strings into application query logic.

Inspect real query sources. A source checker only proves the patterns it recognizes. Require the project's configured query-source gate when applicable. Do not claim that an instruction hash ran that gate.

Fix confirmed unnecessary work at its responsible owner. Verify correctness and cost together. Report necessary growth and tradeoffs. Never accept an optimization only because it reduces one counter. Keep external final evaluation outside builder inputs and the internal repair loop.
