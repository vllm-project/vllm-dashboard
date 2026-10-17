-- H200 hosts: whether Docker can start a container (the docker0 bridge
-- exists and the daemon answers), and why not. NULL means the reporter
-- couldn't tell, never a passing value; Kubernetes nodes leave both NULL.
-- Nullable columns with no default, so adding them doesn't rewrite the
-- table.
ALTER TABLE host_snapshots
    ADD COLUMN IF NOT EXISTS docker_ok boolean,
    ADD COLUMN IF NOT EXISTS docker_error text;
