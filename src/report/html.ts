import type { LeadReport } from '../pipeline.ts';
import { eur } from '../ai/sales.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const order = ['HOT', 'HIGH POTENTIAL', 'MEDIUM', 'LOW', 'IGNORE'];

export function renderReport(reports: LeadReport[], meta: { title: string; stoppedReason?: string }): string {
  const sorted = [...reports].sort((a, b) => (b.opportunity.scored ? b.opportunity.score : -1) - (a.opportunity.scored ? a.opportunity.score : -1));
  const rows = sorted.map((r) => {
    const o = r.opportunity;
    const cat = o.scored ? o.category : 'RECHECK';
    const s = r.sales;
    return `<details class="lead c-${esc(cat.replace(' ', '-'))}"><summary>
      <span class="badge">${esc(cat)}</span><b>${esc(r.lead.companyName)}</b>
      <span class="meta">${esc(r.lead.city ?? '')}</span><span class="score">${o.scored ? o.score : '–'}</span></summary>
      <div class="body">
        <p><b>Warum interessant?</b> ${esc(o.scored ? o.why : o.reason)}</p>
        ${o.scored ? `<table><tr><th>Faktor</th><th>Punkte</th></tr>${o.factors.map((f) => `<tr><td>${esc(f.reason)}</td><td>+${f.points}</td></tr>`).join('')}</table>` : ''}
        ${r.audit.findings.length ? `<h4>Befunde mit Beleg</h4><ul>${r.audit.findings.map((f) => `<li><b>${esc(f.summary)}</b><br><small>Beleg: ${esc(f.evidence)}</small></li>`).join('')}</ul>` : ''}
        ${s ? `<h4>Verkaufsgrundlage</h4><p>${esc(s.chance)}<br>Angebot: <b>${esc(s.offerName)}</b>, ${eur(s.priceCents)}</p>
        <p><b>Gesprächseinstieg</b> (${s.openerSource}, Freigabe durch Mensch nötig):<br><i>${esc(s.opener)}</i></p>
        <p class="manual">Manuelle Kontaktaufnahme erforderlich.</p>` : ''}
        <p><small>Quelle: ${esc(r.lead.source)} · Tel: ${esc(r.lead.phone ?? '–')} · Web: ${esc(r.lead.websiteUrl ?? '–')}</small></p>
      </div></details>`;
  }).join('');
  const counts = order.map((c) => `${c}: ${reports.filter((r) => r.opportunity.scored && r.opportunity.category === c).length}`).join(' · ');
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.title)}</title><style>
body{font:15px system-ui;margin:0;background:#f5f6f8;color:#1b1f24}main{max-width:900px;margin:0 auto;padding:16px}
.lead{background:#fff;border-radius:10px;margin:8px 0;box-shadow:0 1px 2px #0002}summary{cursor:pointer;padding:12px;display:flex;gap:10px;align-items:center}
.badge{font-size:11px;font-weight:700;padding:3px 8px;border-radius:99px;background:#ddd}.c-HOT .badge{background:#e5484d;color:#fff}.c-HIGH-POTENTIAL .badge{background:#f76b15;color:#fff}.c-MEDIUM .badge{background:#ffc53d}
.score{margin-left:auto;font-weight:700}.meta{color:#666}.body{padding:0 14px 14px}table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #eee;text-align:left}
.manual{background:#fff4d6;padding:8px;border-radius:6px}.warn{background:#ffe3e3;padding:10px;border-radius:8px}</style>
<main><h1>${esc(meta.title)}</h1><p>${reports.length} Leads · ${counts}</p>
${meta.stoppedReason ? `<p class="warn">Lauf gestoppt: ${esc(meta.stoppedReason)}</p>` : ''}${rows}</main></html>`;
}
