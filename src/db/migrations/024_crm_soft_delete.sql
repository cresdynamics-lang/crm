-- Soft-delete for leads, clients, projects + CRUD grants for admin/director/sales.
-- Idempotent. Does not drop existing rows.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_alive ON leads (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clients_alive ON clients (converted_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_alive ON projects (created_at DESC) WHERE deleted_at IS NULL;

INSERT INTO permissions (resource, action)
SELECT x.resource, x.action
FROM (VALUES
  ('leads', 'delete'),
  ('clients', 'delete'),
  ('projects', 'delete')
) AS x(resource, action)
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p
  WHERE p.resource = x.resource AND p.action = x.action
);

DO $$
DECLARE
  rec RECORD;
  perm INTEGER;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('admin', 'leads', 'create'),
      ('admin', 'leads', 'edit'),
      ('admin', 'leads', 'delete'),
      ('admin', 'clients', 'create'),
      ('admin', 'clients', 'edit'),
      ('admin', 'clients', 'delete'),
      ('admin', 'projects', 'create'),
      ('admin', 'projects', 'edit'),
      ('admin', 'projects', 'delete'),
      ('director', 'leads', 'create'),
      ('director', 'leads', 'edit'),
      ('director', 'leads', 'delete'),
      ('director', 'clients', 'create'),
      ('director', 'clients', 'edit'),
      ('director', 'clients', 'delete'),
      ('director', 'projects', 'create'),
      ('director', 'projects', 'delete'),
      ('sales', 'leads', 'delete'),
      ('sales', 'clients', 'delete'),
      ('sales', 'projects', 'delete')
    ) AS g(role_name, resource, action)
  LOOP
    SELECT id INTO perm FROM permissions
    WHERE resource = rec.resource AND action = rec.action
    LIMIT 1;
    IF perm IS NULL THEN
      CONTINUE;
    END IF;
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, perm
    FROM roles r
    WHERE r.name = rec.role_name
      AND NOT EXISTS (
        SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = perm
      );
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'skip crm delete grants: %', SQLERRM;
END $$;
