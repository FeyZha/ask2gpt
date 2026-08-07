import { isRecord, isSafeId } from "./security";

export interface RelayReadyIdentity {
  instanceId: string;
  label: string;
}

export function parseRelayReadyIdentity(
  envelopeInstanceId: unknown,
  payload: unknown,
): RelayReadyIdentity | undefined {
  if (
    !isSafeId(envelopeInstanceId) ||
    !isRecord(payload) ||
    !isSafeId(payload.serverInstanceId) ||
    payload.serverInstanceId !== envelopeInstanceId ||
    typeof payload.serverLabel !== "string"
  ) {
    return undefined;
  }
  const label = payload.serverLabel.replace(/\s+/gu, " ").trim();
  if (label.length < 1 || label.length > 256 || /[\p{Cc}\p{Cf}]/u.test(label)) {
    return undefined;
  }
  return { instanceId: envelopeInstanceId, label };
}

export function shouldSupersedeRelayConnection(
  existingInstanceId: string | undefined,
  nextInstanceId: string,
) {
  return existingInstanceId === nextInstanceId;
}
