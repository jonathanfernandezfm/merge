import { MERGE_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "~/connection/runtime";

export const WORK_ITEMS_SURFACE_ID = "merge:work-items" as const;

// Work item reads boot `az` (about two seconds), so they are kept a minute and refreshed after
// every edit instead of polled.
const branch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:merge:work-items-branch",
  tag: MERGE_WS_METHODS.workItemsBranch,
  staleTimeMs: 60_000,
});

const command = <
  TTag extends
    | typeof MERGE_WS_METHODS.workItemsLink
    | typeof MERGE_WS_METHODS.workItemsUpdate
    | typeof MERGE_WS_METHODS.workItemsCreateChild,
>(
  label: string,
  tag: TTag,
) =>
  createEnvironmentRpcCommand(connectionAtomRuntime, {
    label,
    tag,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.cwd}`,
    },
    onSettled: (target, registry) =>
      Effect.sync(() =>
        registry.refresh(
          branch({ environmentId: target.environmentId, input: { cwd: target.input.cwd } }),
        ),
      ),
  });

export const workItemsEnvironment = {
  branch,
  link: command("environment-data:merge:work-items-link", MERGE_WS_METHODS.workItemsLink),
  update: command("environment-data:merge:work-items-update", MERGE_WS_METHODS.workItemsUpdate),
  createChild: command(
    "environment-data:merge:work-items-create-child",
    MERGE_WS_METHODS.workItemsCreateChild,
  ),
};
