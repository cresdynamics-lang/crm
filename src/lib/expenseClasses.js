/** Internal = company running costs. External = client/market/out-of-house spend. */
const INTERNAL_CATEGORIES = ['salary', 'salaries', 'hosting'];

function expenseClass(category) {
  return INTERNAL_CATEGORIES.includes(String(category || '').toLowerCase()) ? 'internal' : 'external';
}

function isInternalCategory(category) {
  return expenseClass(category) === 'internal';
}

module.exports = { INTERNAL_CATEGORIES, expenseClass, isInternalCategory };
