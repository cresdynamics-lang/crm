/**
 * Community messaging matrix - enforced server-side on /api/messages.
 * Clients are NEVER in internal Community.
 * Admin can message everyone (except clients - clients aren't in Community).
 */
const MESSAGING_MATRIX = {
  sales: ['developer', 'director', 'pm', 'admin', 'finance'],
  developer: ['sales', 'director', 'pm', 'admin'],
  director: ['sales', 'developer', 'pm', 'admin', 'finance'],
  pm: ['sales', 'developer', 'director', 'admin', 'finance'],
  admin: ['sales', 'developer', 'director', 'pm', 'finance', 'hr', 'admin'],
  finance: ['admin', 'director', 'sales', 'pm', 'hr'],
  hr: ['admin', 'finance'],
  client: [],
};

function canMessage(senderRole, recipientRole) {
  if (!senderRole || !recipientRole) return false;
  if (recipientRole === 'client' || senderRole === 'client') return false;
  const allowed = MESSAGING_MATRIX[senderRole] || [];
  return allowed.includes(recipientRole);
}

module.exports = { MESSAGING_MATRIX, canMessage };
