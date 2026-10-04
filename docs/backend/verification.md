# Local verification contract

Current baseline: `npm run lint` in `frontend/` passed at `453c208`. The legacy Python unittest command failed at import because `cryptography` was absent. Docker service access and WebAssembly compilation were unavailable in the observed sandbox. These are not passed backend checks.

Planned repository entrypoints are `verify-fast`, `verify-integration`, `verify-security`, `verify-full`, `verify-fuzz`, `verify-performance`, and `rehearse-release`. An entrypoint will be documented as runnable only when its actual script exists and returns nonzero on a mandatory failure. Skipped mandatory checks must be recorded as `BLOCKED_TOOLING`, never PASS.

For the independent reference foundation, the first runnable command will be `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -p 'test_*.py' -v`. It uses only the Python standard library. The domain fixture and receipt tests must derive expectations by hand. Native, WASM, identity, PostgreSQL, browser, concurrency, and recovery gates are pending implementation.

Full targets from the brief: 200 seeded cases for fast differential, 10,000 for full, 30 seconds per available fuzz target for smoke and 10 minutes for milestone, domain/reference 90% line and 85% branch coverage, sync/client 85% line and 80% branch coverage. These are requirements, not observed results. Every run records source revision, command, exit status, executed count, skips, and environment.
