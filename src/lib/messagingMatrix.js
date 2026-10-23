/**
 * Community messaging — every staff role can message every other staff role.
 * Clients stay on the portal and are never in internal Community.
 */
const STAFF_ROLES = ['sales', 'developer', 'director', 'pm', 'admin', 'finance', 'hr'];

const MESSAGING_MATRIX = Object.fromEntries(
  STAFF_ROLES.map((role) => [role, STAFF_ROLES.slice()])
);
MESSAGING_MATRIX.client = [];

function canMessage(senderRole, recipientRole) {
  if (!senderRole || !recipientRole) return false;
  if (recipientRole === 'client' || senderRole === 'client') return false;
  return STAFF_ROLES.includes(senderRole) && STAFF_ROLES.includes(recipientRole);
}

module.exports = { MESSAGING_MATRIX, STAFF_ROLES, canMessage };
