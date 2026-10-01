import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { Providers } from '../providers/types.ts';
import { assessContact, suppressionKeys } from './strategy.ts';
import { checkContact, type ContactDecision } from '../guardrails/contact-policy.ts';

export type SendChannel = 'EMAIL' | 'WHATSAPP';
export type EmailStatus = 'draft' | 'review_required' | 'legally_cleared' | 'sent' | 'follow_up_due' | 'do_not_contact';
export const EMAIL_STATUS_LABEL: Record<EmailStatus, string> = { draft: 'Entwurf', review_required: 'Prüfung nötig', legally_cleared: 'Rechtlich freigegeben', sent: 'Gesendet', follow_up_due: 'Follow-up fällig', do_not_contact: 'Nicht kontaktieren' };
/** Erlaubte manuelle Übergänge. „sent“ gibt es nur aus der Freigabe; „follow_up_due“ wird aus „sent“ + Frist berechnet; „do_not_contact“ setzt die Sperrliste. */
const EMAIL_NEXT: Record<EmailStatus, EmailStatus[]> = { draft: ['review_required'], review_required: ['draft', 'legally_cleared'], legally_cleared: ['review_required', 'sent'], sent: ['review_required'], follow_up_due: ['review_required'], do_not_contact: [] };     // jede weitere Nachricht (Follow-up) braucht wieder Prüfung + Freigabe
export function effectiveEmailStatus(status: EmailStatus, sentAt: Date | string | null, now: Date, followUpDays = 4): EmailStatus {
  return status === 'sent' && sentAt && now.getTime() - new Date(sentAt).getTime() >= followUpDays * 86400000 ? 'follow_up_due' : status;
}
import { startOfBerlinDay } from '../core/time.ts';

/**
 * Einziger Weg, eine Nachricht über E-Mail/WhatsApp zu senden. Vor jedem Versand wird geprüft: Sperrliste, Lead-Sperre, Kanal-Einstellung (Standard: aus),
 * dokumentierte Einwilligung, Plattformregeln, Tageslimit. Wenn irgendetwas fehlt: nichts senden, „Manuelle Kontaktaufnahme erforderlich“.
 */
export class ContactService {
  repo: Repo; leads: LeadStore; providers: Pick<Providers, 'email' | 'whatsapp'>; now: () => Date;
  constructor(d: { repo: Repo; leads: LeadStore; providers: Pick<Providers, 'email' | 'whatsapp'>; now?: () => Date }) { this.repo = d.repo; this.leads = d.leads; this.providers = d.providers; this.now = d.now ?? (() => new Date()); }
  private get pool() { return this.repo.pool; }

  /** Einwilligung/Opt-in dokumentieren (nur Buchführung – Nachweis liegt bei dir). */
  async recordConsent(leadId: string, channel: SendChannel, note: string) {
    if (!note.trim() || note.length > 500) throw new Error('Nachweis bitte kurz beschreiben (z. B. „Einwilligung per Formular am 12.05.“), max. 500 Zeichen.');
    await this.repo.tx(async (c) => {
      await this.leads.recordContact(c, leadId, { channel: 'NOTE', direction: 'internal', result: `CONSENT_${channel}`, note });
      await this.repo.event(c, leadId, 'consent_recorded', { channel, actor: 'user' });
    });
  }
  private async hasConsent(leadId: string, channel: SendChannel) {
    return ((await this.pool.query("select 1 from contact_history where lead_id=$1 and owner_id=$2 and result=$3 limit 1", [leadId, this.repo.ownerId, `CONSENT_${channel}`])).rowCount ?? 0) > 0;
  }

  /** Anzeigestatus: „sent“ wird nach der Frist zu „follow_up_due“. */
  effective(l: { email_send_status: EmailStatus; email_sent_at: Date | string | null }, followUpDays = 4) { return effectiveEmailStatus(l.email_send_status, l.email_sent_at, this.now(), followUpDays); }

  /** Versandstatus der E-Mail-Vorlage ändern. Nichts wird dadurch gesendet. „legally_cleared“ braucht deine ausdrückliche Bestätigung und eine bekannte Adresse. */
  async setEmailStatus(leadId: string, to: EmailStatus, o: { confirm?: boolean } = {}) {
    const r = (await this.pool.query('select email_send_status s, email, contact_blocked from leads where id=$1 and owner_id=$2', [leadId, this.repo.ownerId])).rows[0];
    if (!r) throw new Error('Lead nicht gefunden');
    if (r.contact_blocked || r.s === 'do_not_contact') throw new Error('Lead ist gesperrt (Do not contact).');
    if (!EMAIL_NEXT[r.s as EmailStatus]?.includes(to)) throw new Error(`Statuswechsel ${r.s} → ${to} ist nicht erlaubt.`);
    if (to === 'legally_cleared') {
      if (!o.confirm) throw new Error('Bitte bestätigen, dass die rechtliche Grundlage (z. B. Einwilligung) für diese E-Mail geklärt ist.');
      const hasMail = r.email || (await this.leads.factsOf(leadId)).some((f) => f.key === 'email');
      if (!hasMail) throw new Error('Keine öffentliche geschäftliche E-Mail-Adresse bekannt.');
    }
    await this.repo.tx(async (c) => {
      await c.query('update leads set email_send_status=$3, email_sent_at = case when $3=\'sent\' then now() else email_sent_at end where id=$1 and owner_id=$2', [leadId, this.repo.ownerId, to]);
      await this.repo.event(c, leadId, 'email_status', { from: r.s, to, actor: 'user' });
    });
  }

