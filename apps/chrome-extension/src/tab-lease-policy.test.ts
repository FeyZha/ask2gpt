import { MAX_CONCURRENT_RUNS } from "@ask2gpt/protocol";
import { describe, expect, it } from "vitest";

import type { TabRecord } from "./relay-state";
import {
  MANAGED_TAB_CAPACITY,
  NO_TAB_LIFECYCLE_BLOCKERS,
  compareManagedTabsByLru,
  countManagedTabs,
  hasManagedTabCapacity,
  isManagedTabCloseCandidate,
  isManagedTabRecycleCandidate,
  managedTabCloseBlockers,
  managedTabRecycleBlockers,
  nextTabLeaseEpoch,
  selectReusableManagedTab,
  sortManagedTabCandidatesByLru,
  tabLeaseEpoch,
  tabProvenance,
  type ManagedTabBlocker,
  type ManagedTabPageState,
  type ManagedTabPolicyInput,
  type TabLifecycleBlockers,
} from "./tab-lease-policy";

const createdAt = "2026-07-24T00:00:00.000Z";
const lastUsedAt = "2026-07-24T00:05:00.000Z";
const idleSince = "2026-07-24T00:06:00.000Z";
const now = Date.parse("2026-07-24T00:10:00.000Z");

const baseRecord: TabRecord = {
  owned: true,
  instanceId: "instance-1",
  conversationId: "conversation-1",
  tabId: 7,
  projectScope: "https://chatgpt.com/g/ask2gpt/",
  createdAt,
  provenance: "created",
  leaseEpoch: 3,
  lastUsedAt,
  idleSince,
};

const safePage: ManagedTabPageState = {
  exists: true,
  projectScopeMatches: true,
  active: false,
  highlighted: false,
  pinned: false,
  audible: false,
};

function policyInput(
  overrides: {
    record?: Partial<TabRecord>;
    page?: Partial<ManagedTabPageState>;
    blockers?: Partial<TabLifecycleBlockers>;
  } = {},
): ManagedTabPolicyInput {
  return {
    record: { ...baseRecord, ...overrides.record },
    page: { ...safePage, ...overrides.page },
    blockers: { ...NO_TAB_LIFECYCLE_BLOCKERS, ...overrides.blockers },
  };
}

