/**
 * The dashboard. One server-rendered page, no framework, no build step.
 *
 * It answers three questions in the order an operations person asks them:
 *   is this agent getting worse   ->  the sparkline
 *   what is it getting wrong      ->  the taxonomy bar
 *   which calls do I read now     ->  the queue, with the evidence already quoted
 *
 * Every claim shows the event or catalogue key it was checked against, because a verdict
 * without its evidence is exactly the kind of confident assertion this tool exists to catch.
 */

interface Claim {
  turn_index: number;
  kind: string;
  text: string;
  verdict: string;
  checker: string;
  risk: string | null;
  evidence: { checked: string; event_index: number | null; catalogue_key: string | null; reason: string | null };
}

interface QueueItem {
  run_id: string;
  agent: string;
  started_at: string;
  status: string;
  verdict: string;
  transcript: Array<{ i: number; role: string; text: string }>;
  claims: Claim[];
  human: { decision: string; note: string | null } | null;
}

interface Metrics {
  days: Array<{ day: string; runs: number; fail: number; needs_human: number; contradicted_by_kind: Record<string, number> }>;
  totals: { runs: number; fail: number; needs_human: number; pass: number; pending: number; contradicted_by_kind: Record<string, number> };
  agents: string[];
  judge: { precision: number; recall: number; model: string; seed_version: string; measured_at: string; from: string };
}

const KIND_CHIP: Record<string, string> = {
  booking: 'booking',
  price: 'price',
  transfer: 'transfer',
  kb_fact: 'business fact',
  promise: 'follow-up',
  other: 'other',
};

const KIND_LABEL: Record<string, string> = {
  booking: 'bookings that were never made',
  price: 'prices that were wrong',
  transfer: 'transfers that never happened',
  kb_fact: 'facts about the business',
  promise: 'messages never sent',
  other: 'other',
};

