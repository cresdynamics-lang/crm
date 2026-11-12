/**
 * Scam / phishing check for incoming admin-inbox email.
 *
 * Rule-based on purpose: fast, free, explainable, and works when the AI is
 * down. Each hit adds to a score and a plain-English reason the admin sees.
 * Score >= 60 is flagged as "likely scam" (the admin decides; nothing is
 * deleted automatically).
 */
const RULES = [
  { re: /\b(verify|confirm|update|validate)\b.{0,40}\b(account|password|login|credentials|mailbox|e-?mail)\b/i, score: 30, why: 'Asks you to verify an account or password' },
  { re: /\b(password|passcode|pin|otp|one[- ]time code)\b.{0,30}\b(expire|reset|suspend|deactivat)/i, score: 30, why: 'Says a password or account will expire or be suspended' },
  { re: /\b(gift ?cards?|itunes|steam card|google play card)\b/i, score: 35, why: 'Mentions gift cards' },
  { re: /\b(bitcoin|btc|usdt|crypto|wallet address|binance)\b/i, score: 25, why: 'Mentions cryptocurrency payment' },
  { re: /\b(lottery|you have won|winner|inheritance|beneficiary|next of kin|million (dollars|usd))\b/i, score: 40, why: 'Prize, lottery or inheritance claim' },
  { re: /\b(wire transfer|western union|moneygram|change (of|in) (bank|account) details|new bank details)\b/i, score: 30, why: 'Asks to send money or change bank details' },
  { re: /\b(urgent|immediately|within 24 hours|act now|final notice|last warning)\b/i, score: 10, why: 'Pressure to act urgently' },
  { re: /\b(click (here|below|the link)|log ?in here|sign ?in here)\b/i, score: 10, why: 'Pushes you to click a link to sign in' },
  { re: /https?:\/\/\d{1,3}(\.\d{1,3}){3}/i, score: 30, why: 'Link goes to a bare IP address' },
  { re: /https?:\/\/[^\s/]*(bit\.ly|tinyurl|t\.co|is\.gd|rb\.gy|cutt\.ly)\//i, score: 15, why: 'Uses a link shortener that hides the destination' },
  { re: /\b(dear (customer|user|sir\/madam|account holder|beneficiary))\b/i, score: 10, why: 'Generic greeting instead of a name' },
  { re: /\b(m-?pesa|paybill|till number)\b.{0,60}\b(reversal|reverse|sent (by )?mistake|wrong number)\b/i, score: 35, why: 'M-Pesa "sent by mistake / reversal" pattern' },
];

const BRANDS = [
  // [word in the display name, domains that brand really sends from]
  [/\bsafaricom\b|\bm-?pesa\b/i, ['safaricom.co.ke', 'safaricom.com']],
  [/\bkra\b|\bitax\b/i, ['kra.go.ke']],
  [/\bequity bank\b/i, ['equitybank.co.ke', 'equitygroupholdings.com']],
  [/\bkcb\b/i, ['kcbgroup.com']],
  [/\bstanbic\b/i, ['stanbic.com', 'stanbicbank.co.ke', 'standardbank.com']],
  [/\bpaypal\b/i, ['paypal.com']],
  [/\bmicrosoft\b|\boffice ?365\b|\boutlook\b/i, ['microsoft.com', 'microsoftonline.com', 'office.com', 'outlook.com']],
  [/\bgoogle\b|\bgmail\b/i, ['google.com', 'accounts.google.com']],
  [/\bapple\b|\bicloud\b/i, ['apple.com', 'icloud.com']],
  [/\bdhl\b/i, ['dhl.com']],
  [/\bnamecheap\b/i, ['namecheap.com']],
];

function domainOf(addr) {
  return String(addr || '').toLowerCase().split('@')[1] || '';
}

/**
 * @returns {{ score: number, reasons: string[], likely: boolean }}
 */
function assessScam({ fromEmail, fromName, replyTo, subject, bodyText, attachments = [] }) {
  const text = `${subject || ''}\n${String(bodyText || '').slice(0, 20000)}`;
  let score = 0;
  const reasons = [];
  const hit = (n, why) => {
    score += n;
    if (!reasons.includes(why)) reasons.push(why);
  };

  for (const r of RULES) if (r.re.test(text)) hit(r.score, r.why);

  const fromDomain = domainOf(fromEmail);
  const replyDomain = domainOf(replyTo);
  if (replyTo && replyDomain && fromDomain && replyDomain !== fromDomain) {
    hit(25, `Replies would go to a different address (${replyTo})`);
  }
  // Display name claims a well-known brand but the address is not that brand's domain
  for (const [re, domains] of BRANDS) {
    const m = String(fromName || '').match(re);
    if (m && !domains.some((d) => fromDomain === d || fromDomain.endsWith(`.${d}`))) {
      hit(30, `Name says "${m[0]}" but the address is ${fromEmail}`);
      break;
    }
  }
  for (const a of attachments) {
    const name = String(a.name || a.filename || '');
    if (/\.(exe|scr|js|vbs|bat|cmd|jar|iso|img|apk|html?|zip|rar|7z)$/i.test(name)) {
      hit(35, `Risky attachment type (${name})`);
    }
  }

  score = Math.min(100, score);
  return { score, reasons, likely: score >= 60 };
}

module.exports = { assessScam };
