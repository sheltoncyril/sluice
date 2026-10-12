import type { HopId } from '../config/schema';

/**
 * Hidden marker in every sync PR body recording which SOURCE commit the PR carries.
 *
 * This is what lets squash/rebase merge methods work: those never make the source commit an
 * ancestor of the target, so "is the target behind?" cannot be answered by ancestry alone. The last
 * *merged* sync PR's marker is the baseline instead. It also lets us notice a rejected (closed
 * unmerged) PR for the same source commit and not re-open it.
 *
 * State lives in GitHub, not in D1, so wiping the database loses nothing.
 */
export interface SyncMarker {
  hop: HopId;
  /** Full 40-hex SHA of the source tip the PR was last synced to. */
  source: string;
}

const MARKER_RE = /<!--\s*sluice:v1\s+hop=(upstream_to_midstream|midstream_to_downstream)\s+source=([0-9a-f]{40})\s*-->/;

export function renderMarker(m: SyncMarker): string {
  return `<!-- sluice:v1 hop=${m.hop} source=${m.source} -->`;
}

export function parseMarker(body: string | null | undefined): SyncMarker | null {
  const match = MARKER_RE.exec(body ?? '');
  return match ? { hop: match[1] as HopId, source: match[2]! } : null;
}
