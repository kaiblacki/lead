export type Channel = 'email' | 'phone' | 'contact_form' | 'messenger' | 'letter';

export type ChannelConfig = {
  /** Muss bewusst pro Kanal eingeschaltet werden. Standard: aus. */
  autoSend: boolean;
  /** Dokumentierte Rechtsgrundlage, z. B. "einwilligung" oder "mutmassliche_einwilligung". Leer = nicht zulässig. */
  legalBasis?: string;
  dailyLimit: number;
  platformRulesAllowAutomation: boolean;
};

export type ContactRequest = {
  channel: Channel;
  leadId: string;
  recipient: string;
  leadBlocked?: boolean;
  sentTodayOnChannel: number;
  suppressed: boolean;
  channelConfig?: ChannelConfig;
};

export type ContactDecision = { allowed: true } | { allowed: false; reason: string; action: 'Manuelle Kontaktaufnahme erforderlich.' };

const MANUAL = 'Manuelle Kontaktaufnahme erforderlich.' as const;
const deny = (reason: string): ContactDecision => ({ allowed: false, reason, action: MANUAL });

/** Prüft vor jeder automatischen Kontaktaufnahme. Im Zweifel: nicht senden. */
export function checkContact(r: ContactRequest): ContactDecision {
  if (r.leadBlocked) return deny('Lead ist gesperrt oder pausiert.');
  if (r.suppressed) return deny('Empfänger steht auf der Sperrliste (Opt-out).');
  const c = r.channelConfig;
  if (!c) return deny('Kanal ist nicht konfiguriert.');
  if (!c.autoSend) return deny('Automatischer Versand ist für diesen Kanal nicht aktiviert.');
  if (!c.legalBasis?.trim()) return deny('Keine dokumentierte Rechtsgrundlage für diesen Kanal.');
  if (!c.platformRulesAllowAutomation) return deny('Plattformregeln erlauben keine Automatisierung.');
  if (r.sentTodayOnChannel >= c.dailyLimit) return deny('Tageslimit für diesen Kanal erreicht.');
  return { allowed: true };
}
