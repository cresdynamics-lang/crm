const express = require('express');
const multer = require('multer');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { upload } = require('../middleware/upload');
const { queueNotification } = require('../queues/jobs');
const { transcribeAudio, parseReportFromTranscript } = require('../services/voiceReports');
const { recordAction } = require('../services/actionAudit');
const { analyzeReport } = require('../services/reportAnalyzer');
const { markAttendance } = require('../services/attendanceService');

const router = express.Router();
router.use(authenticate);

const ADMIN_NOTE_KEYS = [
  'admin_director_note',
  'admin_director_note_by',
  'admin_director_note_at',
  'admin_director_note_by_name',
];
const EXPECTED_REPORT_ROLES = ['sales', 'developer', 'pm', 'finance', 'director'];
const WORK_QUESTIONS = [
  { key: 'work_done', fallback: 'content', label: 'Done today' },
  { key: 'blockers_text', label: 'Blocked by' },
  { key: 'needs_attention', label: "Tomorrow's top 3" },
  { key: 'hard_today', label: 'What was hard this week' },
  { key: 'easy_today', label: 'What was easy this week' },
  { key: 'happiness', label: 'What made you feel part of the team' },
  { key: 'concerns', label: 'Anything on your mind' },
];

function presentReport(row, role) {
  if (!row || ['admin', 'director'].includes(role)) return row;
  const copy = { ...row };
  for (const k of ADMIN_NOTE_KEYS) delete copy[k];
  return copy;
}

function eatToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}

async function saveAdminDirectorNote(report, adminUser, note) {
  const { rows } = await query(
    `UPDATE daily_reports
     SET admin_director_note = $1,
         admin_director_note_by = $2,
         admin_director_note_at = NOW()
     WHERE id = $3
     RETURNING id, admin_director_note, admin_director_note_by, admin_director_note_at`,
    [note, adminUser.id, report.id]
  );

  const { rows: directors } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'director' AND u.status = 'active'`
  );
  for (const d of directors) {
    await queueNotification({
      userId: d.id,
      type: 'admin_report_note',
      content: `Admin left a private note on ${report.author_name || 'a'} report`,
      meta: { reportId: report.id, href: '#/reports?tab=daily' },
    });
  }
  return rows[0];
}

router.get(
  '/',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    const params = [];
    const clauses = [];

    const ownOnly =
      ['sales', 'developer'].includes(req.user.role) ||
      req.query.mine === '1' ||
      req.query.user_id === req.user.id;

    if (['sales', 'developer'].includes(req.user.role) || ownOnly) {
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
      clauses.push(`(dr.created_at AT TIME ZONE 'Africa/Nairobi')::date >= $${params.length}::date`);
    }
    if (req.query.date_to) {
      params.push(req.query.date_to);
      clauses.push(`(dr.created_at AT TIME ZONE 'Africa/Nairobi')::date <= $${params.length}::date`);
    }

    if (!ownOnly) {
      if (req.query.routing_status === 'all') {
        // no routing filter
      } else if (req.query.routing_status) {
        params.push(req.query.routing_status);
        clauses.push(`dr.routing_status = $${params.length}`);
      } else if (req.user.role === 'director') {
        // Small team: show every report unless a routing filter is set
      }

      if (req.user.role === 'pm' && !req.query.role) {
        clauses.push(`r.name IN ('sales', 'developer')`);
      }
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
              rm.name AS remarks_by_name,
              rp.name AS remarks_reply_by_name,
              adn.name AS admin_director_note_by_name
       FROM daily_reports dr
       JOIN users u ON u.id = dr.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN projects p ON p.id = dr.project_id
       LEFT JOIN users rv ON rv.id = dr.reviewed_by
       LEFT JOIN users fw ON fw.id = dr.forwarded_by
       LEFT JOIN users rm ON rm.id = dr.remarks_by
       LEFT JOIN users rp ON rp.id = dr.remarks_reply_by
       LEFT JOIN users adn ON adn.id = dr.admin_director_note_by
       ${where}
       ORDER BY dr.created_at DESC
       LIMIT 200`,
      params
    );

    const leaders = ['admin', 'director'].includes(req.user.role);
    if (leaders && rows.length) {
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
        r.can_react = false;
        r.can_director_note = req.user.role === 'admin';
        r.can_remark = req.user.role === 'director'
          && ['sales', 'developer'].includes(r.author_role);
      }
    } else if (req.user.role === 'pm' && rows.length) {
      for (const r of rows) {
        r.can_remark = false;
      }
    }

    res.json({
      ok: true,
      data: rows.map((r) => presentReport(r, req.user.role)),
      meta: leaders ? { questions: WORK_QUESTIONS } : undefined,
    });
  })
);

