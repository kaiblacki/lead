import type { Repo } from '../db/repo.ts';
import type { EmailProvider } from '../providers/types.ts';
import { Repo as RepoCls } from '../db/repo.ts';
import { startOfBerlinDay, endOfBerlinDay } from '../core/time.ts';

export type MailRef = { leadId?: string | null; orderId?: string | null };
export type MailResult = { ok: boolean; status: 'sent' | 'mock_recorded' | 'failed'; error?: string };
export const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * E-Mail-Versand an einer Stelle: jede Mail landet im Postausgang (auch im Mock-Modus, dann als „nur aufgezeichnet“) und im Audit-Log.
 * 1) Betreiber-Benachrichtigungen (an deine Adresse) bei wichtigen Ereignissen, 2) Kunden-Mails, die DU im Dashboard auslöst (Zahlungslink, Freigabelink …).
 * Es gibt keinen automatischen Versand an Interessenten/Kaltkontakte – dafür gelten die Kontaktregeln (ContactService).
 */
export class Notifier {
  repo: Repo; email: EmailProvider; baseUrl: string; now: () => Date;
  constructor(repo: Repo, email: EmailProvider, baseUrl: string, now: () => Date = () => new Date()) { this.repo = repo; this.email = email; this.baseUrl = baseUrl; this.now = now; }
  private get pool() { return this.repo.pool; }

