import type { AIProvider, AiRequest } from '../providers/types.ts';
import type { Budget } from '../guardrails/budget.ts';

/** Alle KI-Aufrufe laufen hier durch: Budget vorher, Protokoll nachher – egal ob Mock oder echter Anbieter. */
export class AiGateway {
  log: { leadId: string; model: string; estCents: number; task: string }[] = [];
  private provider: AIProvider; private budget: Budget; private estCents: number;
  constructor(provider: AIProvider, budget: Budget, estCentsPerCall = 2) { this.provider = provider; this.budget = budget; this.estCents = provider.isMock ? 0 : estCentsPerCall; }
  async complete(leadId: string, r: AiRequest) {
    this.budget.takeAi(leadId, this.estCents);
    this.log.push({ leadId, model: this.provider.model, estCents: this.estCents, task: r.task });
    return this.provider.complete(r);
  }
}
