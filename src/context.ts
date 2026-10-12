import type { RuntimeConfig } from './env';
import type { Logger } from './log';
import type { Store } from './store/types';
import type { SecretInput, SecretResponse } from './secrets/distribute';
import type {
  AdminSyncInput,
  AdminSyncResponse,
  AdminVariablesInput,
  AdminVariablesResponse,
  AdminWorkflowsResponse,
} from './sync/admin';

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
  /** Operator-triggered "sync this hop now" (optionally a dry run). */
  runSync(input: AdminSyncInput): Promise<AdminSyncResponse>;
  /**
   * Seal and write one secret to the targets chain.yml declares for it. The value exists only inside this
   * call. Implementations must never persist or log it.
   */
  submitSecret(input: SecretInput): Promise<SecretResponse>;
  /** Apply (or preview) the variables: block of chain.yml. */
  runVariables(input: AdminVariablesInput): Promise<AdminVariablesResponse>;
  /** Render the workflow templates and open/refresh the workflow PRs (or preview with dryRun). */
  runWorkflows(input: AdminVariablesInput): Promise<AdminWorkflowsResponse>;
}
