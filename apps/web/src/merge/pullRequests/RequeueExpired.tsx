import {
  AZURE_DEVOPS_EXPIRED_CHECK_DESCRIPTION,
  AuthSourceControlWriteScope,
  MERGE_WS_METHODS,
  type EnvironmentId,
  type PullRequestCheck,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { failureMessage } from "../workItems/workItemPresentation";

const requeueExpiredChecks = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:merge:pull-requests-requeue-expired-checks",
  tag: MERGE_WS_METHODS.pullRequestsRequeueExpiredChecks,
});

/** Expired Azure DevOps builds, which hold the merge until someone queues them again. */
export function expiredCheckCount(checks: ReadonlyArray<PullRequestCheck>): number {
  return checks.filter(
    (check) =>
      check.status === "action-required" &&
      check.description === AZURE_DEVOPS_EXPIRED_CHECK_DESCRIPTION,
  ).length;
}

/**
 * Re-queues an open Azure DevOps pull request's expired builds. Rendered at the `scm-ado` seam in
 * upstream's pull request detail panel; renders nothing for other hosts.
 */
export function RequeueExpired(props: {
  env: EnvironmentId;
  detail: {
    readonly state: string;
    readonly number: number;
    readonly workspaceRoot: string;
    readonly checks: ReadonlyArray<PullRequestCheck>;
  } | null;
}) {
  const canWrite = useEnvironmentScope(props.env, AuthSourceControlWriteScope);
  const requeue = useAtomCommand(requeueExpiredChecks, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [queuedFor, setQueuedFor] = useState<number | null>(null);
  const detail = props.detail;
  const expired = detail?.state === "open" ? expiredCheckCount(detail.checks) : 0;
  if (detail === null || expired === 0 || !canWrite || queuedFor === detail.number) return null;

  const run = () => {
    setPending(true);
    void requeue({
      environmentId: props.env,
      input: { cwd: detail.workspaceRoot, number: detail.number },
    }).then((result) => {
      setPending(false);
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not queue the expired checks",
          description: failureMessage(
            result.cause,
            "Check that you have permission to queue builds for this repository.",
          ),
        });
        return;
      }
      setQueuedFor(detail.number);
      toastManager.add({
        type: "success",
        title: `Queued ${result.value.queued} expired ${result.value.queued === 1 ? "check" : "checks"} again`,
      });
    });
  };

  return (
    <div className="flex justify-end px-4 pb-2">
      <Button size="xs" variant="outline" disabled={pending} onClick={run}>
        {pending ? <Spinner size="xs" /> : <RotateCcwIcon aria-hidden className="size-3.5" />}
        Re-queue {expired} expired {expired === 1 ? "check" : "checks"}
      </Button>
    </div>
  );
}
