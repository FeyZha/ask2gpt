export const PROTOCOL_VERSION: 15;
export const RELAY_WEBSOCKET_PROTOCOL: "ask2gpt.v15";
export const RELAY_STATUS_REQUEST_TYPE: "relay.status.request";

export function isRelayProductVersionCompatible(hostVersion: string, relayVersion: string): boolean;

export interface RelayStatusRequestPayload {
  requestedAt: string;
}

export function isRelayStatusRequestPayload(value: unknown): value is RelayStatusRequestPayload;
export function makeRelayStatusRequestPayload(requestedAt?: string): RelayStatusRequestPayload;
