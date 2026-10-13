-- Answer and ExamSession see heavy UPDATE churn from autosave (every save
-- is an upsert into Answer via the ws-backend write-behind flusher, and
-- ExamSession.lastSeenAt/status update on the same cadence). Measured on a
-- 4 vCPU / 8 GB box at 1,600 concurrent students (load/RESULTS.md §2):
-- 10.7M UPDATEs against 195k live Answer rows, 24,466 dead tuples
-- outstanding despite 77 autovacuum passes, costing roughly 4x p95 answer-
-- save latency (153-211ms vs 40-46ms) until a manual VACUUM ANALYZE
-- restored it exactly. Postgres's 0.2 default scale factor means Answer
-- waits for ~20% of its rows to go dead (~39k at that row count) before
-- autovacuum triggers; at 0.02 it triggers near ~4k, an order of magnitude
-- sooner, keeping autovacuum's per-pass work small and frequent instead of
-- large, slow, and perpetually behind.
--
-- This does not vacuum retroactively — storage parameters only change when
-- autovacuum next triggers. An existing deployment upgrading past this
-- migration should run one manual `VACUUM (ANALYZE);` to reclaim
-- already-accumulated bloat immediately (see DEPLOYMENT.md).
ALTER TABLE "Answer" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE "ExamSession" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);
