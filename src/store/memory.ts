import { DELIVERY_STALE_AFTER_MS } from './types';
import type { DeliveryClaim, HopState, RunRecord, Store } from './types';

/** In-memory Store for tests and local experiments. */
export class MemoryStore implements Store {
  readonly runs: RunRecord[] = [];
  readonly hopStates = new Map<string, HopState>();
  readonly deliveries = new Map<string, { event: string; receivedAt: string; status: string }>();
  private nextId = 1;

  async recordRun(run: RunRecord): Promise<void> {
    this.runs.push({ ...run, id: this.nextId++ });
  }

  async recentRuns(chain: string, limit: number): Promise<RunRecord[]> {
    return this.runs
      .filter((r) => r.chain === chain)
      .slice(-limit)
      .reverse();
  }

  async getHopState(chain: string, hop: string): Promise<HopState | null> {
    return this.hopStates.get(`${chain}|${hop}`) ?? null;
  }

  async putHopState(chain: string, hop: string, state: HopState): Promise<void> {
    this.hopStates.set(`${chain}|${hop}`, { ...state });
  }

  async claimDelivery(
    deliveryId: string,
    event: string,
    nowIso: string,
    staleAfterMs = DELIVERY_STALE_AFTER_MS,
  ): Promise<DeliveryClaim> {
    const existing = this.deliveries.get(deliveryId);
    if (existing) {
      const stale = Date.parse(nowIso) - Date.parse(existing.receivedAt) > staleAfterMs;
      const retakeable = existing.status === 'failed' || (existing.status === 'processing' && stale);
      if (!retakeable) return 'duplicate';
    }
    this.deliveries.set(deliveryId, { event, receivedAt: nowIso, status: 'processing' });
    return 'new';
  }

  async finishDelivery(deliveryId: string, status: 'done' | 'failed'): Promise<void> {
    const d = this.deliveries.get(deliveryId);
    if (d) d.status = status;
  }

  async prune(beforeIso: string): Promise<number> {
    let removed = 0;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      if (this.runs[i]!.startedAt < beforeIso) {
        this.runs.splice(i, 1);
        removed++;
      }
    }
    for (const [id, d] of this.deliveries) {
      if (d.receivedAt < beforeIso) {
        this.deliveries.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
