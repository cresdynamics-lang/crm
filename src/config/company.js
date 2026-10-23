/**
 * Cres Dynamics billing / letterhead defaults for invoices & receipts.
 * Overridable via system_settings.key = 'company_profile'.
 */
const DEFAULT_COMPANY = {
  legalName: 'Cres Dynamics Ltd',
  tradingName: 'Cres Dynamics Ltd',
  tagline: 'Building Intelligent Systems that Run Your Business',
  addressLines: [
    'P.O. BOX 1112 – 00100, NAIROBI, KENYA',
    'Kivuli Towers, 3rd floor, Westlands, Nairobi',
  ],
  phone: '+254 743 869 564 / +254 708 805 496',
  email: 'info@cresdynamics.com',
  financeEmail: 'finance@cresdynamics.com',
  emailFromName: 'Cres Dynamics Finance',
  website: 'www.cresdynamics.com',
  taxLabel: 'KRA PIN',
  taxId: 'P052570833B',
  currency: 'KES',
  bankName: 'I & M Bank',
  bankAccountName: 'Cres Dynamics Ltd',
  bankAccountNumber: '01209982836350',
  bankBranch: 'Ongata Rongai',
  bankSwift: '',
  mpesaPaybill: '542542',
  mpesaAccount: '43869',
  paymentNote: 'Please use the invoice number as your payment reference.',
  lateFeeNote:
    'Late payments attract 2% monthly interest after the due date. For payment queries contact info@cresdynamics.com or +254 708 805 496.',
  footer: 'Thank you for your business. Building Intelligent Systems that Run Your Business — cresdynamics.com',
  logoUrl: '/brand/logo.png?v=20261023',
  signatureUrl: '/brand/signature.png?v=20260815e',
  financeSignatureUrl: '/brand/signature-scholastica.png?v=20260815f',
  invoicedBy: {
    name: 'Scholastica Omoro',
    title: 'Finance, Cres Dynamics Ltd',
  },
  authorisedBy: {
    name: 'Nelson Were',
    title: 'Chief Executive Officer, Cres Dynamics Ltd',
  },
};

async function loadCompanyProfile(queryFn) {
  try {
    const { rows } = await queryFn(
      `SELECT value FROM system_settings WHERE key = 'company_profile' LIMIT 1`
    );
    if (rows[0]?.value && typeof rows[0].value === 'object') {
      const merged = { ...DEFAULT_COMPANY, ...rows[0].value };
      if (rows[0].value.authorisedBy) {
        merged.authorisedBy = {
          ...DEFAULT_COMPANY.authorisedBy,
          ...rows[0].value.authorisedBy,
        };
      }
      if (rows[0].value.invoicedBy) {
        merged.invoicedBy = {
          ...DEFAULT_COMPANY.invoicedBy,
          ...rows[0].value.invoicedBy,
        };
      }
      return lockMpesaPaybill(merged);
    }
  } catch {
    // DB may be unavailable during early boot — use defaults
  }
  return lockMpesaPaybill({ ...DEFAULT_COMPANY });
}

function lockMpesaPaybill(company) {
  return {
    ...company,
    mpesaPaybill: '542542',
    mpesaAccount: '43869',
  };
}

module.exports = { DEFAULT_COMPANY, loadCompanyProfile };