const KIND_COLOR: Record<string, string> = {
  booking: '#b42318',
  price: '#b54708',
  transfer: '#6941c6',
  kb_fact: '#026aa2',
  promise: '#5d6b98',
  other: '#98a2b3',
};

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(d)}/${Number(m)}`;
}

/** One bar per day: total calls in grey, the ones that failed in red. */
function sparkline(days: Metrics['days']): string {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  if (sorted.length < 2) return `<p class="empty">Not enough days yet to draw a trend.</p>`;
  const max = Math.max(...sorted.map((d) => d.runs), 1);
  const bars = sorted
    .map((d) => {
      const h = (d.runs / max) * 100;
      const failShare = d.runs === 0 ? 0 : (d.fail / d.runs) * 100;
      const rate = d.runs === 0 ? 0 : Math.round((d.fail / d.runs) * 100);
      return `<i style="height:${h.toFixed(1)}%" title="${esc(d.day)}: ${d.fail} of ${d.runs} calls failed (${rate}%)"><u style="height:${failShare.toFixed(1)}%"></u></i>`;
    })
    .join('');
  const totalRuns = sorted.reduce((n, d) => n + d.runs, 0);
  const totalFail = sorted.reduce((n, d) => n + d.fail, 0);
  const overall = totalRuns === 0 ? 0 : Math.round((totalFail / totalRuns) * 100);
  return `<div class="bars">${bars}</div>
  <p class="barcap"><span>${esc(shortDay(sorted[0].day))}</span><b>${overall}% of calls failed over ${sorted.length} days</b><span>${esc(shortDay(sorted[sorted.length - 1].day))}</span></p>`;
}

function taxonomy(byKind: Record<string, number>): string {
  const entries = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (total === 0) return `<p class="empty">No contradicted claims yet.</p>`;

  const bar = entries
    .map(([kind, n]) => `<span style="width:${((n / total) * 100).toFixed(2)}%;background:${KIND_COLOR[kind] ?? '#98a2b3'}" title="${esc(kind)}: ${n}"></span>`)
    .join('');
  const legend = entries
    .map(
      ([kind, n]) =>
        `<li><i style="background:${KIND_COLOR[kind] ?? '#98a2b3'}"></i><b>${n}</b> ${esc(KIND_LABEL[kind] ?? kind)}</li>`,
    )
    .join('');
  return `<div class="bar">${bar}</div><ul class="legend">${legend}</ul>`;
}

function claimRow(claim: Claim): string {
  const mark = claim.verdict === 'SUPPORTED' ? '✓' : claim.verdict === 'CONTRADICTED' ? '✕' : '?';
  const cls = claim.verdict.toLowerCase();
  const evidence = claim.evidence.reason
    ? `${claim.evidence.checked} — ${claim.evidence.reason}`
    : claim.evidence.checked;
  return `<li class="claim ${cls}">
    <span class="mark" aria-hidden="true">${mark}</span>
    <div>
      <p class="said">“${esc(claim.text)}”</p>
      <p class="checked"><b>checked:</b> ${esc(evidence)}</p>
    </div>
  </li>`;
}

function queueItem(item: QueueItem, index: number): string {
  const bad = item.claims.filter((c) => c.verdict === 'CONTRADICTED');
  const unknown = item.claims.filter((c) => c.verdict === 'UNVERIFIABLE');
  const lead = bad[0] ?? unknown[0] ?? null;
  const headline = lead ? esc(lead.text) : 'No claim could be checked in this call.';
  const kind = lead ? (KIND_CHIP[lead.kind] ?? lead.kind) : 'unknown';
  const kindColor = lead ? (KIND_COLOR[lead.kind] ?? '#98a2b3') : '#98a2b3';
  const verdictWord = item.verdict === 'FAIL' ? 'contradicted by its own logs' : 'no evidence either way';

  const transcript = item.transcript
    .map((turn) => {
      const claims = item.claims.filter((c) => c.turn_index === turn.i);
      const flag = claims.some((c) => c.verdict === 'CONTRADICTED')
        ? ' flagged'
        : claims.some((c) => c.verdict === 'UNVERIFIABLE')
          ? ' unknown'
          : '';
      return `<div class="turn ${turn.role}${flag}"><span>${turn.role === 'assistant' ? 'agent' : 'caller'}</span><p>${esc(turn.text)}</p></div>`;
    })
    .join('');

  const decided = item.human
    ? `<p class="decided">A human looked at this: <b>${esc(item.human.decision.replace('_', ' '))}</b>${item.human.note ? ` — ${esc(item.human.note)}` : ''}</p>`
    : `<div class="actions" data-run="${esc(item.run_id)}">
         <button data-decision="agree">Agree</button>
         <button data-decision="override_pass" class="ghost">Override: it was fine</button>
       </div>`;

  return `<details class="item ${item.verdict.toLowerCase()}${item.human ? ' done' : ''}" id="run-${esc(item.run_id)}"${index === 0 ? ' open' : ''}>
  <summary>
    <p class="tagline"><span class="chip" style="--chip:${kindColor}">${esc(kind)}</span><span class="verdictword ${item.verdict.toLowerCase()}">${verdictWord}</span></p>
    <p class="headline">“${headline}”</p>
    <p class="meta">${esc(item.agent)} · ${esc(item.started_at.slice(0, 10))} · <code>${esc(item.run_id)}</code></p>
  </summary>
  <div class="body">
    <ul class="claims">${item.claims.map(claimRow).join('')}</ul>
    <div class="transcript">${transcript}</div>
    ${decided}
  </div>
</details>`;
}

export function renderDashboard(data: {
  metrics: Metrics;
  queue: QueueItem[];
  agent?: string;
  backlog?: number;
}): string {
  const { metrics, queue, agent } = data;
  const t = metrics.totals;
  // The backlog is the whole undecided pile. The queue below is one page of it, so the heading
  // has to name the pile and the subline has to admit how much of it you are looking at —
  // otherwise the heading reads as a contradiction of the counters above.
  const undecidedHere = queue.filter((q) => !q.human).length;
  const backlog = data.backlog ?? undecidedHere;
  const showing = backlog > undecidedHere ? `<p class="showing">showing the ${undecidedHere} most recent</p>` : '';

  const agentTabs = ['', ...metrics.agents]
    .map(
      (name) =>
        `<a class="${(agent ?? '') === name ? 'on' : ''}" href="${name ? `/?agent=${encodeURIComponent(name)}` : '/'}">${name ? esc(name) : 'all agents'}</a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Second Look — what your agent said vs what it did</title>