  async attemptSend(leadId: string, channel: SendChannel, m: { subject?: string; text: string }): Promise<{ sent: boolean; decision: ContactDecision; to?: string }> {
    const lead = await this.leads.rowToEntry(leadId);
    if (!lead) throw new Error('Lead nicht gefunden');
    if (!m.text.trim() || m.text.length > 5000) throw new Error('Nachricht: 1 bis 5000 Zeichen');
    const facts = await this.leads.factsOf(leadId);
    const settings = await this.repo.getSettings();
    const hits = await this.repo.findSuppression(suppressionKeys(facts, lead.company_name));
    const recipient = channel === 'EMAIL' ? (facts.find((f) => f.key === 'email')?.value as string | undefined) : (facts.find((f) => f.key === 'phone')?.value as string | undefined);
    const key = channel.toLowerCase() as 'email' | 'whatsapp';
    const cfg = settings.channels[key];
    const sentToday = ((await this.pool.query("select count(*)::int n from contact_history where owner_id=$1 and channel=$2 and direction='outbound' and result in ('SENT','MOCK_RECORDED') and at >= $3", [this.repo.ownerId, channel, startOfBerlinDay(this.now())])).rows[0].n) as number;
    const consent = await this.hasConsent(leadId, channel);
    let decision: ContactDecision = assessContact({ facts, suppressionHits: hits, blocked: lead.contact_blocked, phoneEnabled: settings.phoneEnabled }).readiness === 'DO_NOT_CONTACT'
      ? { allowed: false, reason: 'Lead ist gesperrt oder steht auf der Sperrliste.', action: 'Manuelle Kontaktaufnahme erforderlich.' }
      : !recipient ? { allowed: false, reason: `Keine ${channel === 'EMAIL' ? 'E-Mail-Adresse' : 'Nummer'} bekannt.`, action: 'Manuelle Kontaktaufnahme erforderlich.' }
      : checkContact({ channel: channel === 'EMAIL' ? 'email' : 'messenger', leadId, recipient, sentTodayOnChannel: sentToday, suppressed: false, leadBlocked: lead.contact_blocked,
          channelConfig: cfg ? { autoSend: cfg.autoSend, legalBasis: consent ? 'einwilligung' : '', dailyLimit: cfg.dailyLimit, platformRulesAllowAutomation: !!cfg.platformConfirmed } : undefined });
    if (decision.allowed && channel === 'EMAIL') {
      const st = (await this.pool.query('select email_send_status s from leads where id=$1 and owner_id=$2', [leadId, this.repo.ownerId])).rows[0]?.s as EmailStatus;
      if (st !== 'legally_cleared') decision = { allowed: false, reason: `E-Mail-Freigabestatus ist „${EMAIL_STATUS_LABEL[st] ?? st}“ – Versand erst nach „Rechtlich freigegeben“.`, action: 'Manuelle Kontaktaufnahme erforderlich.' };
    }
    if (!decision.allowed) {
      await this.repo.tx(async (c) => {
        await this.leads.recordContact(c, leadId, { channel: 'NOTE', direction: 'internal', result: 'SEND_BLOCKED', note: `${channel}: ${decision.allowed ? '' : decision.reason}`, actor: 'system' });
        await this.repo.event(c, leadId, 'contact_blocked', { channel, reason: decision.allowed ? '' : decision.reason, actor: 'system' });
      });
      return { sent: false, decision };
    }
    const provider = channel === 'EMAIL' ? this.providers.email : this.providers.whatsapp;
    const res = await provider.send({ to: recipient!, subject: m.subject, text: m.text, metadata: { leadId } });
    await this.repo.tx(async (c) => {
      await this.leads.recordContact(c, leadId, { channel, direction: 'outbound', result: res.status === 'sent' ? 'SENT' : 'MOCK_RECORDED', note: m.text.slice(0, 500), actor: 'user' });
      await this.repo.event(c, leadId, 'message_sent', { channel, provider: provider.name, status: res.status, actor: 'user' });
      if (channel === 'EMAIL') await c.query("update leads set email_send_status='sent', email_sent_at=now() where id=$1 and owner_id=$2", [leadId, this.repo.ownerId]);
    });
    return { sent: true, decision, to: recipient };
  }
}
