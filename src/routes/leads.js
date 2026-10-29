const express = require('express');
const multer = require('multer');
const { query, withTransaction } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requirePermission, hasPermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const { idempotency } = require('../middleware/idempotency');
const { queueNotification } = require('../queues/jobs');
const { recordAction } = require('../services/actionAudit');
const { loadLead, assertLeadWritable } = require('../lib/crmRecords');

const router = express.Router();
router.use(authenticate);

/** Voice recordings are small (webm/opus ~1MB/min); cap at 25MB (~25min). */
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^audio\//.test(file.mimetype) || /\.webm$|\.mp3$|\.m4a$|\.wav$|\.ogg$/i.test(file.originalname)) {
      return cb(null, true);
    }
    cb(new AppError('Audio file required', 400, 'VALIDATION'));
  },
});

router.get(
  '/',
  requirePermission('leads', 'view'),
  asyncHandler(async (req, res) => {
    const { status, created_by, q } = req.query;
    const params = [];
    const clauses = [];

    clauses.push('l.deleted_at IS NULL');

    if (req.user.role === 'sales') {
      params.push(req.user.id);
      clauses.push(`l.created_by = $${params.length}`);
    } else if (created_by) {
      params.push(created_by);
      clauses.push(`l.created_by = $${params.length}`);
    }

    if (status) {
      params.push(status);
      clauses.push(`l.status = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      clauses.push(
        `(l.name ILIKE $${params.length} OR l.business_name ILIKE $${params.length} OR COALESCE(l.email,'') ILIKE $${params.length} OR COALESCE(l.business_type,'') ILIKE $${params.length})`
      );
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const { rows } = await query(
      `SELECT l.*,
              (SELECT MAX(e.created_at) FROM lead_engagements e WHERE e.lead_id = l.id) AS last_engagement_at,
              (SELECT MIN(e.follow_up_date) FROM lead_engagements e
               WHERE e.lead_id = l.id AND e.follow_up_date IS NOT NULL AND e.follow_up_date >= CURRENT_DATE) AS next_follow_up
       FROM leads l
       ${where}
       ORDER BY l.created_at DESC`,
      params
    );
    res.json({ ok: true, data: rows });
  })
);

// ── Voice capture + Bulk import ──────────────────────────────────────────────

router.post(
  '/voice-capture',
  requirePermission('leads', 'create'),
  (req, res, next) => {
    voiceUpload.single('audio')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return next(new AppError(err.message, 400, 'VALIDATION'));
      }
      if (err) return next(err);
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const { transcribeAudio, parseLeadsFromTranscript } = require('../services/voiceLeads');

    let transcript;
    let whisperModel = null;
    if (req.file) {
      const result = await transcribeAudio({
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
      });
      transcript = result.text;
      whisperModel = result.model;
    } else {
      transcript = String(req.body?.text || '').trim();
    }
    if (!transcript) throw new AppError('Audio file or text is required', 400, 'VALIDATION');

    let leads = [];
    let parseError = null;
    if (transcript.length > 10) {
      try {
        ({ leads } = await parseLeadsFromTranscript(transcript));
      } catch (err) {
        parseError = err.message;
        console.warn('[leads] parse error', err.message);
      }
    }

    res.json({
      ok: true,
      data: {
        transcript,
        whisper_model: whisperModel,
        leads_count: leads.length,
        leads,
        parse_error: parseError,
      },
    });
  })
);

router.post(
  '/bulk',
  requirePermission('leads', 'create'),
  asyncHandler(async (req, res) => {
    const { leads = [] } = req.body || {};
    if (!Array.isArray(leads) || !leads.length) {
      throw new AppError('leads array required', 400, 'VALIDATION');
    }
    const MAX = 50;
    const items = leads.slice(0, MAX);

    const created = [];
    const duplicates = [];
    const failed = [];

    for (const raw of items) {
      const name = String(raw.name || raw.business_name || '').trim();
      if (!name && !raw.phone) {
        failed.push({ lead: raw, error: 'Missing name or phone' });
        continue;
      }
      try {
        const dupeClauses = [];
        const dupeParams = [];
        if (String(raw.phone || '').trim()) {
          dupeParams.push(String(raw.phone).trim().replace(/\s+/g, ''));
          dupeClauses.push(
            `regexp_replace(COALESCE(phone,''), '\\s', '', 'g') = $${dupeParams.length}`
          );
        }
        if (String(raw.business_name || '').trim()) {
          dupeParams.push(String(raw.business_name).trim().toLowerCase());
          dupeClauses.push(
            `LOWER(TRIM(COALESCE(business_name,''))) = $${dupeParams.length}`
          );
        }
        if (!raw.force && dupeClauses.length) {
          const { rows: dups } = await query(
            `SELECT id, name, phone, business_name, business_type FROM leads
              WHERE deleted_at IS NULL AND (${dupeClauses.join(' OR ')}) LIMIT 3`,
            dupeParams
          );
          if (dups.length) {
            duplicates.push({ lead: raw, duplicates: dups });
            continue;
          }
        }

        const { rows } = await query(
          `INSERT INTO leads (name, phone, email, business_name, business_type, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            name,
            raw.phone || null,
            raw.email || null,
            raw.business_name || null,
            (raw.business_type || '').trim() || null,
            req.user.id,
          ]
        );
        created.push({ id: rows[0].id, name, business_name: raw.business_name || null });
      } catch (err) {
        failed.push({ lead: raw, error: err.message });
      }
    }

    res.json({
      ok: true,
      data: {
        total: items.length,
        created: created.length,
        duplicates: duplicates.length,
        failed: failed.length,
        leads_created: created,
        leads_duplicate: duplicates,
        leads_failed: failed,
      },
    });
  })
);

