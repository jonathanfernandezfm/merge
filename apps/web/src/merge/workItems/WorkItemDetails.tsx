import type { BranchWorkItems, WorkItem, WorkItemDetails } from "@t3tools/contracts";
import {
  CalendarClockIcon,
  CalendarPlusIcon,
  CopyIcon,
  FlagIcon,
  IterationCwIcon,
  MessageSquareTextIcon,
  TagIcon,
  TimerIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import { WorkItemHtml } from "./WorkItemHtml";
import { copyText, MetaRow, Section } from "./workItemPresentation";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

/** Plain text of Azure Boards HTML, for clipboard copies. */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("li").forEach((li) => li.prepend("- "));
  doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  doc.querySelectorAll("p, div, li").forEach((block) => block.append("\n"));
  return (doc.body.textContent ?? "").replace(/\n{3,}/gu, "\n\n").trim();
}

function workItemText(
  root: WorkItem,
  details: WorkItemDetails | null,
  children: ReadonlyArray<WorkItem>,
) {
  const sections = [`#${root.id} ${root.title}`];
  if (details?.descriptionHtml)
    sections.push(`Description:\n${htmlToText(details.descriptionHtml)}`);
  if (details?.criteriaHtml) {
    sections.push(`${details.criteriaLabel}:\n${htmlToText(details.criteriaHtml)}`);
  }
  if (children.length > 0) {
    sections.push(
      `Subtasks:\n${children.map((child) => `- #${child.id} ${child.title} (${child.state ?? "no state"})`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

/** A prompt an agent can act on: the work item, what done means, and the ids commits must use. */
function workItemPrompt(
  root: WorkItem,
  details: WorkItemDetails | null,
  children: ReadonlyArray<WorkItem>,
) {
  return [
    `Work on Azure Boards ${root.type ?? "work item"} #${root.id}.`,
    workItemText(root, details, children),
    "Reference the matching subtask id in each commit subject, or the parent id when none fits.",
  ].join("\n\n");
}

/** Prompt and plain-text copies of the branch's work item, for the panel's header actions. */
export function WorkItemCopyButtons({
  root,
  details,
  subtasks,
}: {
  root: WorkItem;
  details: BranchWorkItems["rootDetails"];
  subtasks: ReadonlyArray<WorkItem>;
}) {
  return (
    <>
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={() => copyText(workItemPrompt(root, details, subtasks), "Prompt")}
      >
        <MessageSquareTextIcon className="size-3.5" />
        Copy as prompt
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={() => copyText(workItemText(root, details, subtasks), "Text")}
      >
        <CopyIcon className="size-3.5" />
        Copy text
      </Button>
    </>
  );
}

/**
 * Meta rows, description, and acceptance criteria of the branch's work item. `children` are
 * extra meta rows (state, assignee) that lead the list.
 */
export function WorkItemDetailsSection({
  details,
  children,
}: {
  details: BranchWorkItems["rootDetails"];
  children?: ReactNode;
}) {
  const meta: Array<[string, typeof TagIcon, ReactNode]> = [
    ["Sprint", IterationCwIcon, details?.sprint],
    ["Priority", FlagIcon, details?.priority == null ? null : `P${details.priority}`],
    [
      "In state",
      TimerIcon,
      details?.stateChangedAt ? formatElapsedDurationLabel(details.stateChangedAt) : null,
    ],
    ["Tags", TagIcon, details && details.tags.length > 0 ? details.tags.join(", ") : null],
    ["Created", CalendarPlusIcon, formatDate(details?.createdAt ?? null)],
    ["Updated", CalendarClockIcon, formatDate(details?.updatedAt ?? null)],
  ];

  return (
    <>
      <section className="px-4 pt-2.5 pb-1">
        <div className="space-y-2">
          {children}
          {meta.map(([label, Icon, value]) =>
            value ? (
              <MetaRow key={label} icon={<Icon className="size-3.5" />} label={label}>
                <span className="block truncate">{value}</span>
              </MetaRow>
            ) : null,
          )}
        </div>
      </section>
      <Section title="Description">
        {details?.descriptionHtml ? (
          <WorkItemHtml html={details.descriptionHtml} />
        ) : (
          <Missing>No description.</Missing>
        )}
      </Section>
      <Section title={details?.criteriaLabel ?? "Acceptance criteria"}>
        {details?.criteriaHtml ? (
          <WorkItemHtml html={details.criteriaHtml} />
        ) : (
          <Missing>None written yet.</Missing>
        )}
      </Section>
    </>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground italic">{children}</p>;
}
