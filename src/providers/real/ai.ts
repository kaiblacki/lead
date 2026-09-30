import type { AIProvider, AiRequest, AiResponse } from '../types.ts';

/** Anthropic Messages API. Nicht gegen die echte API getestet – siehe README. */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'; readonly isMock = false;
  readonly model: string;
  private apiKey: string | undefined;
  constructor(model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', apiKey = process.env.ANTHROPIC_API_KEY) { this.model = model; this.apiKey = apiKey; }
  async complete(r: AiRequest): Promise<AiResponse> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY fehlt');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: r.maxTokens ?? 600, ...(r.system ? { system: r.system } : {}), messages: [{ role: 'user', content: r.prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    return { text: data.content.map((c) => c.text ?? '').join(''), model: this.model, inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
  }
}
