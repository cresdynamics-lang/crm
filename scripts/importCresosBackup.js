/**
 * Import CresOS Prisma backup (SQL dump) into the new CRM schema.
 * Usage: node scripts/importCresosBackup.js /path/to/cresos-db-....sql.gz
 */
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const { pool } = require('../src/config/database');

const CRES_ORG = 'cmrc5f9f800008k5gt57ftvg5';
const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // UUID namespace DNS

const ROLE_MAP = {
  admin: 'admin',
  director_admin: 'director',
  finance: 'finance',
  developer: 'developer',
  sales: 'sales',
  hr: 'hr',
  project_manager: 'pm',
  client: 'client',
  analyst: 'sales',
};

function uuidFrom(cuid) {
  return crypto.uuidv5 ? crypto.uuidv5(String(cuid), NS) : null;
}

// Node < 22 may lack uuidv5 — fall back to SHA-1 style UUID v5
function idFor(cuid) {
  if (!cuid || cuid === '\\N') return null;
  const hash = crypto.createHash('sha1').update(`cresos:${cuid}`).digest();
  const bytes = Buffer.from(hash.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseCopy(sql, table) {
  const re = new RegExp(
    `COPY public\\."${table}" \\((.*?)\\) FROM stdin;\\n(.*?)\\\\\\.\\n`,
    's'
  );
  const m = sql.match(re);
  if (!m) return { cols: [], rows: [] };
  const cols = m[1].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const rows = m[2].trim()
    ? m[2]
        .trim()
        .split('\n')
        .map((line) => {
          const parts = line.split('\t');
          const obj = {};
          cols.forEach((col, i) => {
            const v = parts[i];
            obj[col] = v === '\\N' || v === undefined ? null : v;
          });
          return obj;
        })
    : [];
  return { cols, rows };
}

function mapProjectStatus(p) {
  const s = (p.status || '').toLowerCase();
  if (s === 'completed') return 'completed';
  if (s === 'active' || s === 'in_progress') return 'in_progress';
  if (p.approvalStatus === 'approved') return 'approved';
  if (p.approvalStatus === 'rejected') return 'rejected';
  return 'pending_approval';
}

function mapInvoiceStatus(s) {
  if (s === 'paid') return 'paid';
  if (s === 'overdue') return 'overdue';
  return 'issued'; // sent, draft, etc.
}

function mapExpenseCategory(c) {
  const x = (c || '').toLowerCase();
  if (x.includes('salary')) return 'salary';
  if (x.includes('tool') || x.includes('ops') || x.includes('operation')) return 'operational';
  return 'other';
}

async function main() {
  const dumpPath = process.argv[2];
  if (!dumpPath) {
    console.error('Usage: node scripts/importCresosBackup.js <dump.sql.gz|dump.sql>');
    process.exit(1);
  }
  const raw = fs.readFileSync(dumpPath);
  const sql = dumpPath.endsWith('.gz')
    ? zlib.gunzipSync(raw).toString('utf8')
    : raw.toString('utf8');

  const users = parseCopy(sql, 'User').rows.filter((u) => u.orgId === CRES_ORG);
  const roles = Object.fromEntries(parseCopy(sql, 'Role').rows.map((r) => [r.id, r.key]));
  const userRoles = parseCopy(sql, 'UserRole').rows;
  const roleByUser = {};
  for (const ur of userRoles) {
    roleByUser[ur.userId] = ROLE_MAP[roles[ur.roleId]] || 'sales';
  }

  const clients = parseCopy(sql, 'Client').rows.filter((c) => c.orgId === CRES_ORG && !c.deletedAt);
  const leads = parseCopy(sql, 'Lead').rows.filter((l) => l.orgId === CRES_ORG && !l.deletedAt);
  const projects = parseCopy(sql, 'Project').rows.filter((p) => p.orgId === CRES_ORG && !p.deletedAt);
  const invoices = parseCopy(sql, 'Invoice').rows.filter((i) => i.orgId === CRES_ORG && !i.deletedAt);
  const payments = parseCopy(sql, 'Payment').rows.filter((p) => p.orgId === CRES_ORG && !p.deletedAt);
  const expenses = parseCopy(sql, 'Expense').rows.filter((e) => e.orgId === CRES_ORG && !e.deletedAt);

  console.log('[import] CresDynamics snapshot', {
    users: users.length,
    clients: clients.length,
    leads: leads.length,
    projects: projects.length,
    invoices: invoices.length,
    payments: payments.length,
    expenses: expenses.length,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: roleRows } = await client.query(`SELECT id, name FROM roles`);
    const roleIds = Object.fromEntries(roleRows.map((r) => [r.name, r.id]));
    for (const need of Object.values(ROLE_MAP)) {
      if (!roleIds[need]) throw new Error(`Missing role ${need} — run db:seed first`);
    }

    // Clear transactional CRM/finance data (keep roles/permissions)
    await client.query(`
      TRUNCATE TABLE
        payments,
        invoice_followups,
        invoices,
        expenses,
        salary_funding_requests,
        salary_payments,
        leave_requests,
        project_updates,
        project_assignments,
        project_documents,
        milestone_signoffs,
        client_change_requests,
        daily_reports,
        report_reactions,
        tasks,
        projects,
        clients,
        lead_engagements,
        lead_messages,
        leads,
        employees,
        notifications,
        messages,
        refresh_tokens,
        idempotency_keys,
        password_reset_otps,
        outbound_emails,
        user_settings,
        login_audit,
        action_audit_log,
        followup_alert_log,
        stale_lead_alert_log,
        invoice_email_log,
        admin_inbox_messages,
        failed_jobs
      RESTART IDENTITY CASCADE
    `);

    // Replace demo users with CresOS accounts (preserve password hashes)
    await client.query(`DELETE FROM users`);

    let importedUsers = 0;
    for (const u of users) {
      if (u.status === 'pending' && !roleByUser[u.id]) continue;
      const roleName = roleByUser[u.id] || 'sales';
      const roleId = roleIds[roleName];
      const uid = idFor(u.id);
      const status = u.status === 'active' ? 'active' : 'inactive';
      let avatar = u.profilePicture;
      if (avatar && avatar.startsWith('/uploads/profile-pictures/')) {
        avatar = avatar.replace('/uploads/profile-pictures/', '/uploads/avatars/');
      }
      await client.query(
        `INSERT INTO users (id, name, email, phone, password_hash, role_id, status, avatar_url, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)`,
        [
          uid,
          u.name,
          u.email.toLowerCase(),
          u.phone,
          u.passwordHash,
          roleId,
          status,
          avatar,
          u.createdAt || new Date().toISOString(),
          u.updatedAt || new Date().toISOString(),
        ]
      );
      importedUsers += 1;

      // Employee / payroll row for active staff (not clients)
      if (status === 'active' && roleName !== 'client') {
        const salary = Number(u.monthlySalary || 0);
        await client.query(
          `INSERT INTO employees (user_id, position, salary_amount, pay_cycle, next_of_kin, created_at, updated_at)
           VALUES ($1,$2,$3,'monthly',$4,COALESCE($5::timestamptz, NOW()), NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             position = EXCLUDED.position,
             salary_amount = EXCLUDED.salary_amount,
             next_of_kin = COALESCE(EXCLUDED.next_of_kin, employees.next_of_kin)`,
          [uid, u.jobTitle || roleName, salary, u.nextOfKin, u.hireDate]
        );
      }
    }

    // Clients
    for (const c of clients) {
      await client.query(
        `INSERT INTO clients (id, name, business_name, email, phone, converted_at, created_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, NOW()), COALESCE($6::timestamptz, NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [idFor(c.id), c.name, c.name, c.email, c.phone, c.createdAt]
      );
    }

    // Fallback admin for required created_by
    const { rows: adminFallback } = await client.query(
      `SELECT id FROM users WHERE status='active' ORDER BY
         CASE WHEN email='nelson.were@cresdynamics.com' THEN 0
              WHEN email='henry.were@cresdynamics.com' THEN 1
              ELSE 2 END
       LIMIT 1`
    );
    const fallbackUserId = adminFallback[0]?.id;
    if (!fallbackUserId) throw new Error('No active user to own imported records');

    // Leads
    for (const l of leads) {
      const owner = idFor(l.ownerId) || fallbackUserId;
      const clientName =
        clients.find((c) => c.id === l.clientId)?.name || l.title || 'Lead';
      const clientEmail = clients.find((c) => c.id === l.clientId)?.email || null;
      const clientPhone = clients.find((c) => c.id === l.clientId)?.phone || null;
      const status = l.projectId || l.approvalStatus === 'approved' ? 'converted' : 'contacting';
      await client.query(
        `INSERT INTO leads (id, name, phone, email, business_name, created_by, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,NOW()),COALESCE($9::timestamptz,NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [
          idFor(l.id),
          clientName,
          clientPhone,
          clientEmail,
          l.title,
          owner,
          status,
          l.createdAt,
          l.updatedAt,
        ]
      );
      if (l.clientId) {
        await client.query(`UPDATE clients SET lead_id = $1 WHERE id = $2`, [
          idFor(l.id),
          idFor(l.clientId),
        ]);
      }
    }

    // Projects
    for (const p of projects) {
      const createdBy = idFor(p.createdByUserId) || idFor(p.ownerUserId) || fallbackUserId;
      const developer = idFor(p.assignedDeveloperId);
      const approvedBy = idFor(p.approvedById);
      await client.query(
        `INSERT INTO projects (
           id, name, client_id, description, assigned_developer_id, created_by,
           status, value_amount, approved_by, approved_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          idFor(p.id),
          p.name,
          idFor(p.clientId),
          p.projectDetails || p.successCriteria || null,
          developer,
          createdBy,
          mapProjectStatus(p),
          p.price != null ? Number(p.price) : null,
          approvedBy,
          p.approvedAt,
          p.createdAt,
          p.updatedAt,
        ]
      );
    }

    // Invoices
    for (const inv of invoices) {
      const status = mapInvoiceStatus(inv.status);
      const amount = Number(inv.totalAmount || 0);
      const amountPaid = status === 'paid' ? amount : 0;
      await client.query(
        `INSERT INTO invoices (
           id, project_id, client_id, amount, amount_paid, status, due_date, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::timestamptz,$9::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          idFor(inv.id),
          idFor(inv.projectId),
          idFor(inv.clientId),
          amount,
          amountPaid,
          status,
          inv.dueDate ? inv.dueDate.slice(0, 10) : null,
          inv.createdAt,
          inv.updatedAt,
        ]
      );
    }

    // Payments (create placeholder invoice if unmatched)
    let orphanClientId = null;
    for (const pay of payments) {
      let invoiceId = idFor(pay.invoiceId);
      if (!invoiceId) {
        if (!orphanClientId) {
          orphanClientId = crypto.randomUUID();
          await client.query(
            `INSERT INTO clients (id, name, business_name, created_at)
             VALUES ($1, 'Unallocated receipts', 'CresOS import', NOW())`,
            [orphanClientId]
          );
        }
        invoiceId = crypto.randomUUID();
        const amt = Number(pay.amount);
        await client.query(
          `INSERT INTO invoices (id, client_id, amount, amount_paid, status, created_at, updated_at)
           VALUES ($1,$2,$3,$3,'paid',COALESCE($4::timestamptz,NOW()),NOW())`,
          [invoiceId, orphanClientId, amt, pay.receivedAt || pay.createdAt]
        );
      }
      const recordedBy = idFor(pay.createdByUserId) || fallbackUserId;
      await client.query(
        `INSERT INTO payments (id, invoice_id, amount, paid_at, recorded_by, bank_reference, created_at)
         VALUES ($1,$2,$3,COALESCE($4::timestamptz,NOW()),$5,$6,COALESCE($7::timestamptz,NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [
          idFor(pay.id),
          invoiceId,
          Number(pay.amount),
          pay.receivedAt || pay.createdAt,
          recordedBy,
          pay.reference || pay.mpesaRef || null,
          pay.createdAt,
        ]
      );
    }

    // Expenses
    for (const e of expenses) {
      const createdBy = idFor(e.beneficiaryUserId) || fallbackUserId;
      await client.query(
        `INSERT INTO expenses (
           id, category, amount, description, created_by, approval_status, approved_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,'approved',COALESCE($6::timestamptz,NOW()),COALESCE($6::timestamptz,NOW()))
         ON CONFLICT (id) DO NOTHING`,
        [
          idFor(e.id),
          mapExpenseCategory(e.category),
          Number(e.amount),
          [e.description, e.toolOrServiceName, e.notes].filter(Boolean).join(' — ') || e.category,
          createdBy,
          e.spentAt || e.createdAt,
        ]
      );
    }

    await client.query('COMMIT');
    console.log('[import] done', { importedUsers });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import] failed', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
