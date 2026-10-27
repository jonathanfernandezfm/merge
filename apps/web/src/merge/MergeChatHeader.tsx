import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadWorkTask } from "./workTasks/state";
import { WorkTaskChrome } from "./workTasks/WorkTaskChrome";

/** Fork chrome under the chat header, rendered at the `chat-header` seam. Null outside a Work Task. */
export function MergeChatHeader({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const view = useThreadWorkTask(threadRef);
  if (view === null || threadRef === null) return null;
  return <WorkTaskChrome view={view} activeThreadId={threadRef.threadId} />;
}
