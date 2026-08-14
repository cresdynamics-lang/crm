/**
 * Community messaging matrix - enforced server-side on /api/messages.
 * Finance has NO chat (notifications feed only).
 * Clients are NEVER in internal Community.
 * Admin can message everyone (except clients - clients aren't in Community).
 */
const MESSAGING_MATRIX = {
  sales: ['developer', 'director', 'pm', 'admin'],
  developer: ['sales', 'director', 'pm', 'admin'],
  director: ['sales', 'developer', 'pm', 'admin'],
  pm: ['sales', 'developer', 'director', 'admin'],
  admin: ['sales', 'developer', 'director', 'pm', 'finance', 'hr', 'admin'],
  finance: [], // system notification feed only
  hr: ['admin'], // HR can reach admin; no peer chat matrix beyond that
  client: [], // not in Community at all
};

function canMessage(senderRole, recipientRole) {
  if (!senderRole || !recipientRole) return false;
  if (recipientRole === 'client' || senderRole === 'client') return false;
  const allowed = MESSAGING_MATRIX[senderRole] || [];
  return allowed.includes(recipientRole);
}

module.exports = { MESSAGING_MATRIX, canMessage };
