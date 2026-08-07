export const PROTOCOL_VERSION = 15;
export const RELAY_WEBSOCKET_PROTOCOL = `ask2gpt.v${PROTOCOL_VERSION}`;
export const RELAY_STATUS_REQUEST_TYPE = "relay.status.request";

const CURRENT_PRODUCT_MAJOR = 0;
const CURRENT_PRODUCT_MINOR = 0;
const CURRENT_MINIMUM_PATCH = 1;

export function isRelayProductVersionCompatible(hostVersion, relayVersion) {
  if (hostVersion === relayVersion) return true;
  const host = parseStableProductVersion(hostVersion);
  const relay = parseStableProductVersion(relayVersion);
  return Boolean(
    host &&
    relay &&
    isCurrentProductRelease(host) &&
    isCurrentProductRelease(relay) &&
    Math.abs(host[2] - relay[2]) <= 1,
  );
}

function parseStableProductVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return undefined;
  return match.slice(1).map(Number);
}

function isCurrentProductRelease([major, minor, patch]) {
  return (
    major === CURRENT_PRODUCT_MAJOR &&
    minor === CURRENT_PRODUCT_MINOR &&
    patch >= CURRENT_MINIMUM_PATCH
  );
}

export function isRelayStatusRequestPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "requestedAt") return false;
  return (
    typeof value.requestedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value.requestedAt,
    ) &&
    Number.isFinite(Date.parse(value.requestedAt))
  );
}

export function makeRelayStatusRequestPayload(requestedAt = new Date().toISOString()) {
  const payload = { requestedAt };
  if (!isRelayStatusRequestPayload(payload)) {
    throw new TypeError("Invalid relay status request timestamp.");
  }
  return payload;
}
