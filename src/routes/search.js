const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

/**
 * Global search across leads, projects, clients, invoices (RBAC-scoped).
 */
router.get(
  '/',
  requirePermission('query', 'view'),
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) throw new AppError('q must be at least 2 characters', 400, 'VALIDATION');
    const like = `%${q}%`;
    const results = [];

    const role = req.user.role;
    const canLeads = req.user.permissions.includes('leads:view');
    const canProjects = req.user.permissions.includes('projects:view');
    const canClients = req.user.permissions.includes('clients:view');
    const canInvoices = req.user.permissions.includes('invoices:view') && role !== 'sales';

    if (canLeads && role !== 'client') {
      const params = [like];
      let scope = '';
      if (role === 'sales') {
        params.push(req.user.id);
        scope = `AND created_by = $2`;
      }
      const { rows } = await query(
        `SELECT id, name, business_name, status FROM leads
         WHERE (name ILIKE $1 OR COALESCE(business_name,'') ILIKE $1 OR COALESCE(phone,'') ILIKE $1)
         ${scope}
         ORDER BY updated_at DESC LIMIT 10`,
        params
      );
      results.push(...rows.map((r) => ({ type: 'lead', id: r.id, title: r.name, subtitle: r.business_name || r.status, href: `#/pipeline` })));
    }

    if (canClients && role !== 'client') {
      const { rows } = await query(
        `SELECT id, name, business_name FROM clients
         WHERE name ILIKE $1 OR COALESCE(business_name,'') ILIKE $1 OR COALESCE(email,'') ILIKE $1
         ORDER BY created_at DESC LIMIT 10`,
        [like]
      );
      results.push(...rows.map((r) => ({ type: 'client', id: r.id, title: r.name, subtitle: r.business_name, href: `#/clients` })));
    }

    if (canProjects) {
      const params = [like];
      let scope = `AND status NOT IN ('pending_approval','rejected')`;
      if (role === 'developer') {
        params.push(req.user.id);
        scope += ` AND assigned_developer_id = $2`;
      } else if (role === 'sales') {
        params.push(req.user.id);
        scope += ` AND created_by = $2`;
      } else if (role === 'client') {
        params.push(req.user.id, req.user.email);
        scope += ` AND client_id IN (SELECT id FROM clients WHERE user_id = $2 OR email = $3)`;
      }
      const { rows } = await query(
        `SELECT id, name, status FROM projects
         WHERE name ILIKE $1 ${scope}
         ORDER BY updated_at DESC LIMIT 10`,
        params
      );
      results.push(...rows.map((r) => ({ type: 'project', id: r.id, title: r.name, subtitle: r.status, href: `#/projects/${r.id}` })));
    }

    if (canInvoices) {
      const params = [like];
      let scope = '';
      if (role === 'client') {
        params.push(req.user.id, req.user.email);
        scope = `AND (c.user_id = $2 OR c.email = $3)`;
      }
      const { rows } = await query(
        `SELECT i.id, i.status, i.amount, c.name AS client_name, p.name AS project_name
         FROM invoices i
         LEFT JOIN clients c ON c.id = i.client_id
         LEFT JOIN projects p ON p.id = i.project_id
         WHERE (c.name ILIKE $1 OR p.name ILIKE $1 OR i.id::text ILIKE $1)
         ${scope}
         ORDER BY i.created_at DESC LIMIT 10`,
        params
      );
      results.push(...rows.map((r) => ({
        type: 'invoice',
        id: r.id,
        title: r.project_name || r.client_name || r.id.slice(0, 8),
        subtitle: `${r.status} · ${r.amount}`,
        href: `#/invoices`,
      })));
    }

    res.json({ ok: true, data: results });
  })
);

module.exports = router;
