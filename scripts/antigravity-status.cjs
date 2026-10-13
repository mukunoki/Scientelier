// Official statusLine stdin -> an allowlisted local quota snapshot. No network,
// credentials, email, transcripts, prompts or terminal output are retained.
const { writeFileSync, renameSync, unlinkSync } = require('node:fs');
function sanitize(value, now = new Date().toISOString()) {
  if (!value || value.product !== 'antigravity' || !value.quota || typeof value.quota !== 'object' || Array.isArray(value.quota)) return;
  const quota = Object.create(null);
  for (const [id,q] of Object.entries(value.quota).slice(0,100)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._():/-]{0,119}$/.test(id) || !q || typeof q.remaining_fraction !== 'number' || !Number.isFinite(q.remaining_fraction) || q.remaining_fraction < 0 || q.remaining_fraction > 1) continue;
    const reset = typeof q.reset_time === 'string' && /^\d{4}-\d\d-\d\dT/.test(q.reset_time) && Number.isFinite(Date.parse(q.reset_time)) ? new Date(q.reset_time).toISOString() : undefined;
    quota[id] = { remaining_fraction:q.remaining_fraction, ...(reset ? {reset_time:reset} : {}) };
  }
  if (!Object.keys(quota).length) return;
  return { version:1, observedAt:now, quota,
    ...(['Free','Pro','Ultra','AI Pro','AI Ultra'].includes(value.plan_tier) ? {plan:value.plan_tier} : {}) };
}
module.exports = { sanitize };
if (require.main === module) {
  let input='', tooLarge=false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if ((input.length + chunk.length) > 262144) { tooLarge=true; input=''; } else if (!tooLarge) input+=chunk; });
  process.stdin.on('end', () => {
    let temporary;
    try {
      if (tooLarge || !process.argv[2]) return;
      const data=sanitize(JSON.parse(input)); if (!data) return;
      temporary=`${process.argv[2]}.${process.pid}.tmp`;
      writeFileSync(temporary,JSON.stringify(data),{mode:0o600,flag:'wx'});
      renameSync(temporary,process.argv[2]);
    } catch { /* Status-line failures must not interfere with the user's CLI. */ }
    finally { if (temporary) { try { unlinkSync(temporary); } catch {} } }
  });
}
