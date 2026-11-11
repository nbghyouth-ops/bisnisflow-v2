-- 0005: role sistem eksplisit (bf_system) untuk jalur privileged (auth, bootstrap workspace, worker).
-- Masalah: tabel tenant memakai FORCE ROW LEVEL SECURITY. Pemilik non-superuser (mis. neondb_owner di Neon)
-- ikut tunduk RLS, sehingga withSystem() gagal (42501) saat menyentuh tabel tenant. Superuser lokal menyembunyikan bug ini.
-- Solusi tanpa BYPASSRLS/superuser: role NOLOGIN khusus + policy yang hanya berlaku untuk role itu.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bf_system') THEN
    CREATE ROLE bf_system NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

DO $$ BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT bf_system TO %I WITH INHERIT FALSE, SET TRUE', current_user);
  ELSE
    EXECUTE format('GRANT bf_system TO %I', current_user);
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT USAGE ON SCHEMA public TO bf_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bf_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bf_system;

-- Fungsi reusable: migrasi berikutnya yang menambah tabel tenant cukup memanggil SELECT public.bf_apply_system_policies();
CREATE OR REPLACE FUNCTION public.bf_apply_system_policies() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity LOOP
    EXECUTE format('DROP POLICY IF EXISTS system_access ON public.%I', r.t);
    EXECUTE format('CREATE POLICY system_access ON public.%I FOR ALL TO bf_system USING (true) WITH CHECK (true)', r.t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO bf_system', r.t);
  END LOOP;
END $fn$;
SELECT public.bf_apply_system_policies();
