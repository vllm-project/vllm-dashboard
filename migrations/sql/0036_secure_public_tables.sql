-- Close the Supabase Data API on every table in public. 0009 and later
-- migrations did this for alerting tables only; the dashboard tables
-- (queue_snapshots, gpu_snapshots, otel_spans, alert_summary, ...) and any
-- table created outside migrations were still readable and writable by the
-- anon and authenticated roles through PostgREST (Supabase advisor:
-- rls_disabled_in_public).
--
-- Only trusted server-side connections use these tables, as the table owner,
-- which RLS does not restrict without FORCE. Abort rather than enable RLS on
-- a table the running role could then not read, in case this runs as some
-- other role.
DO $$
DECLARE
    item record;
    api_role name;
    can_bypass boolean;
BEGIN
    SELECT rolbypassrls INTO can_bypass FROM pg_roles WHERE rolname = current_user;
    FOR item IN
        SELECT c.oid::regclass AS name, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND NOT c.relrowsecurity
    LOOP
        IF item.owner <> current_user AND NOT can_bypass THEN
            RAISE EXCEPTION
                'refusing to enable RLS on % (owner %): % neither owns it nor bypasses RLS',
                item.name, item.owner, current_user;
        END IF;
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item.name);
    END LOOP;

    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', api_role);
            EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
            EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
            -- Tables, sequences and functions this role creates later.
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
        END IF;
    END LOOP;
END;
$$;
