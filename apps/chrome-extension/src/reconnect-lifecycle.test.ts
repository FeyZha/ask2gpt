import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const serviceWorkerSource = readFileSync(new URL("./service-worker.ts", import.meta.url), "utf8");

describe("relay reconnect lifecycle", () => {
  it("keeps backoff through WebSocket open and resets it only after relay authentication", () => {
    const openHandler = sourceBetween(
      'socket.addEventListener("open"',
      'socket.addEventListener("message"',
    );
    expect(openHandler).not.toContain("reconnectAttempts.delete");

    const readyHandshake = sourceBetween(
      'envelope.type === "relay.ready"',
      'if (envelope.type === "relay.error"',
    );
    expect(readyHandshake.indexOf('type: "relay.hello"')).toBeGreaterThan(-1);
    expect(readyHandshake.indexOf("await authenticateConnection(connection)")).toBeGreaterThan(
      readyHandshake.indexOf('type: "relay.hello"'),
    );

    const authenticate = sourceBetween(
      "async function authenticateConnection",
      "async function handleOpen",
    );
    expect(authenticate.indexOf("connection.authenticated = true")).toBeLessThan(
      authenticate.indexOf("reconnectAttempts.delete(connection.port)"),
    );
    expect(serviceWorkerSource.match(/reconnectAttempts\.delete/g)).toHaveLength(1);
  });
});

function sourceBetween(start: string, end: string) {
  const startIndex = serviceWorkerSource.indexOf(start);
  const endIndex = serviceWorkerSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThan(-1);
  expect(endIndex).toBeGreaterThan(startIndex);
  return serviceWorkerSource.slice(startIndex, endIndex);
}
