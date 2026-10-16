-- Empty, dedicated database initialization only. No passwords are supplied in SQL/argv.
-- Owner must provision LOGIN/SCRAM credentials using native PostgreSQL tooling
-- and the approved secret provider before authorizing API/worker startup.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='nuvomailo_api') THEN
    CREATE ROLE nuvomailo_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='nuvomailo_worker') THEN
    CREATE ROLE nuvomailo_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='nuvomailo_notification') THEN
    CREATE ROLE nuvomailo_notification NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