// ── Single lead CRUD ─────────────────────────────────────────────────────────

router.post(
  '/',
  requirePermission('leads', 'create'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { name, phone, email, business_name, business_type, force, value_amount, status } = req.body || {};
    if (!name) throw new AppError('name is required', 400, 'VALIDATION');

    // Duplicate check on phone / business name (unless force=true after confirm)
    if (!force) {
      const params = [];
      const clauses = [];
      if (phone?.trim()) {
        params.push(phone.trim().replace(/\s+/g, ''));
        clauses.push(`regexp_replace(COALESCE(phone,''), '\\s', '', 'g') = $${params.length}`);
      }
      if (business_name?.trim()) {
        params.push(business_name.trim().toLowerCase());
        clauses.push(`LOWER(TRIM(COALESCE(business_name,''))) = $${params.length}`);
      }
      if (clauses.length) {
        const { rows: dupes } = await query(
          `SELECT id, name, phone, business_name, business_type, status, created_by,
                  (SELECT u.name FROM users u WHERE u.id = leads.created_by) AS owner_name
           FROM leads
           WHERE deleted_at IS NULL AND (${clauses.join(' OR ')})
           ORDER BY created_at DESC
           LIMIT 5`,
          params
        );
        if (dupes.length) {
          throw new AppError('Possible duplicate lead found', 409, 'DUPLICATE_LEAD', {
            duplicates: dupes,
          });
        }
      }
    }

    const PIPELINE = ['new', 'contacted', 'meeting', 'proposal', 'won', 'lost', 'contacting', 'follow_up', 'not_interested', 'converted'];
    const nextStatus = PIPELINE.includes(status) ? status : 'new';
    const { rows } = await query(
      `INSERT INTO leads (name, phone, email, business_name, business_type, created_by, status, value_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name,
        phone || null,
        email || null,
        business_name || null,
        (business_type || '').trim() || null,
        req.user.id,
        nextStatus,
        value_amount != null && value_amount !== '' ? Number(value_amount) : null,
      ]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.get(
  '/:id',
  requirePermission('leads', 'view'),
  asyncHandler(async (req, res) => {
    const lead = await loadLead(req.params.id);
    if (!lead || lead.deleted_at) throw new AppError('Lead not found', 404, 'NOT_FOUND');
    if (req.user.role === 'sales' && lead.created_by !== req.user.id) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    res.json({ ok: true, data: lead });
  })
);

router.patch(
  '/:id',
  requirePermission('leads', 'edit'),
  asyncHandler(async (req, res) => {
    const lead = await loadLead(req.params.id);
    assertLeadWritable(req.user, lead);

    const allowed = ['name', 'phone', 'email', 'business_name', 'business_type', 'status', 'value_amount'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) throw new AppError('No fields to update', 400, 'VALIDATION');
    params.push(lead.id);

    const { rows } = await query(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length} AND deleted_at IS NULL
       RETURNING *`,
      params
    );
    if (!rows[0]) throw new AppError('Lead not found', 404, 'NOT_FOUND');
    res.json({ ok: true, data: rows[0] });
  })
);

