/**
 * Persistence port. Deliberately tiny: sync logs + idempotency bookkeeping only.
 * Implementations: D1 (Workers), in-memory (tests; also the seed for a SQLite/server adapter).
 *
 * NOTHING that implements this may store secret values, tokens, or request bodies.
 */

export interface RunRecord {
  id?: number;
  startedAt: string;
  finishedAt?: string;
  trigger: string;
  deliveryId?: string;
  chain: string;
  hop: string;
  outcome: string;
  sourceSha?: string;
  targetSha?: string;
  prNumber?: number;
  detail?: Record<string, unknown>;
}

export interface HopState {
  lastPolledAt?: string;
  lastSourceSha?: string;
}

export type DeliveryClaim = 'new' | 'duplicate';

export interface Store {
  recordRun(run: RunRecord): Promise<void>;
  recentRuns(chain: string, limit: number): Promise<RunRecord[]>;

  getHopState(chain: string, hop: string): Promise<HopState | null>;
  putHopState(chain: string, hop: string, state: HopState): Promise<void>;

  /**
   * Claim a webhook delivery for processing. Returns 'duplicate' when it already completed, or is
   * still in flight (claimed less than `staleAfterMs` ago). Failed or stale claims can be retaken,
   * so a manual redelivery from the GitHub UI retries work that previously failed.
   */
  claimDelivery(deliveryId: string, event: string, nowIso: string, staleAfterMs?: number): Promise<DeliveryClaim>;
  finishDelivery(deliveryId: string, status: 'done' | 'failed'): Promise<void>;

  /** Delete log/bookkeeping rows older than `beforeIso`. Returns rows removed. */
  prune(beforeIso: string): Promise<number>;
}

export const DELIVERY_STALE_AFTER_MS = 10 * 60 * 1000;
