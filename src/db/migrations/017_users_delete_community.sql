-- Staff removal permission + HR community chat.
-- Idempotent. Does not rewrite existing rows.

INSERT INTO permissions (resource, action)
SELECT 'users', 'delete'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'users' AND action = 'delete'
);

DO $$
DECLARE
  perm_id INTEGER;
BEGIN
  SELECT id INTO perm_id FROM permissions WHERE resource = 'users' AND action = 'delete' LIMIT 1;
  IF perm_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, perm_id
  FROM roles r
  WHERE r.name IN ('admin', 'director', 'hr')
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = perm_id
    );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'skip users:delete grants: %', SQLERRM;
END $$;

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
