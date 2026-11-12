-- Sales and developer reports go to one Director. Record that Director on each
-- active sales/developer account that has none yet - only when the company has
-- exactly one active director (otherwise leave it for Admin to choose).
-- Idempotent: re-running changes nothing.
UPDATE users u
   SET assigned_director_id = d.id
  FROM (
    SELECT u2.id FROM users u2 JOIN roles r2 ON r2.id = u2.role_id
     WHERE r2.name = 'director' AND u2.status = 'active'
  ) d,
  roles r
 WHERE r.id = u.role_id
   AND r.name IN ('sales', 'developer')
   AND u.assigned_director_id IS NULL
   AND (SELECT COUNT(*) FROM users x JOIN roles xr ON xr.id = x.role_id
         WHERE xr.name = 'director' AND x.status = 'active') = 1;
