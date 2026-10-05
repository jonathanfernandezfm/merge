import { assert, it } from "@effect/vitest";

import {
  transportSafeSourceControlErrorValue,
  workItemIdFromBranch,
} from "./SourceControlProvider.ts";

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});

it("normalizes control characters and bounds error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(`  owner/repo\n\t${"x".repeat(300)}  `),
    `owner/repo ${"x".repeat(245)}`,
  );
});

it("reads the work item a branch is named after", () => {
  assert.strictEqual(workItemIdFromBranch("feature/#605892-remove-languages"), 605892);
  assert.strictEqual(workItemIdFromBranch("bugfix/ESP-606598-cypress"), 606598);
  assert.strictEqual(workItemIdFromBranch("task/#606282"), 606282);
  assert.strictEqual(workItemIdFromBranch("feature/http2-support"), null);
  assert.strictEqual(workItemIdFromBranch("release/2026.1"), null);
  assert.strictEqual(workItemIdFromBranch("release/2026-10"), null);
  assert.strictEqual(workItemIdFromBranch("hotfix/2026-10-05-x"), null);
  assert.strictEqual(workItemIdFromBranch("renovate/foo-20240101"), null);
});
