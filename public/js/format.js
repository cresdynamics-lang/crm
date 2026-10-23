/** Shared display helpers: KES, 21 Oct 2026 dates, +254 phones. */
const CresFormat = (() => {
  const DATE = { day: 'numeric', month: 'short', year: 'numeric' };
  const DATETIME = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };

  function parse(v) {
    if (v == null || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function date(v) {
    const d = parse(v);
    return d ? d.toLocaleDateString('en-GB', DATE) : '-';
  }

  function datetime(v) {
    const d = parse(v);
    return d ? d.toLocaleString('en-GB', DATETIME) : '-';
  }

  function money(n) {
    const num = Number(n);
    if (Number.isNaN(num)) return '-';
    return num.toLocaleString('en-KE', { style: 'currency', currency: 'KES' });
  }

  function digits(phone) {
    return String(phone || '').replace(/\D/g, '');
  }

  function waLink(phone) {
    const n = digits(phone);
    if (!n) return '';
    const intl = n.startsWith('254') ? n : n.replace(/^0/, '254');
    return `https://wa.me/${intl}`;
  }

  function telLink(phone) {
    const n = String(phone || '').replace(/\s+/g, '');
    return n ? `tel:${n}` : '';
  }

  return {
    date,
    datetime,
    money,
    waLink,
    telLink,
    PHONE_PLACEHOLDER: '+254 7xx xxx xxx',
  };
})();
