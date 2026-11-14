-- Kubernetes GPU nodes: whether every GPU's NVLink fabric is registered and
-- healthy and the driver still reaches Fabric Manager, and why not. NULL
-- means the reporter couldn't tell, never a passing value; H200 hosts leave
-- both NULL. Nullable columns with no default, so adding them doesn't
-- rewrite the table.
ALTER TABLE host_snapshots
    ADD COLUMN IF NOT EXISTS fabric_ok boolean,
    ADD COLUMN IF NOT EXISTS fabric_error text;
