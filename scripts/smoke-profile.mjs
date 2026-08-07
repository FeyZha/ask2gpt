import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROFILE_PREFIX = "ask2gpt-smoke-";

export async function withTemporarySmokeProfile(operation) {
  if (typeof operation !== "function") throw new TypeError("Smoke profile operation is required.");
  const profilePath = await mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
  assertOwnedTemporarySmokeProfile(profilePath);
  try {
    // POSIX enforces this mode directly. Windows keeps the per-user ACL of the
    // OS temp directory; chmod is still applied as the narrowest portable API.
    await chmod(profilePath, 0o700);
    return await operation(profilePath);
  } finally {
    assertOwnedTemporarySmokeProfile(profilePath);
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function assertOwnedTemporarySmokeProfile(profilePath) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(profilePath);
  const relative = path.relative(temporaryRoot, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(resolved).startsWith(PROFILE_PREFIX)
  ) {
    throw new Error("Refusing to clean a smoke profile outside the owned OS-temp prefix.");
  }
}
