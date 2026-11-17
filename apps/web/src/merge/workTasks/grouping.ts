import {
  stripWorkItemPrefixes,
  WORK_TASK_STATUS_URGENCY,
  workTaskSection,
  type WorkTaskInsight,
  type WorkTaskSection,
  type WorkTaskStatus,
  type WorkTaskWorkItem,
} from "@t3tools/contracts";

import type { WorkTaskView } from "./logic";

export interface WorkTaskItemMember {
  readonly view: WorkTaskView;
  readonly repo: string;
  readonly label: string;
  readonly insight: WorkTaskInsight | null;
  readonly unseen: boolean;
}

export interface WorkTaskItem {
  readonly key: string;
  readonly workItem: WorkTaskWorkItem | null;
  readonly title: string;
  readonly section: WorkTaskSection;
  readonly status: WorkTaskStatus;
  readonly unseen: boolean;
  readonly members: ReadonlyArray<WorkTaskItemMember>;
  readonly activityAt: string;
}

const WORK_TASK_SECTIONS: ReadonlyArray<WorkTaskSection> = [
  "attention",
  "working",
  "review",
  "done",
];

/** Branch-made titles of older tasks carry the ADO number, which rows never show. */
const displayTitle = ({ title, titleSource }: WorkTaskView["task"]): string => {
  if (titleSource === "user") return title;
  const stripped = stripWorkItemPrefixes(title);
  return /^#?\d+$/.test(stripped) ? title : stripped;
};

const sectionRank = (section: WorkTaskSection) => WORK_TASK_SECTIONS.indexOf(section);

/** Tasks sharing an ADO work item (same environment) form one item; the rest stand alone. */
export function groupWorkTaskItems(input: {
  readonly views: ReadonlyArray<WorkTaskView>;
  readonly insights: ReadonlyMap<string, WorkTaskInsight>;
  readonly repoName: (view: WorkTaskView) => string;
  readonly unseen: (view: WorkTaskView) => boolean;
}): ReadonlyArray<WorkTaskItem> {
  const groups = new Map<string, WorkTaskItemMember[]>();
  for (const view of input.views) {
    const insight = input.insights.get(view.key) ?? null;
    const key =
      insight?.workItem != null
        ? `ado:${view.task.environmentId}:${insight.workItem.id}`
        : `task:${view.key}`;
    const member = {
      view,
      repo: input.repoName(view),
      label: "",
      insight,
      unseen: input.unseen(view),
    };
    const members = groups.get(key);
    if (members === undefined) groups.set(key, [member]);
    else members.push(member);
  }

  const items = [...groups].map(([key, raw]): WorkTaskItem => {
    const repoCount = new Map<string, number>();
    for (const { repo } of raw) repoCount.set(repo, (repoCount.get(repo) ?? 0) + 1);
    const members = raw
      .map((member) => ({
        ...member,
        label:
          (repoCount.get(member.repo) ?? 0) > 1
            ? `${member.repo} · ${member.view.task.workspace.branch}`
            : member.repo,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    const rank = (member: WorkTaskItemMember) =>
      [
        sectionRank(workTaskSection(member.view.status, member.unseen)),
        WORK_TASK_STATUS_URGENCY.indexOf(member.view.status),
      ] as const;
    const lead = members.reduce((best, member) => {
      const [bs, bu] = rank(best);
      const [ms, mu] = rank(member);
      return ms < bs || (ms === bs && mu < bu) ? member : best;
    });

    const byNewest = members.toSorted((a, b) =>
      b.view.task.createdAt.localeCompare(a.view.task.createdAt),
    );
    const titled =
      byNewest.find((member) => member.view.task.titleSource === "user") ?? byNewest[0]!;

    return {
      key,
      workItem: members.find((member) => member.insight?.workItem)?.insight?.workItem ?? null,
      title: displayTitle(titled.view.task),
      section: workTaskSection(lead.view.status, lead.unseen),
      status: lead.view.status,
      unseen: lead.unseen,
      members,
      activityAt: members.reduce(
        (latest, member) => (member.view.activityAt > latest ? member.view.activityAt : latest),
        "",
      ),
    };
  });

  return items.toSorted(
    (a, b) =>
      sectionRank(a.section) - sectionRank(b.section) || b.activityAt.localeCompare(a.activityAt),
  );
}
