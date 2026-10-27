# Verification record · 2026-10-27

## Local outcome

Windows, Python 3.12.10, Node 25.5.0, actual installed Microsoft Edge 156.0.4314.42. A new source-only copy at the portfolio workspace’s `work/verification/equipment-run7-clean` excluded `.venv`, `node_modules`, build outputs and caches. Created a new virtual environment and installed `requirements-dev.txt` with exact constraints; `npm ci` used the committed lockfile. This was a fresh source-copy verification; remote clean-checkout CI is separate.

- **15/15 API tests passed**, 3.27 seconds in the fresh environment. Includes 12 simultaneous independent request connections, concurrent same-key replay, UTC equivalence, adjacency/overlap, invalid intervals, caller scoping, cancellation ownership, retry after cancellation, held-writer 503 with Retry-After, injected create/cancel audit failures with rollback, and restart persistence. No live user data or external services.
- `python -m pip check`: no broken requirements.
- `python -m build`: sdist and wheel built successfully with isolated setuptools 80.9.0. The source checkout is the supported full UI distribution; wheel contains the API module, not frontend assets.
- `npm run build`: TypeScript and Vite production build passed using the official Rollup WebAssembly package.
- Actual Edge smoke passed all seven groups: UI browse/reserve including a committed-but-lost response retry; conflict and owner control; cancel/rebook; actual server process stop/start preserving rows; desktop/mobile captures with no horizontal mobile overflow; real concurrent TCP races; no browser runtime errors.
- Fresh-copy TCP workload: **10 rounds × 12 concurrent POST requests, 10 created / 110 conflict, 2917ms elapsed** for the full loop. This is a correctness observation on one local machine, not a throughput/latency SLA or scaling claim. Separate source-worktree smoke also passed, with 2827ms observed. `docs/smoke-results.json` is the source-worktree capture report; fresh-copy report remains in its disposable verification directory.
- `docs/desktop.png` and `docs/mobile.png`: real screenshots from the automated live Edge flow, fictional Alex reservations, after cancel/rebook and an actual server restart. Visually inspected; no personal data or fabricated UI.
- Final `npm audit`: zero known vulnerabilities. `pip-audit`: zero known vulnerabilities in the audited development environment, excluding the local unpublished package (not indexed). These dated checks are not a guarantee against future advisories.

## Failures encountered and resolved

- Sandbox blocked dependency network access; approved network installs succeeded. Default pytest temporary directory was inaccessible; explicit workspace `--basetemp` works after creating its parent directory. Initial fresh test command omitted that parent and was corrected before the passing result.
- Initial test race used an intentionally short 100ms writer wait and received bounded 503 responses; the intended 1000ms setting passed 1 create /11 conflicts. Held-writer testing still verifies the 503 contract at the intended setting.
- Initial native Rollup addon was rejected by Windows Application Control. In-place npm resolution retained the native dependency despite the alias; a build exposed it. Preserved the generated dependency tree and lockfile outside this repo, resolved a fresh lock with official `@rollup/wasm-node@4.65.1`, verified its package identity and built successfully. No unblock, policy change or security disable.
- Dependency audits identified Vite and pip/pytest advisories; patched Vite 6.4.5, pip 26.2.2 and pytest 9.1.1 before final locking. Final audits passed.
- The smoke harness initially shadowed its server-start function with a local timing variable; renamed it and reran successfully. A parallel fresh install/smoke attempt started before Python dependency installation completed; rerunning after installation passed. These are harness/setup failures, not passing application evidence.
- Starlette emits a deprecation warning for TestClient’s httpx compatibility. Tests pass; this does not claim httpx2 support or suppress the warning.

## Publication and remaining limits

Local repository uses a GitHub noreply identity and feature branch `portfolio/equipment-booking`. File/history/metadata review and exact publication/CI results are recorded separately in the portfolio PROGRESS.md. Do not infer a remote CI pass from these local results. Workflow checks fresh Windows/Linux checkouts, builds, API tests and Chromium smoke; remote result must be observed before claiming it passed.

No hosted demo: no persistent-volume hosting target was configured; GitHub Pages cannot serve this Python/SQLite backend. Shared demo headers are not production accounts, and public mutable hosting would need isolation/abuse controls. No account, paid resource or hosting security policy was changed. Other Python/Node/browser versions, real users, real equipment and multi-host writes are unverified. Existing Word/Study/Control publication holds are unrelated and remain unchanged.
