import type { Budget } from '../guardrails/budget.ts';

export interface AiProvider {
  readonly model: string;
  complete(prompt: string): Promise<string>;
}

export class AnthropicProvider implements AiProvider {
  readonly model: string;
  private apiKey: string | undefined;
  constructor(model = 'claude-sonnet-5-5', apiKey = process.env.ANTHROPIC_API_KEY) { this.model = model; this.apiKey = apiKey; }
  async complete(prompt: string): Promise<string> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY fehlt');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    return data.content.map((c) => c.text ?? '').join('');
  }
}

/** Alle KI-Aufrufe laufen hier durch: Budget vorher, Protokoll nachher. */
export class AiGateway {
  log: { leadId: string; model: string; estCents: number }[] = [];
  private provider: AiProvider;
  private budget: Budget;
  private estCentsPerCall: number;
  constructor(provider: AiProvider, budget: Budget, estCentsPerCall = 2) { this.provider = provider; this.budget = budget; this.estCentsPerCall = estCentsPerCall; }
  async complete(leadId: string, prompt: string): Promise<string> {
    this.budget.takeAi(leadId, this.estCentsPerCall);
    this.log.push({ leadId, model: this.provider.model, estCents: this.estCentsPerCall });
    return this.provider.complete(prompt);
  }
}
