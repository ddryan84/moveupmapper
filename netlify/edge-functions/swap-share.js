export default async (request, context) => {
  const url = new URL(request.url);
  const shareParam = url.searchParams.get('share');

  if (!shareParam) return context.next();

  let summary = null;
  try {
    const decoded = JSON.parse(atob(shareParam));
    summary = decoded._s || null;
  } catch (_) {}

  const response = await context.next();
  if (!summary) return response;

  const fmtK = n => {
    if (typeof n !== 'number' || isNaN(n)) return '—';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1000)    return sign + '$' + Math.round(abs / 1000) + 'K';
    return sign + '$' + Math.round(abs);
  };
  const fmtPct = n => typeof n === 'number' ? (n * 100).toFixed(1) + '%' : '—';

  const from    = fmtK(summary.homeValuation);
  const to      = fmtK(summary.purchasePrice);
  const monthly = fmtK(summary.totalMonthly);
  const dp      = fmtK(summary.downPayment);
  const dpPct   = fmtPct(summary.dpPct);
  const remaining = fmtK(summary.cashRemaining);

  const title = `Home Swap: ${from} → ${to} | Move Up Mapper`;
  const desc  = `Monthly cost: ${monthly} · Down payment: ${dp} (${dpPct}) · Cash after purchase: ${remaining}`;

  const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  let html = await response.text();
  html = html
    .replace(/(<meta property="og:title"\s+content=")[^"]*(")/,     `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description"\s+content=")[^"]*"/, `$1${esc(desc)}"`)
    .replace(/(<meta name="twitter:title"\s+content=")[^"]*(")/,    `$1${esc(title)}$2`)
    .replace(/(<meta name="twitter:description"\s+content=")[^"]*"/,`$1${esc(desc)}"`);

  return new Response(html, {
    status: response.status,
    headers: response.headers,
  });
};

export const config = { path: '/swap' };