describe("managed tab lease policy", () => {
  it("uses the product concurrency limit as the steady managed capacity", () => {
    expect(MANAGED_TAB_CAPACITY).toBe(MAX_CONCURRENT_RUNS);
    expect(MANAGED_TAB_CAPACITY).toBe(3);
  });

  it("fails closed for legacy provenance and advances lease epochs monotonically", () => {
    expect(tabProvenance({ ...baseRecord, provenance: undefined })).toBe("legacy-unknown");
    expect(tabLeaseEpoch({ ...baseRecord, leaseEpoch: undefined })).toBe(0);
    expect(nextTabLeaseEpoch({ ...baseRecord, leaseEpoch: undefined })).toBe(1);
    expect(nextTabLeaseEpoch(baseRecord)).toBe(4);
    expect(
      nextTabLeaseEpoch({ ...baseRecord, leaseEpoch: Number.MAX_SAFE_INTEGER }),
    ).toBeUndefined();
  });

  it.each([
    ["activeRun", "active-run"],
    ["pendingTerminal", "pending-terminal"],
    ["historyBarrier", "history-barrier"],
    ["canonicalization", "canonicalization"],
    ["visibilityLease", "visibility-lease"],
    ["debuggerLease", "debugger-lease"],
    ["navigation", "navigation"],
    ["command", "command"],
  ] satisfies Array<[keyof TabLifecycleBlockers, ManagedTabBlocker]>)(
    "blocks recycling while %s is present",
    (key, expectedReason) => {
      const candidate = policyInput({ blockers: { [key]: true } });

      expect(isManagedTabRecycleCandidate(candidate, now)).toBe(false);
      expect(managedTabRecycleBlockers(candidate, now)).toContain(expectedReason);
    },
  );

  it.each([
    ["exists", false, "page-missing"],
    ["projectScopeMatches", false, "project-scope-mismatch"],
    ["active", true, "active-tab"],
    ["highlighted", true, "highlighted-tab"],
    ["pinned", true, "pinned-tab"],
    ["audible", true, "audible-tab"],
  ] satisfies Array<[keyof ManagedTabPageState, boolean, ManagedTabBlocker]>)(
    "blocks recycling for unsafe page state %s",
    (key, value, expectedReason) => {
      const candidate = policyInput({ page: { [key]: value } });

      expect(isManagedTabRecycleCandidate(candidate, now)).toBe(false);
      expect(managedTabRecycleBlockers(candidate, now)).toContain(expectedReason);
    },
  );

  it("recycles only idle Relay-created tabs which the user has not claimed", () => {
    expect(isManagedTabRecycleCandidate(policyInput(), now)).toBe(true);
    expect(
      isManagedTabRecycleCandidate(
        policyInput({ record: { owned: false, provenance: "borrowed" } }),
        now,
      ),
    ).toBe(false);
    expect(
      isManagedTabRecycleCandidate(policyInput({ record: { provenance: "legacy-unknown" } }), now),
    ).toBe(false);
    expect(
      isManagedTabRecycleCandidate(policyInput({ record: { provenance: undefined } }), now),
    ).toBe(false);
    expect(
      managedTabRecycleBlockers(
        policyInput({ record: { userClaimedAt: "2026-07-24T00:07:00.000Z" } }),
        now,
      ),
    ).toContain("user-claimed");
  });

  it("rejects missing, future, or stale idle markers", () => {
    expect(
      managedTabRecycleBlockers(policyInput({ record: { idleSince: undefined } }), now),
    ).toContain("not-idle");
    expect(
      managedTabRecycleBlockers(
        policyInput({ record: { idleSince: "2026-07-24T00:11:00.000Z" } }),
        now,
      ),
    ).toContain("not-idle");
    expect(
      managedTabRecycleBlockers(
        policyInput({ record: { lastUsedAt: "2026-07-24T00:07:00.000Z" } }),
        now,
      ),
    ).toContain("stale-idle-marker");
  });

  it("requires the configured idle age before a recyclable tab can close", () => {
    const fiveMinutes = 5 * 60 * 1000;

    expect(isManagedTabCloseCandidate(policyInput(), now, fiveMinutes)).toBe(false);
    expect(managedTabCloseBlockers(policyInput(), now, fiveMinutes)).toContain("idle-too-recent");
    expect(isManagedTabCloseCandidate(policyInput(), now + 60_000, fiveMinutes)).toBe(true);
    expect(isManagedTabCloseCandidate(policyInput(), now + 60_000, -1)).toBe(false);
  });

  it("orders by least-recent use and selects the oldest eligible candidate", () => {
    const newest = policyInput({
      record: { tabId: 9, lastUsedAt: "2026-07-24T00:05:00.000Z" },
    });
    const eligibleOldest = policyInput({
      record: { tabId: 8, lastUsedAt: "2026-07-24T00:02:00.000Z" },
    });
    const ineligibleOldest = policyInput({
      record: {
        owned: false,
        tabId: 7,
        provenance: "borrowed",
        lastUsedAt: "2026-07-24T00:01:00.000Z",
      },
    });

    expect(
      sortManagedTabCandidatesByLru([newest, eligibleOldest, ineligibleOldest]).map(
        (candidate) => candidate.record.tabId,
      ),
    ).toEqual([7, 8, 9]);
    expect(
      selectReusableManagedTab([newest, eligibleOldest, ineligibleOldest], now)?.record.tabId,
    ).toBe(8);
    expect(compareManagedTabsByLru(eligibleOldest.record, newest.record)).toBeLessThan(0);
  });

  it("counts unique Relay-created tabs and enforces the bounded pool", () => {
    const records = [
      { ...baseRecord, tabId: 1 },
      { ...baseRecord, tabId: 2 },
      { ...baseRecord, tabId: 2, conversationId: "alias-for-tab-2" },
      { ...baseRecord, tabId: 3 },
      { ...baseRecord, owned: false, tabId: 4, provenance: "borrowed" as const },
      { ...baseRecord, tabId: 5, provenance: "legacy-unknown" as const },
      { ...baseRecord, tabId: 6, userClaimedAt: "2026-07-24T00:07:00.000Z" },
    ];

    expect(countManagedTabs(records)).toBe(3);
    expect(hasManagedTabCapacity(records)).toBe(false);
    expect(hasManagedTabCapacity(records.slice(0, 1))).toBe(true);
    expect(hasManagedTabCapacity(records, 0)).toBe(false);
  });
});
