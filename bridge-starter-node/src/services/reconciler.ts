/**
 * Provider Reconciliation Service
 *
 * Compares local payout records against the provider's remote API to detect
 * discrepancies such as:
 *   - Status mismatches  (local says "completed", provider says "failed")
 *   - Amount mismatches  (rounding / FX differences)
 *   - Missing records    (exists locally but not remotely, or vice-versa)
 *
 * Integrators should supply their own `fetchLocalPayouts` and
 * `fetchRemotePayouts` implementations — the defaults below are stubs
 * that return demo data so the script is runnable out of the box.
 *
 * SEP-31 idempotency helpers (`submitPayoutIdempotent`,
 * `reconcileCompletionCallback`) live here so payout submission and
 * callback handling share the same persisted reference store.
 *
 * ─── Reconciliation Operations Runbook (issue #842) ─────────────────────────
 *
 * This section documents the safe operational procedure for support staff
 * investigating reconciliation alerts.  It is intentionally read-only: no
 * step below authorizes manually mutating financial state (payout status,
 * amounts, or balances).  All corrections flow through the approval workflow
 * described at the end.
 *
 * 1. Alert meanings
 *    - `status_mismatch`: local and provider disagree on payout status
 *      (e.g. local "completed" vs provider "failed"). Investigate before
 *      assuming either side is correct.
 *    - `amount_mismatch`: settled amount differs from the local amount,
 *      usually due to rounding or FX. Confirm the FX rate snapshot used.
 *    - `missing_remote`: a local payout has no matching provider record.
 *      Could be a submission that never reached the provider.
 *    - `missing_local`: the provider reports a payout we have no local
 *      record for. Treat as potentially fraudulent until proven otherwise.
 *    - `critical`: any alert flagged critical (large amount deltas, repeated
 *      failures, or `missing_local`) must be escalated immediately per §6.
 *
 * 2. Retrieving provider reports
 *    - Open the provider reconciliation dashboard and export the report for
 *      the affected settlement window (UTC date range).
 *    - Cross-reference the exported report against the local reconciliation
 *      report produced by `runReconciliation` (see below).
 *    - Attach both exports to the incident ticket; never edit them.
 *
 * 3. Safe review actions (no financial mutation)
 *    - Read local and remote records, exports, and the audit trail.
 *    - Re-run reconciliation in read-only mode to confirm the discrepancy.
 *    - Add notes and evidence to the incident ticket.
 *    - Do NOT edit payout status, amounts, or balances directly.
 *
 * 4. Correction approval workflow
 *    - A proposed correction must include: the alert id, both report
 *      exports, the audit-trail excerpt, and the proposed new state.
 *    - Approval requires sign-off from the on-call finance owner AND a
 *      second reviewer (four-eyes principle).
 *    - Only after approval may an authorized operator apply the correction
 *      through the audited correction tooling (never by hand).
 *
 * 5. Replay procedure
 *    - Replays are idempotent: re-submitting an existing reference returns
 *      the stored record (see `submitPayoutIdempotent`).
 *    - Before replaying, confirm via `queryProviderPayoutStatus` that the
 *      provider has no record for the reference.
 *    - Record the replay in the audit trail with the incident ticket id.
 *
 * 6. Escalation ownership
 *    - `critical` alerts: page the on-call finance owner immediately.
 *    - `missing_local`: escalate to the security on-call in parallel.
 *    - Non-critical mismatches: assign to the reconciliation queue owner
 *      during business hours.
 * ────────────────────────────────────────────────────────────────────────────
 */

import axios from "axios";
import { config } from "../config/env";
import type {
  LocalPayoutRecord,
  RemotePayoutRecord,
  ReconciliationEntry,
  ReconciliationReport,
} from "../types/reconciliation";

// ─── Transaction / consistency boundary ──────────────────────────────────────

/**
 * Minimal transaction client contract.
 *
 * Callers that already hold an open transaction (or a primary-routed
 * connection) can pass it in so that reads stay inside the caller's
 * transaction and consistency boundary instead of being routed to a
 * possibly-lagging replica.
 */