<meta name="description" content="Checks every claim an AI agent made to a customer against its own tool logs.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%2316181d'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11.5' stroke='%23fff' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
 *{box-sizing:border-box}
 :root{
   --ink:#16181d; --muted:#6b7280; --rule:#e6e6e3; --bg:#fbfbf9; --card:#fff;
   --fail:#b42318; --pass:#067647; --unknown:#b54708;
 }
 html{-webkit-text-size-adjust:100%}
 body{margin:0;background:var(--bg);color:var(--ink);
   font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
   font-variant-numeric:tabular-nums;}
 .wrap{max-width:900px;margin:0 auto;padding:40px 20px 80px}
 header h1{font-size:15px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 20px;color:var(--muted);font-weight:600}
 .lede{font-size:clamp(25px,4.4vw,36px);line-height:1.22;letter-spacing:-.02em;margin:0 0 10px;font-weight:600;max-width:20ch}
 .sub{margin:0 0 30px;color:var(--muted);max-width:56ch}
 nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:30px}
 nav a{font-size:14px;padding:5px 12px;border:1px solid var(--rule);border-radius:999px;
   text-decoration:none;color:var(--muted);background:var(--card)}
 nav a.on{background:var(--ink);border-color:var(--ink);color:#fff}
 section{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:22px;margin-bottom:18px}
 h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 16px;font-weight:600}
 .counters{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
 .counters div b{display:block;font-size:clamp(30px,5vw,42px);line-height:1;letter-spacing:-.03em}
 .counters div span{font-size:13px;color:var(--muted)}
 .counters .is-fail b{color:var(--fail)} .counters .is-unknown b{color:var(--unknown)} .counters .is-pass b{color:var(--pass)}
 .bars{display:flex;align-items:flex-end;gap:3px;height:72px}
 .bars i{flex:1;background:#e8e8e4;border-radius:2px;display:flex;align-items:flex-end;min-height:2px}
 .bars u{display:block;width:100%;background:var(--fail);border-radius:2px;text-decoration:none}
 .barcap{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin:9px 0 0}
 .barcap b{color:var(--ink);font-weight:600}
 .bar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:#f0f0ee}
 .bar span{display:block;height:100%}
 .legend{list-style:none;display:flex;flex-wrap:wrap;gap:8px 22px;padding:0;margin:14px 0 0;font-size:14px;color:var(--muted)}
 .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px}
 .legend b{color:var(--ink)}
 .item{background:var(--card);border:1px solid var(--rule);border-radius:12px;margin-bottom:10px;overflow:hidden}
 .item.done{opacity:.62}
 .item summary{padding:18px 20px;cursor:pointer;list-style:none}
 .item summary::-webkit-details-marker{display:none}
 .item summary:hover{background:#fcfcfb}
 .tagline{display:flex;align-items:center;gap:9px;margin:0 0 9px;flex-wrap:wrap}
 .chip{font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:600;padding:3px 8px;
   border-radius:5px;color:var(--chip);background:color-mix(in srgb,var(--chip) 9%,#fff);
   border:1px solid color-mix(in srgb,var(--chip) 22%,#fff)}
 .verdictword{font-size:13px;color:var(--muted)}
 .verdictword.fail{color:var(--fail)}
 .verdictword.needs_human{color:var(--unknown)}
 .headline{margin:0 0 6px;font-size:17px;line-height:1.4;font-weight:500}
 .meta{margin:0;font-size:13px;color:var(--muted)}
 .meta code{font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
 .body{padding:0 20px 20px;border-top:1px solid var(--rule)}
 .claims{list-style:none;padding:0;margin:18px 0}
 .claim{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid #f2f2f0}
 .claim:last-child{border-bottom:0}
 .claim .mark{flex:none;width:19px;height:19px;border-radius:50%;font-size:11px;line-height:19px;text-align:center;margin-top:3px;color:#fff}
 .claim.supported .mark{background:var(--pass)} .claim.contradicted .mark{background:var(--fail)} .claim.unverifiable .mark{background:var(--unknown)}
 .said{margin:0;font-size:15px}
 .checked{margin:3px 0 0;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);word-break:break-word}
 .checked b{color:var(--ink);font-weight:600}
 .transcript{border:1px solid var(--rule);border-radius:8px;padding:6px 14px;background:#fcfcfb}
 .turn{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f2f2f0;font-size:14.5px}
 .turn:last-child{border-bottom:0}
 .turn>span{flex:none;width:52px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding-top:3px}
 .turn p{margin:0}
 .turn.flagged{background:#fef6f5;margin:0 -14px;padding-inline:14px}
 .turn.flagged p{font-weight:500}
 .turn.unknown{background:#fffcf3;margin:0 -14px;padding-inline:14px}
 .actions{display:flex;gap:9px;margin-top:18px;flex-wrap:wrap}
 .actions button{font:inherit;font-size:14px;padding:9px 18px;border-radius:8px;border:1px solid var(--ink);
   background:var(--ink);color:#fff;cursor:pointer}
 .actions button.ghost{background:var(--card);color:var(--ink)}
 .actions button[disabled]{opacity:.5;cursor:default}
 .decided{margin:18px 0 0;font-size:14px;color:var(--muted)}
 .empty{color:var(--muted);margin:0;font-size:14px}
 .queuehead{margin:34px 0 16px}
 .queuehead h2{margin:0 0 5px}
 .queuehead p{margin:0;font-size:14px;color:var(--muted);max-width:60ch}
 .queuehead .showing{margin:0 0 7px;font-size:13px;letter-spacing:.02em;color:var(--muted)}
 footer{margin-top:34px;padding-top:20px;border-top:1px solid var(--rule);font-size:13px;color:var(--muted)}
 footer a{color:inherit}
 @media(max-width:620px){
   .wrap{padding:28px 15px 60px}
   .counters{grid-template-columns:repeat(2,1fr);gap:20px 14px}
   section{padding:18px}
   .turn{flex-direction:column;gap:2px}
   .turn>span{width:auto}
 }
</style></head>
<body><div class="wrap">
<header>
  <h1>Second Look</h1>
  <p class="lede">“You’re booked for Tuesday at 3” only counts if there is a booking for Tuesday at 3.</p>
  <p class="sub">This reads what an AI phone agent told each customer, then checks every claim it made against the agent’s own tool logs. Below is a fictional home-services company, ${t.runs} labelled synthetic calls.</p>
</header>

<nav>${agentTabs}</nav>

<section>
  <h2>Last 30 days</h2>
  <div class="counters">
    <div><b>${t.runs}</b><span>calls reviewed</span></div>
    <div class="is-pass"><b>${t.pass}</b><span>checked out</span></div>
    <div class="is-fail"><b>${t.fail}</b><span>said something untrue</span></div>
    <div class="is-unknown"><b>${t.needs_human}</b><span>nobody could check</span></div>
  </div>
</section>

<section>
  <h2>Failure rate</h2>
  ${sparkline(metrics.days)}
</section>

<section>
  <h2>What it got wrong</h2>
  ${taxonomy(t.contradicted_by_kind)}
</section>

<div class="queuehead">
  <h2>${backlog} ${backlog === 1 ? 'call needs' : 'calls need'} a person</h2>
  ${showing}
  <p>Each one opens to the claim, the evidence it was checked against, and the transcript. Agree or override — that click is the loop closing.</p>
</div>
${queue.length ? queue.map((item, i) => queueItem(item, i)).join('') : '<section><p class="empty">Nothing in the queue.</p></section>'}

<footer>
  This reviewer publishes its own score: <b>${(metrics.judge.precision * 100).toFixed(0)}% precision</b>,
  <b>${(metrics.judge.recall * 100).toFixed(0)}% recall</b> against ${t.runs} labelled runs,
  measured ${esc(metrics.judge.measured_at.slice(0, 10))} on <code>${esc(metrics.judge.model)}</code>
  (<code>${esc(metrics.judge.from)}</code>).
  Synthetic data throughout — fictional company, fictional callers, no real transcript.
</footer>
</div>
<script>
document.querySelectorAll('.actions').forEach(function (box) {
  box.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    var runId = box.getAttribute('data-run');
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) { b.disabled = true; });
    fetch('/runs/' + encodeURIComponent(runId) + '/human', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: button.getAttribute('data-decision'), note: 'from the dashboard' })
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        var note = document.createElement('p');
        note.className = 'decided';
        note.innerHTML = body.decision
          ? 'Recorded: <b>' + body.decision.replace('_', ' ') + '</b>. Reload to see the counters move.'
          : 'Could not record that decision.';
        box.replaceWith(note);
      })
      .catch(function () {
        Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) { b.disabled = false; });
      });
  });
});
</script>
</body></html>`;
}
