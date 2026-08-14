const express = require('express');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { upload } = require('../middleware/upload');
const { queueNotification } = require('../queues/jobs');

const router = express.Router();
router.use(authenticate);

router.get(
  '/',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    const params = [];
    const clauses = [];

    if (['sales', 'developer'].includes(req.user.role)) {
      params.push(req.user.id);
      clauses.push(`dr.user_id = $${params.length}`);
    } else if (req.query.user_id) {
      params.push(req.query.user_id);
      clauses.push(`dr.user_id = $${params.length}`);
    }

    if (req.query.role) {
      params.push(req.query.role);
      clauses.push(`r.name = $${params.length}`);
    }

    if (req.query.project_id) {
      params.push(req.query.project_id);
      clauses.push(`dr.project_id = $${params.length}`);
    }

    if (req.query.date_from) {
      params.push(req.query.date_from);
      clauses.push(`dr.created_at >= $${params.length}::date`);
    }
    if (req.query.date_to) {
      params.push(req.query.date_to);
      clauses.push(`dr.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    if (req.query.routing_status === 'all') {
      // no routing filter
    } else if (req.query.routing_status) {
      params.push(req.query.routing_status);
      clauses.push(`dr.routing_status = $${params.length}`);
    } else if (req.user.role === 'director') {
      // Director hub defaults to PM-forwarded reports (the sync point)
      clauses.push(`dr.routing_status = 'forwarded_director'`);
    } else if (req.user.role === 'pm') {
      // PM hub: inbox + reviewed (not yet only forwarded)
      // no default filter - show all; UI filters pending
    }

    // PM never needs finance authors mixed in as routing targets, but can view
    if (req.user.role === 'pm' && !req.query.role) {
      clauses.push(`r.name IN ('sales', 'developer')`);
    }

    // Admin: no default routing filter - full reports viewer
    if (req.user.role === 'admin' && !req.query.routing_status) {
      // already unrestricted unless filters set
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT dr.*, u.name AS author_name, u.avatar_url AS author_avatar_url,
              r.name AS author_role, p.name AS project_name,
              rv.name AS reviewed_by_name, fw.name AS forwarded_by_name,
              rm.name AS remarks_by_name
       FROM daily_reports dr
       JOIN users u ON u.id = dr.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN projects p ON p.id = dr.project_id
       LEFT JOIN users rv ON rv.id = dr.reviewed_by
       LEFT JOIN users fw ON fw.id = dr.forwarded_by
       LEFT JOIN users rm ON rm.id = dr.remarks_by
       ${where}
       ORDER BY dr.created_at DESC
       LIMIT 200`,
      params
    );

    // Attach reactions for hub viewers (admin/director)
    if (['admin', 'director'].includes(req.user.role) && rows.length) {
      const ids = rows.map((r) => r.id);
      const { rows: reactions } = await query(
        `SELECT rr.*, u.name AS author_name, u.avatar_url AS author_avatar_url
         FROM report_reactions rr
         JOIN users u ON u.id = rr.user_id
         WHERE rr.report_id = ANY($1::uuid[])
         ORDER BY rr.created_at ASC`,
        [ids]
      );
      const byReport = new Map();
      for (const rx of reactions) {
        if (!byReport.has(rx.report_id)) byReport.set(rx.report_id, []);
        byReport.get(rx.report_id).push(rx);
      }
      for (const r of rows) {
        r.reactions = byReport.get(r.id) || [];
        r.can_react = req.user.role === 'admin'
          && ['director', 'pm', 'finance'].includes(r.author_role);
        r.can_remark = req.user.role === 'director'
          && ['sales', 'developer'].includes(r.author_role);
      }
    } else if (req.user.role === 'pm' && rows.length) {
      for (const r of rows) {
        r.can_remark = false;
      }
    }

    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/',
  requirePermission('reports', 'create'),
  upload.array('attachments', 5),
  asyncHandler(async (req, res) => {
    const content = (req.body?.content || '').trim();
    const project_id = req.body?.project_id || null;
    if (!content) throw new AppError('content required', 400, 'VALIDATION');

    const files = (req.files || []).map((f) => ({
      path: `/uploads/reports/${f.filename}`,
      originalName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
    }));

    let attachments = files;
    if (!files.length && req.body?.attachments) {
      try {
        attachments = typeof req.body.attachments === 'string'
          ? JSON.parse(req.body.attachments)
          : req.body.attachments;
      } catch {
        attachments = [];
      }
    }

    // Sales/Developer reports enter PM inbox; PM/Finance/Director own notes skip routing
    const routing =
      ['sales', 'developer'].includes(req.user.role) ? 'pending_pm' : 'pm_reviewed';

    const { rows } = await query(
      `INSERT INTO daily_reports (user_id, project_id, content, attachments, routing_status)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [req.user.id, project_id || null, content, JSON.stringify(attachments || []), routing]
    );

    const notifyRoles =
      routing === 'pending_pm'
        ? ['pm', 'admin']
        : ['director', 'admin'];

    const { rows: hubs } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = ANY($1::text[]) AND u.status = 'active'`,
      [notifyRoles]
    );
    for (const h of hubs) {
      await queueNotification({
        userId: h.id,
        type: 'daily_report',
        content: `Daily report from ${req.user.name}`,
        meta: { reportId: rows[0].id, userId: req.user.id, routing },
      });
    }

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

/**
 * PM marks a report reviewed (still in PM hub until forwarded).
 */
router.post(
  '/:id/review',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!['pm', 'admin'].includes(req.user.role)) {
      throw new AppError('Only PM can review reports for routing', 403, 'FORBIDDEN');
    }
    const note = (req.body?.pm_note || '').trim() || null;
    const { rows } = await query(
      `UPDATE daily_reports
       SET routing_status = 'pm_reviewed',
           reviewed_by = $1,
           reviewed_at = NOW(),
           pm_note = COALESCE($2, pm_note)
       WHERE id = $3 AND routing_status IN ('pending_pm', 'pm_reviewed')
       RETURNING *`,
      [req.user.id, note, req.params.id]
    );
    if (!rows[0]) throw new AppError('Report not found or already forwarded', 409, 'INVALID_STATE');
    res.json({ ok: true, data: rows[0] });
  })
);

/**
 * PM forwards report into Director's hub - reporting chain sync point.
 */
router.post(
  '/:id/forward',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!['pm', 'admin'].includes(req.user.role)) {
      throw new AppError('Only PM can forward reports to Director', 403, 'FORBIDDEN');
    }
    const note = (req.body?.pm_note || '').trim() || null;
    const { rows } = await query(
      `UPDATE daily_reports
       SET routing_status = 'forwarded_director',
           reviewed_by = COALESCE(reviewed_by, $1),
           reviewed_at = COALESCE(reviewed_at, NOW()),
           forwarded_by = $1,
           forwarded_at = NOW(),
           pm_note = COALESCE($2, pm_note)
       WHERE id = $3 AND routing_status IN ('pending_pm', 'pm_reviewed')
       RETURNING *`,
      [req.user.id, note, req.params.id]
    );
    if (!rows[0]) throw new AppError('Report not found or already forwarded', 409, 'INVALID_STATE');

    const { rows: directors } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('director', 'admin') AND u.status = 'active'`
    );
    for (const d of directors) {
      await queueNotification({
        userId: d.id,
        type: 'report_forwarded',
        content: `PM forwarded a daily report for Director review`,
        meta: { reportId: rows[0].id, forwardedBy: req.user.id },
      });
    }

    res.json({ ok: true, data: rows[0] });
  })
);

/**
 * Director remarks / clarifying questions on Sales or Developer reports.
 */
router.post(
  '/:id/remarks',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!['director', 'admin'].includes(req.user.role)) {
      throw new AppError('Only Director can add remarks on these reports', 403, 'FORBIDDEN');
    }
    const remarks = (req.body?.remarks || '').trim();
    if (!remarks) throw new AppError('remarks required', 400, 'VALIDATION');

    const { rows: reports } = await query(
      `SELECT dr.id, dr.user_id, r.name AS author_role
       FROM daily_reports dr
       JOIN users u ON u.id = dr.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE dr.id = $1`,
      [req.params.id]
    );
    const report = reports[0];
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
    if (!['sales', 'developer'].includes(report.author_role)) {
      throw new AppError('Remarks are for Sales and Developer reports', 400, 'VALIDATION');
    }

    const { rows } = await query(
      `UPDATE daily_reports
       SET remarks = $1, remarks_by = $2, remarks_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [remarks, req.user.id, report.id]
    );

    await queueNotification({
      userId: report.user_id,
      type: 'report_remarks',
      content: `Director left remarks on your daily report`,
      meta: { reportId: report.id },
    });

    res.json({ ok: true, data: rows[0] });
  })
);

