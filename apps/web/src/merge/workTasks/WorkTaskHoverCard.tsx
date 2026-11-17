import type { ReactElement } from "react";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";
import type { WorkTaskItem } from "./grouping";
import { latestWorkTaskMember } from "./logic";
import { WorkTaskStatusIcon } from "./presentation";
import { WORK_TASK_STATUS_PRESENTATION } from "./statusPresentation";

/** The details a row leaves out: the ADO number, state and sprint, each repo and the branch. */
export function WorkTaskHoverCard({
  item,
  children,
}: {
  item: WorkTaskItem;
  /** The row's own element; it becomes the trigger, so click and keyboard stay with it. */
  children: ReactElement;
}) {
  const { workItem } = item;
  const meta = workItem === null ? [] : [workItem.state, workItem.sprint].filter(Boolean);
  return (
    <PreviewCard>
      <PreviewCardTrigger render={children} />
      <PreviewCardPopup side="right" className="w-80">
        <div className="flex flex-col gap-2 p-3 text-sm">
          <p className="font-medium">{item.title}</p>
          {workItem !== null ? (
            <p className="text-muted-foreground text-xs">
              {`${workItem.type} ${workItem.id}`}
              {meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}
            </p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {item.members.map((member) => (
              <li key={member.view.key} className="flex min-w-0 items-center gap-2 text-xs">
                <WorkTaskStatusIcon status={member.view.status} />
                <span className="min-w-0 flex-1 truncate">{member.label}</span>
                {member.view.pullRequest !== null ? (
                  <span className="text-muted-foreground">#{member.view.pullRequest.number}</span>
                ) : null}
                <span className="text-muted-foreground">
                  {WORK_TASK_STATUS_PRESENTATION[member.view.status].label}
                </span>
              </li>
            ))}
          </ul>
          <p className="truncate font-mono text-muted-foreground text-xs">
            {latestWorkTaskMember(item).view.task.workspace.branch}
          </p>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
