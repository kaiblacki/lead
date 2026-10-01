import type { OutboundMessage, SendResult, WhatsAppProvider } from '../types.ts';

/** Deutsche Nummer → internationale Ziffernfolge (E.164 ohne „+“). Gibt null zurück, wenn die Nummer unplausibel ist. */
export function toE164(raw: string): string | null {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '49' + d.slice(1);
  return /^\d{8,15}$/.test(d) ? d : null;
}

/**
 * WhatsApp Business Cloud API (Meta). Hinweis: Außerhalb eines 24-Stunden-Fensters (Kunde hat zuletzt geschrieben) sind nur freigegebene Nachrichtenvorlagen
 * erlaubt – Freitext an Neukontakte lehnt Meta ab. Der Aufruf kommt nur zustande, wenn ContactService Einwilligung, Kanalfreigabe und Limits bestätigt hat.
 * Nicht gegen die echte API getestet.
 */
export class WhatsAppCloudProvider implements WhatsAppProvider {
  readonly name = 'whatsapp-cloud'; readonly isMock = false;
  private token: string; private phoneId: string;
  constructor(token: string, phoneId: string) { this.token = token; this.phoneId = phoneId; }
  async send(m: OutboundMessage): Promise<SendResult> {
    const to = toE164(m.to); if (!to) throw new Error('Ungültige Telefonnummer für WhatsApp');
    if (!/^\d{5,20}$/.test(this.phoneId)) throw new Error('WHATSAPP_PHONE_ID ungültig');
    const res = await fetch(`https://graph.facebook.com/v20.0/${this.phoneId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: m.text.slice(0, 4000), preview_url: false } }),
    });
    const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok || !data.messages?.[0]) throw new Error(`WhatsApp API ${res.status}${data.error ? `: ${String(data.error.message).slice(0, 160)}` : ''}`);
    return { id: data.messages[0].id, status: 'sent' };
  }
}
