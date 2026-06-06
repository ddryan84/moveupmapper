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

  const balance  = fmtK(summary.loanBalance);
  const fromRate = typeof summary.currentRate === 'number' ? summary.currentRate + '%' : '—';
  const toRate   = typeof summary.newRate     === 'number' ? summary.newRate     + '%' : '—';
  const savings  = fmtK(Math.abs(summary.monthlySavings ?? 0));
  const savingsLabel = (summary.monthlySavings ?? 0) >= 0 ? `Save ${savings}/mo` : `+${savings}/mo`;
  const breakEven = summary.breakEvenMonths != null
    ? `Break-even: ${summary.breakEvenMonths} mo`
    : 'No break-even';

  const title = `Refi: ${balance} at ${fromRate} → ${toRate} | Move Up Mapper`;
  const desc  = `${savingsLabel} · ${breakEven} · Interest saved: ${fmtK(summary.interestSaved)}`;

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

export const config = { path: '/refi' };
