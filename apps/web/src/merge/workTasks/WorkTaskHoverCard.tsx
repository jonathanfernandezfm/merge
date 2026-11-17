import type { ReactElement } from "react";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";
import type { WorkTaskItem } from "./grouping";
import { latestWorkTaskMember, type WorkTaskView } from "./logic";
import { WorkTaskStatusIcon } from "./presentation";
import { WORK_TASK_STATUS_PRESENTATION } from "./statusPresentation";

/** The details a row leaves out: the ADO number, state and sprint, each repo and the branch. */
export function WorkTaskHoverCard({
  item,
  onOpen,
  children,
}: {
  item: WorkTaskItem;
  /** Opens one member's task from its repo line; the row itself opens only the latest. */
  onOpen: (view: WorkTaskView) => void;
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
              <li key={member.view.key}>
                <button
                  type="button"
                  aria-label={`Open ${member.label}`}
                  className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                  onClick={() => onOpen(member.view)}
                >
                  <WorkTaskStatusIcon status={member.view.status} />
                  <span className="min-w-0 flex-1 truncate">{member.label}</span>
                  {member.view.pullRequest !== null ? (
                    <span className="text-muted-foreground">#{member.view.pullRequest.number}</span>
                  ) : null}
                  <span className="text-muted-foreground">
                    {WORK_TASK_STATUS_PRESENTATION[member.view.status].label}
                  </span>
                </button>
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
