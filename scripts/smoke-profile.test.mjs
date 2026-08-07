import assert from "node:assert/strict";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withTemporarySmokeProfile } from "./smoke-profile.mjs";

test("smoke profiles use a private OS-temp directory and clean up in finally", async () => {
  let profilePath;
  await assert.rejects(
    withTemporarySmokeProfile(async (createdPath) => {
      profilePath = createdPath;
      const info = await stat(createdPath);
      assert.equal(info.isDirectory(), true);
      assert.equal(path.relative(os.tmpdir(), createdPath).startsWith(".."), false);
      assert.equal(createdPath.includes(`${path.sep}.smoke${path.sep}`), false);
      if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o700);
      throw new Error("intentional-test-failure");
    }),
    /intentional-test-failure/u,
  );
  assert.ok(profilePath);
  await assert.rejects(access(profilePath));
});

test("temporary smoke profiles are unique and repeatably cleaned", async () => {
  const created = [];
  for (let index = 0; index < 2; index += 1) {
    await withTemporarySmokeProfile(async (profilePath) => {
      created.push(profilePath);
    });
  }
  assert.equal(new Set(created).size, 2);
  for (const profilePath of created) await assert.rejects(access(profilePath));
});
