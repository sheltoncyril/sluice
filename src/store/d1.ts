import { DELIVERY_STALE_AFTER_MS } from './types';
import type { DeliveryClaim, HopState, RunRecord, Store } from './types';

interface RunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  delivery_id: string | null;
  chain: string;
  hop: string;
  outcome: string;
  source_sha: string | null;
  target_sha: string | null;
  pr_number: number | null;
  detail: string | null;
}

/** Cloudflare D1 implementation of {@link Store}. All statements are parameterised. */
export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async recordRun(run: RunRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sync_runs
           (started_at, finished_at, trigger, delivery_id, chain, hop, outcome, source_sha, target_sha, pr_number, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.startedAt,
        run.finishedAt ?? null,
        run.trigger,
        run.deliveryId ?? null,
        run.chain,
        run.hop,
        run.outcome,
        run.sourceSha ?? null,
        run.targetSha ?? null,
        run.prNumber ?? null,
        run.detail ? JSON.stringify(run.detail) : null,
      )
      .run();
  }

  async recentRuns(chain: string, limit: number): Promise<RunRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM sync_runs WHERE chain = ? ORDER BY id DESC LIMIT ?')
      .bind(chain, limit)
      .all<RunRow>();
    return results.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
      trigger: r.trigger,
      ...(r.delivery_id ? { deliveryId: r.delivery_id } : {}),
      chain: r.chain,
      hop: r.hop,
      outcome: r.outcome,
      ...(r.source_sha ? { sourceSha: r.source_sha } : {}),
      ...(r.target_sha ? { targetSha: r.target_sha } : {}),
      ...(r.pr_number !== null ? { prNumber: r.pr_number } : {}),
      ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
    }));
  }

  async getHopState(chain: string, hop: string): Promise<HopState | null> {
    const row = await this.db
      .prepare('SELECT last_polled_at, last_source_sha FROM hop_state WHERE chain = ? AND hop = ?')
      .bind(chain, hop)
      .first<{ last_polled_at: string | null; last_source_sha: string | null }>();
    if (!row) return null;
    return {
      ...(row.last_polled_at ? { lastPolledAt: row.last_polled_at } : {}),
      ...(row.last_source_sha ? { lastSourceSha: row.last_source_sha } : {}),
    };
  }

  async putHopState(chain: string, hop: string, state: HopState): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO hop_state (chain, hop, last_polled_at, last_source_sha) VALUES (?, ?, ?, ?)
         ON CONFLICT(chain, hop) DO UPDATE SET
           last_polled_at = excluded.last_polled_at,
           last_source_sha = excluded.last_source_sha`,
      )
      .bind(chain, hop, state.lastPolledAt ?? null, state.lastSourceSha ?? null)
      .run();
  }

  async claimDelivery(
    deliveryId: string,
    event: string,
    nowIso: string,
    staleAfterMs = DELIVERY_STALE_AFTER_MS,
  ): Promise<DeliveryClaim> {
    const staleBefore = new Date(Date.parse(nowIso) - staleAfterMs).toISOString();
    // Insert, or retake a failed / stale claim. RETURNING yields a row only when we own the claim.
    const row = await this.db
      .prepare(
        `INSERT INTO deliveries (delivery_id, event, received_at, status) VALUES (?, ?, ?, 'processing')
         ON CONFLICT(delivery_id) DO UPDATE SET status = 'processing', event = excluded.event, received_at = excluded.received_at
           WHERE deliveries.status = 'failed' OR (deliveries.status = 'processing' AND deliveries.received_at < ?)
         RETURNING delivery_id`,
      )
      .bind(deliveryId, event, nowIso, staleBefore)
      .first<{ delivery_id: string }>();
    return row ? 'new' : 'duplicate';
  }

  async finishDelivery(deliveryId: string, status: 'done' | 'failed'): Promise<void> {
    await this.db.prepare('UPDATE deliveries SET status = ? WHERE delivery_id = ?').bind(status, deliveryId).run();
  }

  async prune(beforeIso: string): Promise<number> {
    const [runs, deliveries] = await this.db.batch([
      this.db.prepare('DELETE FROM sync_runs WHERE started_at < ?').bind(beforeIso),
      this.db.prepare('DELETE FROM deliveries WHERE received_at < ?').bind(beforeIso),
    ]);
    return (runs?.meta.changes ?? 0) + (deliveries?.meta.changes ?? 0);
  }
}
