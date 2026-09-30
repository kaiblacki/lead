import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { Providers } from '../providers/types.ts';
import { assessContact, suppressionKeys } from './strategy.ts';
import { checkContact, type ContactDecision } from '../guardrails/contact-policy.ts';

export type SendChannel = 'EMAIL' | 'WHATSAPP';
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
    });
    return { sent: true, decision, to: recipient };
  }
}
