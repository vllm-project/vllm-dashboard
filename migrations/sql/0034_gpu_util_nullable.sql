-- GPUs with MIG enabled can't report nvidia-smi utilization. Reporters send
-- NULL for them instead of 0, so an unreadable GPU never looks idle.
ALTER TABLE gpu_snapshots ALTER COLUMN gpu_util DROP NOT NULL;

-- Utilization samples per rollup row; sample_count still counts every GPU for
-- memory. NULL on rows written before this migration, when every sample had a
-- utilization, so readers use COALESCE(gpu_util_count, sample_count).
ALTER TABLE gpu_history_5m ADD COLUMN IF NOT EXISTS gpu_util_count bigint;