/**
 * Admin reacts/responds to Director, PM, or Finance reports.
 * Sales and Developer reports are read-only (API-enforced).
 */
router.post(
  '/:id/react',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      throw new AppError('Only Admin can react to hub reports', 403, 'FORBIDDEN');
    }
    const content = (req.body?.content || '').trim();
    if (!content) throw new AppError('content required', 400, 'VALIDATION');

    const { rows: reports } = await query(
      `SELECT dr.id, r.name AS author_role, dr.user_id
       FROM daily_reports dr
       JOIN users u ON u.id = dr.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE dr.id = $1`,
      [req.params.id]
    );
    const report = reports[0];
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
    if (['sales', 'developer'].includes(report.author_role)) {
      throw new AppError(
        'Sales and Developer reports are read-only for Admin',
        403,
        'FORBIDDEN'
      );
    }
    if (!['director', 'pm', 'finance'].includes(report.author_role)) {
      throw new AppError('Reactions only allowed on Director, PM, or Finance reports', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `INSERT INTO report_reactions (report_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [report.id, req.user.id, content]
    );

    await queueNotification({
      userId: report.user_id,
      type: 'report_reaction',
      content: `Admin responded to your report`,
      meta: { reportId: report.id, reactionId: rows[0].id },
    });

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

module.exports = router;
