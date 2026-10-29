-- Live DB was copied without primary keys, so the same person, invoice,
-- payment, and action row exists twice. Keep one copy of each id, restore
-- keys so totals and Community names cannot double again.
-- Idempotent. Safe on databases that already have keys.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'account_balances',
    'action_audit_log',
    'admin_inbox_messages',
    'clients',
    'conversations',
    'employees',
    'expenses',
    'invoice_email_log',
    'invoices',
    'knowledge_base',
    'leads',
    'login_audit',
    'notifications',
    'ops_conversations',
    'payments',
    'permissions',
    'project_updates',
    'projects',
    'refresh_tokens',
    'roles',
    'salary_funding_requests',
    'salary_payments',
    'users',
    'website_payer_emails'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DELETE FROM %I a USING %I b WHERE a.ctid > b.ctid AND a.id = b.id', t, t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = ('public.' || t)::regclass AND contype = 'p'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (id)', t);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.role_permissions') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM role_permissions a
  USING role_permissions b
  WHERE a.ctid > b.ctid
    AND a.role_id = b.role_id
    AND a.permission_id = b.permission_id;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.role_permissions'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE role_permissions ADD PRIMARY KEY (role_id, permission_id);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.system_settings') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM system_settings a
  USING system_settings b
  WHERE a.ctid > b.ctid AND a.key = b.key;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.system_settings'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE system_settings ADD PRIMARY KEY (key);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.user_settings') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM user_settings a
  USING user_settings b
  WHERE a.ctid > b.ctid AND a.user_id = b.user_id;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.user_settings'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE user_settings ADD PRIMARY KEY (user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.idempotency_keys') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM idempotency_keys a
  USING idempotency_keys b
  WHERE a.ctid > b.ctid AND a.key = b.key;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.idempotency_keys'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE idempotency_keys ADD PRIMARY KEY (key);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS roles_name_key ON roles (name);
CREATE UNIQUE INDEX IF NOT EXISTS permissions_resource_action_key ON permissions (resource, action);

-- HR must be able to open Community like every other staff role.
DO $$
DECLARE
  view_id INTEGER;
  create_id INTEGER;
BEGIN
  SELECT id INTO view_id FROM permissions WHERE resource = 'messages' AND action = 'view' LIMIT 1;
  SELECT id INTO create_id FROM permissions WHERE resource = 'messages' AND action = 'create' LIMIT 1;
  IF view_id IS NOT NULL THEN
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, view_id FROM roles r
    WHERE r.name = 'hr'
      AND NOT EXISTS (
        SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = view_id
      );
  END IF;
  IF create_id IS NOT NULL THEN
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, create_id FROM roles r
    WHERE r.name = 'hr'
      AND NOT EXISTS (
        SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = create_id
      );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'skip hr messages grants: %', SQLERRM;
END $$;
