import { MAX_CONCURRENT_RUNS } from "@ask2gpt/protocol";

import type { TabProvenance, TabRecord } from "./relay-state";

/**
 * Soft target aligned with the product run limit. Protected pages may
 * temporarily overflow it rather than being navigated or closed unsafely.
 */
export const MANAGED_TAB_CAPACITY = MAX_CONCURRENT_RUNS;

export interface TabLifecycleBlockers {
  activeRun: boolean;
  pendingTerminal: boolean;
  historyBarrier: boolean;
  canonicalization: boolean;
  visibilityLease: boolean;
  debuggerLease: boolean;
  navigation: boolean;
  command: boolean;
}

export const NO_TAB_LIFECYCLE_BLOCKERS: Readonly<TabLifecycleBlockers> = Object.freeze({
  activeRun: false,
  pendingTerminal: false,
  historyBarrier: false,
  canonicalization: false,
  visibilityLease: false,
  debuggerLease: false,
  navigation: false,
  command: false,
});

export interface ManagedTabPageState {
  exists: boolean;
  projectScopeMatches: boolean;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  audible: boolean;
}

export interface ManagedTabPolicyInput {
  record: TabRecord;
  page: Readonly<ManagedTabPageState>;
  blockers: Readonly<TabLifecycleBlockers>;
}

export type ManagedTabBlocker =
  | "not-relay-created"
  | "user-claimed"
  | "not-idle"
  | "stale-idle-marker"
  | "page-missing"
  | "project-scope-mismatch"
  | "active-tab"
  | "highlighted-tab"
  | "pinned-tab"
  | "audible-tab"
  | "active-run"
  | "pending-terminal"
  | "history-barrier"
  | "canonicalization"
  | "visibility-lease"
  | "debugger-lease"
  | "navigation"
  | "command"
  | "idle-too-recent";

const OPERATIONAL_BLOCKERS: ReadonlyArray<
  readonly [keyof TabLifecycleBlockers, ManagedTabBlocker]
> = [
  ["activeRun", "active-run"],
  ["pendingTerminal", "pending-terminal"],
  ["historyBarrier", "history-barrier"],
  ["canonicalization", "canonicalization"],
  ["visibilityLease", "visibility-lease"],
  ["debuggerLease", "debugger-lease"],
  ["navigation", "navigation"],
  ["command", "command"],
];

/** Missing provenance belongs to the pre-provenance format and fails closed. */
export function tabProvenance(record: TabRecord): TabProvenance {
  return record.provenance ?? "legacy-unknown";
}

/** Missing epochs are the legacy initial generation. */
export function tabLeaseEpoch(record: TabRecord) {
  return record.leaseEpoch ?? 0;
}

/** Returns undefined rather than wrapping a stale-work guard. */
export function nextTabLeaseEpoch(record: TabRecord): number | undefined {
  const current = tabLeaseEpoch(record);
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return current + 1;
}

export function managedTabRecycleBlockers(
  input: ManagedTabPolicyInput,
  now = Date.now(),
): ManagedTabBlocker[] {
  const reasons: ManagedTabBlocker[] = [];
  const { record, page, blockers } = input;
  if (tabProvenance(record) !== "created") reasons.push("not-relay-created");
  if (record.userClaimedAt !== undefined) reasons.push("user-claimed");

  const idleSince = parseTimestamp(record.idleSince);
  const lastUsedAt = parseTimestamp(record.lastUsedAt ?? record.createdAt);
  if (idleSince === undefined || idleSince > now || lastUsedAt === undefined || lastUsedAt > now) {
    reasons.push("not-idle");
  } else if (lastUsedAt > idleSince) {
    reasons.push("stale-idle-marker");
  }

  if (!page.exists) reasons.push("page-missing");
  if (!page.projectScopeMatches) reasons.push("project-scope-mismatch");
  if (page.active) reasons.push("active-tab");
  if (page.highlighted) reasons.push("highlighted-tab");
  if (page.pinned) reasons.push("pinned-tab");
  if (page.audible) reasons.push("audible-tab");
  for (const [key, reason] of OPERATIONAL_BLOCKERS) {
    if (blockers[key]) reasons.push(reason);
  }
  return reasons;
}

export function isManagedTabRecycleCandidate(input: ManagedTabPolicyInput, now = Date.now()) {
  return managedTabRecycleBlockers(input, now).length === 0;
}

export function managedTabCloseBlockers(
  input: ManagedTabPolicyInput,
  now = Date.now(),
  minimumIdleMs = 0,
): ManagedTabBlocker[] {
  const reasons = managedTabRecycleBlockers(input, now);
  const idleSince = parseTimestamp(input.record.idleSince);
  if (
    !Number.isFinite(minimumIdleMs) ||
    minimumIdleMs < 0 ||
    idleSince === undefined ||
    now - idleSince < minimumIdleMs
  ) {
    reasons.push("idle-too-recent");
  }
  return reasons;
}

export function isManagedTabCloseCandidate(
  input: ManagedTabPolicyInput,
  now = Date.now(),
  minimumIdleMs = 0,
) {
  return managedTabCloseBlockers(input, now, minimumIdleMs).length === 0;
}

/** Oldest use wins; deterministic tie-breakers keep allocation stable in tests and recovery. */
export function compareManagedTabsByLru(left: TabRecord, right: TabRecord) {
  const leftLastUsedAt = sortableTimestamp(left.lastUsedAt ?? left.createdAt);
  const rightLastUsedAt = sortableTimestamp(right.lastUsedAt ?? right.createdAt);
  if (leftLastUsedAt !== rightLastUsedAt) return leftLastUsedAt < rightLastUsedAt ? -1 : 1;
  const leftCreatedAt = sortableTimestamp(left.createdAt);
  const rightCreatedAt = sortableTimestamp(right.createdAt);
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt < rightCreatedAt ? -1 : 1;
  return left.tabId - right.tabId;
}

export function sortManagedTabCandidatesByLru<T extends ManagedTabPolicyInput>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((left, right) => compareManagedTabsByLru(left.record, right.record));
}

export function selectReusableManagedTab<T extends ManagedTabPolicyInput>(
  candidates: readonly T[],
  now = Date.now(),
): T | undefined {
  return sortManagedTabCandidatesByLru(candidates).find((candidate) =>
    isManagedTabRecycleCandidate(candidate, now),
  );
}

export function countManagedTabs(records: Iterable<TabRecord>) {
  const tabIds = new Set<number>();
  for (const record of records) {
    if (tabProvenance(record) === "created" && record.userClaimedAt === undefined) {
      tabIds.add(record.tabId);
    }
  }
  return tabIds.size;
}

export function hasManagedTabCapacity(
  records: Iterable<TabRecord>,
  capacity = MANAGED_TAB_CAPACITY,
) {
  return Number.isSafeInteger(capacity) && capacity > 0 && countManagedTabs(records) < capacity;
}

function parseTimestamp(value: string | undefined) {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function sortableTimestamp(value: string) {
  return parseTimestamp(value) ?? Number.POSITIVE_INFINITY;
}
