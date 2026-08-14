/**
 * Cres Dynamics billing / letterhead defaults for invoices & receipts.
 * Overridable via system_settings.key = 'company_profile'.
 * Ready to map against an uploaded invoice PDF template.
 */
const DEFAULT_COMPANY = {
  legalName: 'Cres Dynamics',
  tradingName: 'Cres Dynamics',
  tagline: 'Software & digital solutions',
  addressLines: [
    'Caribbean Regional Office',
    'Kingston, Jamaica',
    'West Indies',
  ],
  phone: '+1 (876) 000-0000',
  email: 'billing@cresdynamics.com',
  financeEmail: 'finance@cresdynamics.com',
  emailFromName: 'Cres Dynamics Finance',
  website: 'www.cresdynamics.com',
  taxLabel: 'Tax / VAT ID',
  taxId: 'CD-CARIB-0001',
  currency: 'USD',
  bankName: 'First Caribbean International Bank',
  bankAccountName: 'Cres Dynamics',
  bankAccountNumber: 'XXXX-XXXX-XXXX',
  bankSwift: 'FCIBJMKN',
  paymentNote: 'Please reference the invoice number on all remittances.',
  footer: 'Thank you for your business with Cres Dynamics.',
};

async function loadCompanyProfile(queryFn) {
  try {
    const { rows } = await queryFn(
      `SELECT value FROM system_settings WHERE key = 'company_profile' LIMIT 1`
    );
    if (rows[0]?.value && typeof rows[0].value === 'object') {
      return { ...DEFAULT_COMPANY, ...rows[0].value };
    }
  } catch {
    // DB may be unavailable during early boot — use defaults
  }
  return { ...DEFAULT_COMPANY };
}

module.exports = { DEFAULT_COMPANY, loadCompanyProfile };
