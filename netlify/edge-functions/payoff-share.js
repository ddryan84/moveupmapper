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
  const fmtMonths = mo => {
    if (!mo || mo <= 0) return '—';
    const yrs = Math.floor(mo / 12);
    const mos = mo % 12;
    if (yrs === 0) return mo + ' mo';
    if (mos === 0) return yrs + (yrs === 1 ? ' yr' : ' yrs');
    return yrs + ' yr ' + mos + ' mo';
  };

  const balance  = fmtK(summary.loanBalance);
  const rate     = typeof summary.interestRate === 'number' ? summary.interestRate + '%' : '—';
  const extra    = summary.extraMonthly > 0 ? `+${fmtK(summary.extraMonthly)}/mo` :
                   summary.lumpSum      > 0 ? `+${fmtK(summary.lumpSum)} lump sum` : '';
  const saved    = fmtK(summary.interestSaved);
  const earlier  = fmtMonths(summary.monthsSaved);

  const title = `Payoff: ${balance} at ${rate}${extra ? ` · ${extra}` : ''} | Move Up Mapper`;
  const desc  = `Save ${saved} in interest · Pay off ${earlier} early`;

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

export const config = { path: '/payoff' };