  async send(kind: string, to: string, subject: string, text: string, ref: MailRef = {}): Promise<MailResult> {
    let status: MailResult['status'] = 'failed', error: string | undefined;
    try {
      if (!EMAIL_RE.test(to) || to.length > 200) throw new Error('Ungültige E-Mail-Adresse');
      if (!subject.trim() || /[\r\n]/.test(subject) || subject.length > 300) throw new Error('Betreff ungültig');
      if (!text.trim() || text.length > 20000) throw new Error('Nachricht leer oder zu lang');
      const r = await this.email.send({ to, subject, text, metadata: { kind } });
      status = r.status === 'sent' ? 'sent' : 'mock_recorded';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    try {
      await this.pool.query('insert into outbox(owner_id, kind, to_addr, subject, body, status, provider, error, lead_id, order_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [this.repo.ownerId, kind, to.slice(0, 200), subject.slice(0, 300), text.slice(0, 20000), status, this.email.name, error ?? null, ref.leadId ?? null, ref.orderId ?? null]);
      await this.repo.event(this.pool, ref.leadId ?? null, status === 'failed' ? 'email_failed' : 'email_sent', { kind, to_domain: to.split('@')[1], status, error, actor: 'system' }, true);
    } catch (e) { console.error('Postausgang konnte nicht gespeichert werden:', e instanceof Error ? e.message : e); }
    return { ok: status !== 'failed', status, error };
  }


  /** Tagesübersicht an den Betreiber: heutige Calls, fällige Rückrufe, wartende Aufträge, offene Wartungsaufgaben. `force` ignoriert „schon heute gesendet“. */
  async dailyDigest(o: { force?: boolean } = {}): Promise<MailResult | null> {
    const s = await this.repo.getSettings();
    if (!s.notifyEnabled || !s.notifyEmail) return null;
    const now = this.now(), day0 = startOfBerlinDay(now), day1 = endOfBerlinDay(now), owner = this.repo.ownerId;
    if (!o.force && (await this.pool.query("select 1 from outbox where owner_id=$1 and kind='owner_digest' and created_at >= $2 limit 1", [owner, day0])).rowCount) return null;
    const one = async (sql: string, args: unknown[] = []) => (await this.pool.query(sql, [owner, ...args])).rows[0].n as number;
    const callbacks = await one("select count(*)::int n from leads where owner_id=$1 and callback_at < $2 and not paused and not contact_blocked and status in ('QUALIFIED','DEMO_CREATED','CONTACTED','REPLIED','INTERESTED','OFFER_SENT')", [day1]);
    const fresh = await one("select count(*)::int n from leads where owner_id=$1 and status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL' and not paused and callback_at is null");
    const review = await one("select count(*)::int n from orders where owner_id=$1 and status='CUSTOMER_REVIEW'");
    const payWait = await one("select count(*)::int n from orders where owner_id=$1 and status in ('PAYMENT_PENDING','FINAL_PAYMENT_PENDING')");
    const toDeploy = await one("select count(*)::int n from orders where owner_id=$1 and status='FULLY_PAID'");
    const prod = await one("select count(*)::int n from orders where owner_id=$1 and status in ('IN_PRODUCTION','QA')");
    const tasks = await one("select count(*)::int n from maintenance_tasks where owner_id=$1 and status='OPEN'");
    const target = s.dailyCallTarget;
    const lines = [`Guten Morgen! Deine Übersicht für heute:`, '', `• Calls: ${callbacks} fällige Rückruf(e) und ${fresh} neue Leads bereit (Tagesziel ${target})${s.phoneEnabled ? '' : ' – Telefonakquise ist noch nicht freigegeben'}`,
      `• Aufträge: ${prod} in Produktion, ${review} warten auf Kundenfreigabe, ${payWait} warten auf Zahlung, ${toDeploy} bereit zur Veröffentlichung`, `• Wartung: ${tasks} offene Aufgabe(n)`, '',
      `Calls: ${this.baseUrl}/calls`, `Aufträge: ${this.baseUrl}/orders`, `Wartung: ${this.baseUrl}/maintenance`];
    return this.send('owner_digest', s.notifyEmail, `Tagesübersicht: ${callbacks + fresh} Calls, ${review + toDeploy + tasks} offene To-dos`, lines.join('\n'), {});
  }

  async outbox(limit = 100, offset = 0) {
    const rows = (await this.pool.query('select id, kind, to_addr, subject, body, status, provider, error, lead_id, order_id, created_at from outbox where owner_id=$1 order by created_at desc limit $2 offset $3', [this.repo.ownerId, limit, offset])).rows;
    const total = (await this.pool.query('select count(*)::int n from outbox where owner_id=$1', [this.repo.ownerId])).rows[0].n as number;
    return { rows, total };
  }

  /** An die eingestellte Betreiber-Adresse (wenn aktiviert). Wirft nie. */
  async notifyOwner(kind: string, subject: string, text: string, ref: MailRef = {}): Promise<MailResult | null> {
    try {
      const s = await this.repo.getSettings();
      if (!s.notifyEnabled || !s.notifyEmail) return null;
      return await this.send(kind, s.notifyEmail, subject, text + `\n\n— AI Agency OS · ${this.baseUrl}`, ref);
    } catch { return null; }
  }

  private async companyOf(leadId: string | null, orderId?: string): Promise<{ name: string; leadId: string | null; orderId?: string }> {
    let lid = leadId;
    if (!lid && orderId) lid = (await this.pool.query('select lead_id from orders where id=$1 and owner_id=$2', [orderId, this.repo.ownerId])).rows[0]?.lead_id ?? null;
    const name = lid ? (await this.pool.query('select company_name from leads where id=$1 and owner_id=$2', [lid, this.repo.ownerId])).rows[0]?.company_name : null;
    return { name: name ?? 'Unbekannt', leadId: lid, orderId };
  }

  /** Wird vom Audit-Log aufgerufen (nur für wichtige Ereignisse wird eine Mail erzeugt). */
  async onEvent(type: string, leadId: string | null, p: Record<string, any>) {
    try {
      const orderId = p.order_id as string | undefined;
      const link = (path: string) => `${this.baseUrl}${path}`;
      if (type === 'order_status' && ['IN_PRODUCTION', 'FULLY_PAID', 'MAINTENANCE_ACTIVE', 'CUSTOMER_REVIEW', 'DEPLOYED'].includes(p.to) && p.actor !== 'user') {
        const MAP: Record<string, [string, string]> = {
          IN_PRODUCTION: p.from === 'DEPOSIT_PAID' || p.from === 'PAYMENT_PENDING' ? ['Anzahlung eingegangen', 'Die Anzahlung ist eingegangen. Die Produktion kann starten (Projektdaten ergänzen, „Produzieren + QA“).'] : ['', ''],
          FULLY_PAID: ['Restzahlung eingegangen', 'Die Restzahlung ist eingegangen. Die Seite kann jetzt veröffentlicht werden.'],
          MAINTENANCE_ACTIVE: ['Wartungs-Abo gestartet', 'Das Wartungs-Abo ist aktiv.'],
          CUSTOMER_REVIEW: ['Seite wartet auf Kundenfreigabe', 'Die QA ist bestanden. Der Freigabe-Link kann an den Kunden gesendet werden.'],
          DEPLOYED: ['Seite veröffentlicht', 'Die Seite wurde veröffentlicht.'],
        };
        const [title, body] = MAP[p.to]; if (!title) return;
        const c = await this.companyOf(leadId, orderId);
        await this.notifyOwner('owner_order', `${title}: ${c.name}`, `${body}\n\nFirma: ${c.name}\nAuftrag: ${link('/orders/' + orderId)}`, { leadId: c.leadId, orderId });
      } else if (type === 'customer_approved' || type === 'customer_changes_requested') {
        const c = await this.companyOf(leadId, orderId);
        const approved = type === 'customer_approved';
        await this.notifyOwner('owner_review', `${approved ? 'Kunde hat freigegeben' : 'Änderungswunsch vom Kunden'}: ${c.name}`,
          `${approved ? 'Der Kunde hat die Vorschau freigegeben; die Restzahlung ist angefordert.' : `Der Kunde wünscht eine Änderung:\n„${String(p.note ?? '').slice(0, 1000)}“`}\n\nFirma: ${c.name}\nAuftrag: ${link('/orders/' + orderId)}`, { leadId: c.leadId, orderId });
      } else if (type === 'maintenance_check' && p.ok === false) {
        const c = await this.companyOf(null, orderId);
        await this.notifyOwner('owner_maintenance', `Wartung: Problem bei ${c.name}`, `Die Prüfung hat ${p.problems} Problem(e) gefunden.\nDetails: ${link('/maintenance/' + orderId)}`, { leadId: c.leadId, orderId });
      }
    } catch { /* Benachrichtigungen dürfen nie den Ablauf stören */ }
  }

  /** Kunden-Mail aus dem Auftrag heraus (von dir ausgelöst). */
  async composeForOrder(orderId: string, what: 'deposit' | 'final' | 'maintenance' | 'review' | 'deployed'): Promise<{ subject: string; text: string; defaultTo: string | null; leadId: string; name: string }> {
    const o = (await this.pool.query('select o.id, o.lead_id, o.review_token, l.company_name from orders o join leads l on l.id=o.lead_id where o.id=$1 and o.owner_id=$2', [orderId, this.repo.ownerId])).rows[0];
    if (!o) throw new Error('Auftrag nicht gefunden');
    const proj = (await this.pool.query('select content from projects where order_id=$1 and owner_id=$2', [orderId, this.repo.ownerId])).rows[0]?.content;
    const fact = (await this.pool.query("select value from lead_facts where lead_id=$1 and owner_id=$2 and key='email' order by captured_at desc limit 1", [o.lead_id, this.repo.ownerId])).rows[0]?.value;
    const defaultTo = (proj?.email as string | undefined) || (typeof fact === 'string' ? fact : null);
    const agency = 'Ihr Website-Team';
    if (what === 'review') {
      if (!o.review_token) throw new Error('Noch kein Freigabe-Link – erst Produzieren + QA ausführen.');
      return { leadId: o.lead_id, name: o.company_name, defaultTo, subject: `Ihre neue Website ist bereit zur Prüfung`, text: `Guten Tag,\n\nIhre neue Website für ${o.company_name} ist bereit. Bitte prüfen Sie die Vorschau und geben Sie sie frei oder teilen Sie uns Änderungswünsche mit:\n\n${this.baseUrl}/r/${o.review_token}\n\nNach Ihrer Freigabe folgt die Restzahlung; erst danach wird die Seite veröffentlicht.\n\nMit freundlichen Grüßen\n${agency}` };
    }
    if (what === 'deployed') {
      const d = (await this.pool.query('select url from deployments where order_id=$1 and owner_id=$2 order by created_at desc limit 1', [orderId, this.repo.ownerId])).rows[0];
      if (!d) throw new Error('Noch nicht veröffentlicht.');
      return { leadId: o.lead_id, name: o.company_name, defaultTo, subject: 'Ihre Website ist online', text: `Guten Tag,\n\nIhre Website für ${o.company_name} ist jetzt online:\n\n${d.url}\n\nMit freundlichen Grüßen\n${agency}` };
    }
    const p = (await this.pool.query("select amount_cents, checkout_url from payments where order_id=$1 and owner_id=$2 and kind=$3 and status='pending' order by created_at desc limit 1", [orderId, this.repo.ownerId, what])).rows[0];
    if (!p?.checkout_url) throw new Error('Kein offener Zahlungslink – erst den Link erstellen.');
    const label = { deposit: 'Anzahlung', final: 'Restzahlung', maintenance: 'Wartungs-Abo (monatlich)' }[what];
    const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(p.amount_cents / 100);
    return { leadId: o.lead_id, name: o.company_name, defaultTo, subject: `${label} für Ihre Website`, text: `Guten Tag,\n\nhier der sichere Zahlungslink für die ${label} (${eur}) zu Ihrer Website für ${o.company_name}:\n\n${p.checkout_url}\n\nBei Fragen melden Sie sich gerne.\n\nMit freundlichen Grüßen\n${agency}` };
  }

  async sendOrderMail(orderId: string, what: Parameters<Notifier['composeForOrder']>[1], to: string): Promise<MailResult> {
    const m = await this.composeForOrder(orderId, what);
    const addr = to.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) throw new Error('Bitte eine gültige E-Mail-Adresse angeben.');
    const hits = await this.repo.findSuppression([{ kind: 'email', value: addr }, { kind: 'domain', value: addr.split('@')[1] }].filter((k) => k.kind === 'email'));
    if (hits.length) throw new Error('Diese Adresse steht auf der Sperrliste – es wird nichts gesendet.');
    return this.send(`customer_${what}`, addr, m.subject, m.text, { leadId: m.leadId, orderId });
  }
}
void RepoCls;