export interface TransactionClient {
  /** Execute a query against this client's connection. */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Options controlling where reads are served from.
 *
 * `client` pins reads to the caller's transaction. `primary` forces
 * read-after-write operations onto the primary so replica routing cannot
 * serve stale data.
 */
export interface ReadOptions {
  client?: TransactionClient;
  primary?: boolean;
}

// ─── Data-source adapters (replace with real implementations) ────────────────

/**
 * Fetch payout records from the local data store.
 *
 * Replace this stub with a real database / file query. When `options.client`
 * is supplied the read must run on that client so it observes writes made
 * earlier in the same transaction. When `options.primary` is set the read
 * must be routed to the primary (read-after-write).
 */
export async function fetchLocalPayouts(
  options: ReadOptions = {}
): Promise<LocalPayoutRecord[]> {
  // TODO: Replace with your actual local data source (database, CSV, etc.)
  if (options.client) {
    // Read inside the caller's transaction boundary.
    const { rows } = await options.client.query<LocalPayoutRecord>(
      "SELECT id, status, amount FROM payouts"
    );
    return rows;
  }

  console.log(
    `[reconciler] Fetching local payout records … (primary=${!!options.primary})`
  );
  return [];
}

/**
 * Fetch payout records from the remote provider API.
 *
 * By default this calls `GET <BRIDGE_API_URL>/payouts` using the configured
 * API key.  Adjust the endpoint, pagination, and response mapping to match
 * your provider.
 */
export async function fetchRemotePayouts(): Promise<RemotePayoutRecord[]> {
  console.log("[reconciler] Fetching remote payout records …");

  if (!config.bridgeApiUrl) {
    console.warn(
      "[reconciler] BRIDGE_API_URL is not set — returning empty remote list."
    );
    return [];
  }

  try {
    const response = await axios.get<RemotePayoutRecord[]>(
      `${config.bridgeApiUrl}/payouts`,
      {
        headers: {
          Authorization: `Bearer ${config.bridgeApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error: any) {
    console.error(
      "[reconciler] Failed to fetch remote payouts:",
      error.response?.data || error.message
    );
    return [];
  }
}

// ─── SEP-31 idempotent payout submission ─────────────────────────────────────

/**
 * Persisted SEP-31 transaction reference.  The `reference` is the unique
 * idempotency key that must be written *before* any external call so that
 * retries and duplicate callbacks can be reconciled against it.
 */
export interface Sep31PayoutReference {
  reference: string;
  status: "pending" | "submitted" | "completed" | "failed";
  providerPayoutId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * In-memory reference store keyed by the unique SEP-31 reference.
 *
 * In production this should be backed by a database table with a UNIQUE
 * constraint on `reference` (e.g. `UNIQUE(reference)`), so that concurrent
 * submissions of the same reference cannot both proceed.  The Map below
 * enforces the same uniqueness invariant for the starter.
 */
const payoutReferences = new Map<string, Sep31PayoutReference>();

/**
 * Persist a unique SEP-31 transaction reference before any external call.
 *
 * Returns the existing record when the reference was already persisted
 * (idempotent), or a freshly created `pending` record otherwise.  Callers
 * MUST treat a non-`pending` existing record as "already submitted" and
 * avoid re-submitting the payout.
 */
export function persistPayoutReference(
  reference: string
): Sep31PayoutReference {
  const existing = payoutReferences.get(reference);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const record: Sep31PayoutReference = {
    reference,
    status: "pending",
    providerPayoutId: null,
    createdAt: now,
    updatedAt: now,
  };
  payoutReferences.set(reference, record);
  return record;
}

/**
 * Query the provider status API to determine whether a payout for the given
 * reference already exists.  Used after ambiguous failures (timeouts /
 * unknown responses) to avoid submitting a second payout.
 */
export async function queryProviderPayoutStatus(
  reference: string
): Promise<RemotePayoutRecord | null> {
  if (!config.bridgeApiUrl) {
    return null;
  }

  try {
    const response = await axios.get<RemotePayoutRecord>(
      `${config.bridgeApiUrl}/payouts/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${config.bridgeApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error: any) {
    // 404 means the provider has no record — safe to retry submission.
    if (error.response?.status === 404) {
      return null;
    }
    // Any other failure is ambiguous; surface it so the caller does not
    // blindly retry and risk a duplicate payout.
    throw error;
  }
}

/**
 * Submit a SEP-31 payout idempotently.
 *
 * 1. Persist the unique reference before any external call.
 * 2. If the reference was already submitted/completed, return the stored
 *    record instead of submitting again.
 * 3. On ambiguous failure, query the provider status API before retrying.
 */
export async function submitPayoutIdempotent(
  reference: string,
  submit: (reference: string) => Promise<RemotePayoutRecord>
): Promise<Sep31PayoutReference> {
  const record = persistPayoutReference(reference);

  // Already submitted or completed — do not submit a second payout.
  if (record.status === "submitted" || record.status === "completed") {
    return record;
  }

  try {
    const remote = await submit(reference);
    record.status = "submitted";
    record.providerPayoutId = remote.id;
    record.updatedAt = new Date().toISOString();
    payoutReferences.set(reference, record);
    return record;
  } catch (error) {
    // Ambiguous failure: check whether the provider already has the payout.
    const remote = await queryProviderPayoutStatus(reference);
    if (remote) {
      record.status = "submitted";
      record.providerPayoutId = remote.id;
      record.updatedAt = new Date().toISOString();
      payoutReferences.set(reference, record);
      return record;
    }
    throw error;
  }
}

/**
 * Reconcile a completion callback against the persisted reference.
 *
 * Duplicate or out-of-order callbacks are matched to the existing record so
 * they never create a second payout.  Returns th

/* … truncated 4166 chars — edit only what you need near the top … */
