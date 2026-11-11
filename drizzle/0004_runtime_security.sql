-- 0004: keamanan runtime dipindahkan dari kode request ke migrasi terkontrol.
-- Sebelumnya src/db/bootstrap.ts menjalankan DDL ini pada request pertama setiap proses (anti-pola).
-- Dijalankan oleh peran migrasi/pemilik; peran runtime (bf_runtime) tidak punya hak DDL.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bf_runtime') THEN
    CREATE ROLE bf_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO bf_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'workspace_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON public.%I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$f$, r.table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO bf_runtime', r.table_name);
  END LOOP;
END $$;

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.workspaces;
CREATE POLICY tenant_isolation ON public.workspaces
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, UPDATE ON public.workspaces TO bf_runtime;
GRANT SELECT (id, email, name, status, email_verified) ON public.users TO bf_runtime;

REVOKE UPDATE, DELETE ON public.stock_movements, public.journal_lines, public.audit_logs,
  public.cost_snapshots, public.legal_acceptances, public.journal_entries FROM bf_runtime;
REVOKE DELETE ON public.workspace_members, public.goods_receipts, public.sales_documents,
  public.sales_lines, public.payments, public.purchase_orders, public.purchase_lines,
  public.cash_sessions, public.cash_movements, public.bills, public.legal_versions,
  public.production_batches, public.accounts, public.purchase_returns, public.purchase_return_lines FROM bf_runtime;
REVOKE UPDATE ON public.purchase_returns, public.purchase_return_lines FROM bf_runtime;
REVOKE ALL ON public.platform_admins, public.admin_audit_log FROM bf_runtime;
GRANT UPDATE (status, reversed_by) ON public.journal_entries TO bf_runtime;

CREATE OR REPLACE FUNCTION public.bf_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_movements','journal_lines','audit_logs','cost_snapshots','legal_acceptances','admin_audit_log'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS bf_append_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER bf_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bf_block_mutation()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.bf_fill_currency() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.currency_code IS NULL OR NEW.currency_code = '' THEN
    SELECT currency INTO NEW.currency_code FROM public.workspaces WHERE id = NEW.workspace_id;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries','sales_documents','purchase_orders','bills','purchase_returns'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS bf_fill_currency ON public.%I', t);
    EXECUTE format('CREATE TRIGGER bf_fill_currency BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bf_fill_currency()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.bf_journal_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted journals cannot be deleted; post a reversal' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'posted' AND NEW.status = 'reversed'
     AND NEW.number = OLD.number AND NEW.entry_date = OLD.entry_date
     AND NEW.memo IS NOT DISTINCT FROM OLD.memo AND NEW.workspace_id = OLD.workspace_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Posted journals are immutable' USING ERRCODE = '55000';
END $$;
DROP TRIGGER IF EXISTS bf_je_guard ON public.journal_entries;
CREATE TRIGGER bf_je_guard BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.bf_journal_entry_guard();

CREATE OR REPLACE FUNCTION public.bf_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO d, c FROM public.journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c OR d = 0 THEN
    RAISE EXCEPTION 'Journal % is not balanced (debit %, credit %)', NEW.entry_id, d, c USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS bf_jl_balance ON public.journal_lines;
CREATE CONSTRAINT TRIGGER bf_jl_balance AFTER INSERT ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bf_check_balance();

CREATE OR REPLACE FUNCTION public.bf_legal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published','archived') THEN RAISE EXCEPTION 'Published legal versions are immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('published','archived') THEN
    IF OLD.status = 'published' AND NEW.status = 'archived' AND NEW.content = OLD.content AND NEW.version = OLD.version THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Published legal versions are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bf_legal_guard ON public.legal_versions;
CREATE TRIGGER bf_legal_guard BEFORE UPDATE OR DELETE ON public.legal_versions
  FOR EACH ROW EXECUTE FUNCTION public.bf_legal_guard();

-- Pemilik koneksi harus boleh SET ROLE bf_runtime. Pada PostgreSQL 16+, peran yang dibuat oleh
-- non-superuser (mis. neondb_owner di Neon) TIDAK otomatis boleh SET ROLE ke peran tersebut
-- (ERROR 42501 permission denied to set role) sehingga seluruh withTenant() gagal.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT bf_runtime TO %I WITH INHERIT FALSE, SET TRUE', current_user);
  ELSE
    EXECUTE format('GRANT bf_runtime TO %I', current_user);
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