router.get(
  '/coverage',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (!['admin', 'director'].includes(req.user.role)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const day = String(req.query.date || eatToday());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new AppError('date must be YYYY-MM-DD', 400, 'VALIDATION');
    }
    const roles = req.query.role && EXPECTED_REPORT_ROLES.includes(req.query.role)
      ? [req.query.role]
      : EXPECTED_REPORT_ROLES;

    const { rows: staff } = await query(
      `SELECT DISTINCT ON (u.id) u.id, u.name, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.status = 'active' AND r.name = ANY($1::text[])
       ORDER BY u.id, u.name`,
      [roles]
    );
    const { rows: filed } = await query(
      `SELECT DISTINCT ON (dr.user_id)
              dr.id, dr.user_id, dr.created_at, p.name AS project_name
       FROM daily_reports dr
       LEFT JOIN projects p ON p.id = dr.project_id
       WHERE (dr.created_at AT TIME ZONE 'Africa/Nairobi')::date = $1::date
       ORDER BY dr.user_id, dr.created_at DESC`,
      [day]
    );
    const byUser = new Map(filed.map((r) => [r.user_id, r]));
    const submitted = [];
    const missing = [];
    for (const u of staff) {
      const report = byUser.get(u.id);
      const person = { id: u.id, name: u.name, role: u.role };
      if (report) {
        submitted.push({
          ...person,
          report_id: report.id,
          submitted_at: report.created_at,
          project_name: report.project_name || null,
        });
      } else {
        missing.push(person);
      }
    }
    submitted.sort((a, b) => a.name.localeCompare(b.name));
    missing.sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      ok: true,
      data: { date: day, submitted, missing, questions: WORK_QUESTIONS },
    });
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

    const blockers_text = req.body?.blockers_text || null;
    const needs_attention = req.body?.needs_attention || null;
    const hard_today = req.body?.hard_today || null;
    const easy_today = req.body?.easy_today || null;
    const happiness = req.body?.happiness || null;
    const concerns = req.body?.concerns || null;

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

    // Resolve assigned director for targeted notification
    let assignedDirectorId = null;
    try {
      const { rows: dirRows } = await query(
        `SELECT assigned_director_id FROM users WHERE id = $1`,
        [req.user.id]
      );
      assignedDirectorId = dirRows[0]?.assigned_director_id || null;
    } catch { /* column may not exist yet */ }

    const { rows } = await query(
      `INSERT INTO daily_reports
        (user_id, project_id, content, attachments, routing_status,
         work_done, blockers_text, needs_attention, hard_today, easy_today, happiness, concerns,
         assigned_director_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        req.user.id, project_id || null, content, JSON.stringify(attachments || []), routing,
        content, blockers_text, needs_attention, hard_today, easy_today, happiness, concerns,
        assignedDirectorId,
      ]
    );

    // Notify PM + Admin (if sales/dev), or assigned Director specifically
    if (routing === 'pending_pm') {
      const { rows: hubs } = await query(
        `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.name IN ('pm', 'admin') AND u.status = 'active'`
      );
      for (const h of hubs) {
        await queueNotification({
          userId: h.id,
          type: 'daily_report',
          content: `Daily report from ${req.user.name}`,
          meta: { reportId: rows[0].id, userId: req.user.id, routing },
        });
      }
    } else {
      // Notify assigned director if set, otherwise all directors + admin
      if (assignedDirectorId) {
        await queueNotification({
          userId: assignedDirectorId,
          type: 'daily_report',
          content: `Daily report from ${req.user.name}`,
          meta: { reportId: rows[0].id, userId: req.user.id, routing },
        });
      } else {
        const { rows: dirs } = await query(
          `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
           WHERE r.name IN ('director', 'admin') AND u.status = 'active'`
        );
        for (const d of dirs) {
          await queueNotification({
            userId: d.id,
            type: 'daily_report',
            content: `Daily report from ${req.user.name}`,
            meta: { reportId: rows[0].id, userId: req.user.id, routing },
          });
        }
      }
    }

    // Record in audit trail (RAG data pool)
    await recordAction({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'submitted',
      resourceType: 'report',
      resourceId: rows[0].id,
      summary: `${req.user.name} submitted daily report: ${(content || '').slice(0, 80)}`,
      after: { routing, project_id, content },
    });

    // Mark attendance for today (sales/developer only)
    if (['sales', 'developer'].includes(req.user.role)) {
      await markAttendance(req.user.id, rows[0].created_at, rows[0].id).catch(() => {});
    }

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

/**
 * Voice daily report: transcribe audio + parse into structured report.
 */
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post(
  '/voice-capture',
  requirePermission('reports', 'create'),
  memoryUpload.single('audio'),
  asyncHandler(async (req, res) => {
    let transcript;
    let whisperModel = null;
    if (req.file) {
      const result = await transcribeAudio({
        buffer: req.file.buffer,
        filename: req.file.originalname || 'recording.webm',
        mimetype: req.file.mimetype || 'audio/webm',
      });
      transcript = result.text;
      whisperModel = result.model;
    } else {
      transcript = String(req.body?.text || '').trim();
    }
    if (!transcript) throw new AppError('No audio or text to process', 400, 'VALIDATION');

    // Fetch user's projects for DB-aligned project matching
    let projects = [];
    try {
      if (['developer'].includes(req.user.role)) {
        const { rows } = await query(
          `SELECT p.id, p.name FROM projects p
           JOIN assignments a ON a.project_id = p.id
           WHERE a.user_id = $1 AND p.status != 'deleted' AND p.deleted_at IS NULL`,
          [req.user.id]
        );
        projects = rows;
      } else {
        const { rows } = await query(
          `SELECT id, name FROM projects WHERE status != 'deleted' AND deleted_at IS NULL ORDER BY name`
        );
        projects = rows;
      }
    } catch { /* proceed without projects */ }

    const report = await parseReportFromTranscript(transcript, projects);

    res.json({
      ok: true,
      data: {
        transcript,
        whisper_model: whisperModel,
        content: report.content,
        done: report.done,
        blockers: report.blockers,
        needs_attention: report.needs_attention,
        hard_today: report.hard_today,
        easy_today: report.easy_today,
        happiness: report.happiness,
        concerns: report.concerns,
        project_id: report.project_id,
        project_name: report.project_name,
      },
    });
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
    res.json({ ok: true, data: presentReport(rows[0], req.user.role) });
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

    res.json({ ok: true, data: presentReport(rows[0], req.user.role) });
  })
);

/**
 * Director remarks / clarifying questions on Sales or Developer reports.
 */
router.post(
  '/:id/remarks',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'director') {
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

    res.json({ ok: true, data: presentReport(rows[0], req.user.role) });
  })
);

/**
 * Admin private note — visible to Director only. Never notifies the reporter.
 */
async function loadReportForAdminNote(id) {
  const { rows: reports } = await query(
    `SELECT dr.id, dr.user_id, u.name AS author_name, r.name AS author_role
     FROM daily_reports dr
     JOIN users u ON u.id = dr.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE dr.id = $1`,
    [id]
  );
  return reports[0] || null;
}

router.post(
  '/:id/director-note',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      throw new AppError('Only Admin can leave a Director-only note', 403, 'FORBIDDEN');
    }
    const note = (req.body?.note || req.body?.content || '').trim();
    if (!note) throw new AppError('note required', 400, 'VALIDATION');
    const report = await loadReportForAdminNote(req.params.id);
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
    const saved = await saveAdminDirectorNote(report, req.user, note);
    res.json({ ok: true, data: saved });
  })
);

/**
 * Legacy admin react endpoint. Writes a Director-only note instead of a public reaction.
 */
router.post(
  '/:id/react',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      throw new AppError('Only Admin can leave a Director-only note', 403, 'FORBIDDEN');
    }
    const content = (req.body?.content || req.body?.note || '').trim();
    if (!content) throw new AppError('content required', 400, 'VALIDATION');
    const report = await loadReportForAdminNote(req.params.id);
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
    const saved = await saveAdminDirectorNote(report, req.user, content);
    res.status(201).json({ ok: true, data: saved });
  })
);

/**
 * Director AI Review: analyze a report and return structured questions.
 * POST /api/reports/:id/ai-review
 */
router.post(
  '/:id/ai-review',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'director') {
      throw new AppError('Only Director can use AI review', 403, 'FORBIDDEN');
    }

    const { rows: reports } = await query(
      `SELECT dr.*, r.name AS author_role
       FROM daily_reports dr
       JOIN users u ON u.id = dr.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE dr.id = $1`,
      [req.params.id]
    );
    const report = reports[0];
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
    if (!['sales', 'developer'].includes(report.author_role)) {
      throw new AppError('AI review only for Sales and Developer reports', 400, 'VALIDATION');
    }

    // Use cached analysis if available
    if (report.ai_analysis) {
      return res.json({ ok: true, data: report.ai_analysis, cached: true });
    }

    const analysis = await analyzeReport(report);

    // Cache the analysis
    await query(
      `UPDATE daily_reports SET ai_analysis = $1::jsonb WHERE id = $2`,
      [JSON.stringify(analysis), report.id]
    );

    res.json({ ok: true, data: analysis, cached: false });
  })
);

/**
 * Director remarks with AI analysis: send AI-generated questions as director's own.
 * POST /api/reports/:id/remarks-ai
 * Accepts { remarks, ai_analysis } — remarks is the final text the director approves.
 */
router.post(
  '/:id/remarks-ai',
  requirePermission('reports', 'view'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'director') {
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

    // Cache the AI analysis if provided
    if (req.body?.ai_analysis) {
      await query(
        `UPDATE daily_reports SET ai_analysis = $1::jsonb WHERE id = $2`,
        [JSON.stringify(req.body.ai_analysis), report.id]
      );
    }

    await queueNotification({
      userId: report.user_id,
      type: 'report_remarks',
      content: `Director left remarks on your daily report`,
      meta: { reportId: report.id },
    });

    res.json({ ok: true, data: presentReport(rows[0], req.user.role) });
  })
);

/**
 * Reporter replies to director's remarks.
 * POST /api/reports/:id/reply
 */
router.post(
  '/:id/reply',
  requirePermission('reports', 'create'),
  asyncHandler(async (req, res) => {
    const reply = (req.body?.reply || '').trim();
    if (!reply) throw new AppError('reply required', 400, 'VALIDATION');

    const { rows: reports } = await query(
      `SELECT dr.id, dr.user_id, dr.remarks_by
       FROM daily_reports dr
       WHERE dr.id = $1`,
      [req.params.id]
    );
    const report = reports[0];
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
    if (report.user_id !== req.user.id) {
      throw new AppError('You can only reply to your own reports', 403, 'FORBIDDEN');
    }

    const { rows } = await query(
      `UPDATE daily_reports
       SET remarks_reply = $1, remarks_reply_at = NOW(), remarks_reply_by = $2
       WHERE id = $3
       RETURNING *`,
      [reply, req.user.id, report.id]
    );

    // Notify the director who left remarks
    if (report.remarks_by) {
      await queueNotification({
        userId: report.remarks_by,
        type: 'report_remarks',
        content: `${req.user.name} replied to your remarks on their daily report`,
        meta: { reportId: report.id },
      });
    }

    res.json({ ok: true, data: presentReport(rows[0], req.user.role) });
  })
);

module.exports = router;