router.delete(
  '/:id',
  requirePermission('leads', 'delete'),
  asyncHandler(async (req, res) => {
    const lead = await loadLead(req.params.id);
    assertLeadWritable(req.user, lead);

    const { rows } = await query(
      `UPDATE leads
          SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [lead.id, req.user.id]
    );
    if (!rows[0]) throw new AppError('Lead not found', 404, 'NOT_FOUND');

    await recordAction({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'lead.delete',
      resourceType: 'lead',
      resourceId: lead.id,
      summary: `Deleted lead ${lead.name}`,
      before: { name: lead.name, phone: lead.phone, status: lead.status },
    });

    res.json({ ok: true, data: { id: lead.id, deleted: true } });
  })
);

router.post(
  '/:id/engagements',
  requirePermission('leads', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    const { note, follow_up_date, status } = req.body || {};
    if (!note) throw new AppError('note is required', 400, 'VALIDATION');

    const allowedStatus = [
      'contacting', 'follow_up', 'not_interested', 'converted',
      'new', 'contacted', 'meeting', 'proposal', 'won', 'lost',
    ];
    if (status && !allowedStatus.includes(status)) {
      throw new AppError('Invalid status', 400, 'VALIDATION');
    }

    const result = await withTransaction(async (tx) => {
      const leadRes = await tx.query(`SELECT * FROM leads WHERE id = $1 FOR UPDATE`, [req.params.id]);
      const lead = leadRes.rows[0];
      if (!lead || lead.deleted_at) throw new AppError('Lead not found', 404, 'NOT_FOUND');
      if (req.user.role === 'sales' && lead.created_by !== req.user.id) {
        throw new AppError('Forbidden', 403, 'FORBIDDEN');
      }

      const eng = await tx.query(
        `INSERT INTO lead_engagements (lead_id, note, follow_up_date, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.params.id, note, follow_up_date || null, req.user.id]
      );

      let nextStatus = status;
      if (!nextStatus && follow_up_date) nextStatus = 'follow_up';

      let client = null;
      if (['converted', 'won'].includes(nextStatus) && !['converted', 'won'].includes(lead.status)) {
        const clientRes = await tx.query(
          `INSERT INTO clients (lead_id, name, business_name, email, phone)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [lead.id, lead.name, lead.business_name, lead.email, lead.phone]
        );
        client = clientRes.rows[0];
        await tx.query(
          `UPDATE leads SET status = $2, updated_at = NOW() WHERE id = $1`,
          [lead.id, nextStatus === 'won' ? 'won' : 'converted']
        );
      } else if (nextStatus && nextStatus !== lead.status) {
        await tx.query(
          `UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2`,
          [nextStatus, lead.id]
        );
      }

      const updated = await tx.query(`SELECT * FROM leads WHERE id = $1`, [lead.id]);
      return { engagement: eng.rows[0], lead: updated.rows[0], client };
    });

    res.status(201).json({ ok: true, data: result });
  })
);

router.get(
  '/:id/engagements',
  requirePermission('leads', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT e.*, u.name AS created_by_name
       FROM lead_engagements e
       JOIN users u ON u.id = e.created_by
       WHERE e.lead_id = $1
       ORDER BY e.created_at DESC`,
      [req.params.id]
    );
    res.json({ ok: true, data: rows });
  })
);

async function assertLeadAccess(req, leadId) {
  const { rows } = await query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
  if (!rows[0] || rows[0].deleted_at) throw new AppError('Lead not found', 404, 'NOT_FOUND');
  if (req.user.role === 'sales' && rows[0].created_by !== req.user.id) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
  return rows[0];
}

/** List scheduled / sent messages for a lead */
router.get(
  '/:id/messages',
  requirePermission('leads', 'view'),
  asyncHandler(async (req, res) => {
    await assertLeadAccess(req, req.params.id);
    const { rows } = await query(
      `SELECT m.*, u.name AS created_by_name
       FROM lead_messages m
       JOIN users u ON u.id = m.created_by
       WHERE m.lead_id = $1
       ORDER BY m.scheduled_for DESC`,
      [req.params.id]
    );
    res.json({ ok: true, data: rows });
  })
);

/** Schedule a message to the lead's email */
router.post(
  '/:id/messages',
  requirePermission('leads', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    const lead = await assertLeadAccess(req, req.params.id);
    const subject = (req.body?.subject || '').trim();
    const body = (req.body?.body || '').trim();
    const scheduled_for = req.body?.scheduled_for;
    const send_now = Boolean(req.body?.send_now);

    if (!subject || !body) throw new AppError('subject and body required', 400, 'VALIDATION');
    if (!lead.email) throw new AppError('Lead has no email on file', 400, 'VALIDATION');

    const when = send_now ? new Date() : new Date(scheduled_for);
    if (Number.isNaN(when.getTime())) {
      throw new AppError('scheduled_for must be a valid date/time', 400, 'VALIDATION');
    }

    const { rows } = await query(
      `INSERT INTO lead_messages (lead_id, subject, body, scheduled_for, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [lead.id, subject, body, when.toISOString(), req.user.id]
    );

    if (send_now || when.getTime() <= Date.now()) {
      const { queueLeadMessage } = require('../queues/jobs');
      await queueLeadMessage({ messageId: rows[0].id });
    }

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

/**
 * Mark lead as won: create client, project (pending approval), and optional deposit invoice.
 */
router.post(
  '/:id/win',
  requirePermission('leads', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    if (!hasPermission(req.user, 'projects', 'create') && req.user.role !== 'admin') {
      throw new AppError('Forbidden: missing permission projects:create', 403, 'FORBIDDEN');
    }
    const lead = await assertLeadAccess(req, req.params.id);
    if (['won', 'converted'].includes(lead.status)) {
      throw new AppError('Lead is already won', 409, 'INVALID_STATE');
    }

    const {
      project_name,
      value_amount,
      deposit_amount,
      due_date,
      assigned_developer_id,
      description,
    } = req.body || {};
    const projectName = String(project_name || `${lead.business_name || lead.name} project`).trim();
    const value = value_amount != null && value_amount !== '' ? Number(value_amount) : Number(lead.value_amount || 0);
    const deposit = deposit_amount != null && deposit_amount !== '' ? Number(deposit_amount) : 0;
    if (deposit < 0) throw new AppError('deposit_amount must be ≥ 0', 400, 'VALIDATION');
    if (value < 0) throw new AppError('value_amount must be ≥ 0', 400, 'VALIDATION');

    const result = await withTransaction(async (tx) => {
      let clientRow;
      const existing = await tx.query(`SELECT * FROM clients WHERE lead_id = $1 LIMIT 1`, [lead.id]);
      if (existing.rows[0]) {
        clientRow = existing.rows[0];
      } else {
        const created = await tx.query(
          `INSERT INTO clients (lead_id, name, business_name, email, phone)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [lead.id, lead.name, lead.business_name, lead.email, lead.phone]
        );
        clientRow = created.rows[0];
      }

      await tx.query(
        `UPDATE leads SET status = 'won', value_amount = COALESCE($2, value_amount), updated_at = NOW() WHERE id = $1`,
        [lead.id, value || null]
      );

      const project = await tx.query(
        `INSERT INTO projects
          (name, client_id, description, summary, assigned_developer_id, created_by, value_amount, due_date, status)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,'pending_approval')
         RETURNING *`,
        [
          projectName,
          clientRow.id,
          description || `Won from lead ${lead.name}`,
          assigned_developer_id || null,
          req.user.id,
          value || null,
          due_date || null,
        ]
      );

      let invoice = null;
      if (deposit > 0) {
        const inv = await tx.query(
          `INSERT INTO invoices (project_id, client_id, amount, status, due_date, amount_paid)
           VALUES ($1, $2, $3, 'issued', COALESCE($4::date, CURRENT_DATE + INTERVAL '7 days'), 0)
           RETURNING *`,
          [project.rows[0].id, clientRow.id, deposit, due_date || null]
        );
        invoice = inv.rows[0];
      }

      return { client: clientRow, project: project.rows[0], invoice };
    });

    const { rows: directors } = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('director', 'admin') AND u.status = 'active'`
    );
    for (const d of directors) {
      await queueNotification({
        userId: d.id,
        type: 'project_pending_approval',
        content: `Project "${result.project.name}" awaiting approval (won lead)`,
        meta: { projectId: result.project.id, leadId: lead.id },
      });
    }

    res.status(201).json({ ok: true, data: result });
  })
);

/** Send a pending scheduled message now */
router.post(
  '/:id/messages/:messageId/send',
  requirePermission('leads', 'edit'),
  idempotency,
  asyncHandler(async (req, res) => {
    await assertLeadAccess(req, req.params.id);
    const { rows } = await query(
      `SELECT * FROM lead_messages WHERE id = $1 AND lead_id = $2`,
      [req.params.messageId, req.params.id]
    );
    if (!rows[0]) throw new AppError('Message not found', 404, 'NOT_FOUND');
    if (rows[0].status === 'sent') {
      throw new AppError('Message already sent', 409, 'INVALID_STATE');
    }
    if (rows[0].status === 'cancelled') {
      throw new AppError('Message was cancelled', 409, 'INVALID_STATE');
    }

    await query(
      `UPDATE lead_messages
       SET status = 'pending', scheduled_for = NOW(), error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [rows[0].id]
    );

    const { queueLeadMessage } = require('../queues/jobs');
    await queueLeadMessage({ messageId: rows[0].id });
    res.json({ ok: true, data: { queued: true, messageId: rows[0].id } });
  })
);

module.exports = router;
