/**
 * Session 3 placeholder. The real dashboard (B9) is session 4; this exists so the root
 * URL is not a 404 while the API is live.
 */
export function renderDashboard(data: { metrics: any; queue: any[]; agent?: string }): string {
  const t = data.metrics.totals;
  const rows = data.queue
    .map(
      (r) =>
        `<tr><td><code>${r.run_id}</code></td><td>${r.agent}</td><td>${r.started_at.slice(0, 10)}</td><td class="v ${r.verdict}">${r.verdict}</td><td>${r.status}</td></tr>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Second Look</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 20px;max-width:860px;margin-inline:auto;color:#111}
 h1{font-size:28px;margin:0 0 4px} p.sub{color:#555;margin:0 0 28px}
 .counters{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:28px}
 .counters div{min-width:84px} .counters b{display:block;font-size:30px;line-height:1.1}
 .counters span{color:#666;font-size:13px}
 table{border-collapse:collapse;width:100%;font-size:14px}
 td,th{text-align:left;padding:7px 10px;border-bottom:1px solid #e6e6e6}
 .v.FAIL{color:#b00020;font-weight:600} .v.PASS{color:#1b7f3b} .v.NEEDS_HUMAN{color:#a35b00;font-weight:600}
 code{font:13px ui-monospace,monospace}
 footer{margin-top:32px;color:#666;font-size:13px}
</style>
<h1>Second Look</h1>
<p class="sub">Checks what an AI agent told the customer against what its tools actually did. Synthetic, labelled data.</p>
<div class="counters">
 <div><b>${t.runs}</b><span>reviewed</span></div>
 <div><b>${t.pass}</b><span>pass</span></div>
 <div><b>${t.fail}</b><span>fail</span></div>
 <div><b>${t.needs_human}</b><span>needs human</span></div>
 <div><b>${t.pending}</b><span>pending</span></div>
</div>
<table><thead><tr><th>run</th><th>agent</th><th>day</th><th>verdict</th><th>status</th></tr></thead><tbody>${rows}</tbody></table>
<footer>Reviewer's own measured precision ${(data.metrics.judge.precision * 100).toFixed(0)}% / recall ${(data.metrics.judge.recall * 100).toFixed(0)}% on ${data.metrics.judge.seed_version} (docs/eval-report.json). The full dashboard lands in session 4.</footer>`;
}
