import type { EmailProvider, OutboundMessage, SendResult, WhatsAppProvider } from '../types.ts';

/** Sendet nichts. Speichert Nachrichten nur im Speicher (für Tests und Vorschau). */
abstract class RecordingProvider {
  readonly isMock = true;
  sent: (OutboundMessage & { id: string })[] = [];
  async send(m: OutboundMessage): Promise<SendResult> {
    const id = `mock_msg_${this.sent.length + 1}`;
    this.sent.push({ ...m, id });
    return { id, status: 'mock_recorded' };
  }
}
export class MockEmailProvider extends RecordingProvider implements EmailProvider { readonly name = 'mock-email'; }
export class MockWhatsAppProvider extends RecordingProvider implements WhatsAppProvider { readonly name = 'mock-whatsapp'; }
