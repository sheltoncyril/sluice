import type { RuntimeConfig } from './env';
import type { Logger } from './log';
import type { Store } from './store/types';

/** A verified GitHub webhook delivery. `payload` is untyped until a handler narrows it. */
export interface WebhookEvent {
  id: string; // X-GitHub-Delivery
  name: string; // X-GitHub-Event
  payload: unknown;
}

/**
 * Everything the HTTP layer needs, as plain interfaces. The Worker entry builds the real thing;
 * tests (and any future Node/server adapter) build their own. Nothing in here is Workers-specific.
 */
export interface AppContext {
  config: Pick<RuntimeConfig, 'webhookSecret' | 'adminToken'>;
  logger: Logger;
  store: Store;
  now(): Date;
  /** Process a verified webhook. Must be idempotent: GitHub redelivers and so do we. */
  handleEvent(event: WebhookEvent, logger: Logger): Promise<void>;
  /** For /admin/whoami: proves JWT signing and key conversion work in the deployed runtime. */
  describeApp(): Promise<unknown>;
}
