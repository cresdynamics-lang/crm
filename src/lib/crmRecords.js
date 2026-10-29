const { query } = require('../config/database');
const { AppError } = require('./errors');

const CRM_MUTATE_ROLES = ['admin', 'director', 'sales'];

function isCrmOwnerRole(user) {
  return ['admin', 'director'].includes(user?.role);
}

function canCrmMutate(user) {
  return CRM_MUTATE_ROLES.includes(user?.role);
}

function assertAlive(row, label = 'Record') {
  if (!row || row.deleted_at) {
    throw new AppError(`${label} not found`, 404, 'NOT_FOUND');
  }
}

async function loadLead(id) {
  const { rows } = await query(`SELECT * FROM leads WHERE id = $1`, [id]);
  return rows[0] || null;
}

function assertLeadWritable(user, lead) {
  assertAlive(lead, 'Lead');
  if (isCrmOwnerRole(user)) return;
  if (user.role === 'sales' && lead.created_by === user.id) return;
  throw new AppError('Forbidden', 403, 'FORBIDDEN');
}

async function loadClient(id) {
  const { rows } = await query(`SELECT * FROM clients WHERE id = $1`, [id]);
  return rows[0] || null;
}

function assertClientWritable(user, client) {
  assertAlive(client, 'Client');
  if (!canCrmMutate(user)) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
}

function canDeleteProject(user, project) {
  if (!project || project.deleted_at) return false;
  if (isCrmOwnerRole(user)) return true;
  return user.role === 'sales' && project.created_by === user.id;
}

function assertProjectDeletable(user, project) {
  assertAlive(project, 'Project');
  if (canDeleteProject(user, project)) return;
  throw new AppError('Forbidden', 403, 'FORBIDDEN');
}

module.exports = {
  CRM_MUTATE_ROLES,
  isCrmOwnerRole,
  canCrmMutate,
  assertAlive,
  loadLead,
  assertLeadWritable,
  loadClient,
  assertClientWritable,
  canDeleteProject,
  assertProjectDeletable,
};
