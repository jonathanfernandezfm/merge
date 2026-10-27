// @effect-diagnostics nodeBuiltinImport:off -- Reads recorded az fixtures synchronously.
import * as NodeFS from "node:fs";

import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeWorkItemFamilyJson,
  decodeWorkItemStatesJson,
  resolveBranchWorkItemId,
  workItemFamilyWiql,
  workItemIdFromBranch,
  workItemWebUrl,
} from "./azureBoards.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./testFixtures/${name}`, import.meta.url), "utf8");

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("branch autodetection", () => {
  it("reads the work item a branch is named after", () => {
    expect(workItemIdFromBranch("feature/#605892-remove-languages")).toBe(605892);
    expect(workItemIdFromBranch("bugfix/ESP-606598-cypress")).toBe(606598);
    expect(workItemIdFromBranch("task/#606282")).toBe(606282);
    expect(workItemIdFromBranch("feature/http2-support")).toBeNull();
    expect(workItemIdFromBranch("release/2026.1")).toBeNull();
    expect(workItemIdFromBranch("release/2026-10")).toBeNull();
    expect(workItemIdFromBranch("hotfix/2026-10-05-x")).toBeNull();
    expect(workItemIdFromBranch("renovate/foo-20240101")).toBeNull();
  });

  it("prefers a hand-made link over the id in the branch name", () => {
    expect(resolveBranchWorkItemId("bugfix/#7001-fix", "9001")).toEqual({
      id: 9001,
      source: "linked",
    });
    expect(resolveBranchWorkItemId("bugfix/#7001-fix", null)).toEqual({
      id: 7001,
      source: "branch-name",
    });
    expect(resolveBranchWorkItemId("bugfix/#7001-fix", "not-a-number")).toEqual({
      id: 7001,
      source: "branch-name",
    });
    expect(resolveBranchWorkItemId("main", null)).toBeNull();
  });

  it("builds WIQL only from a validated id", () => {
    expect(workItemFamilyWiql(7)).toContain("[System.Id] = 7 OR [System.Parent] = 7");
    expect(() => workItemFamilyWiql(Number.NaN)).toThrow();
    expect(() => workItemFamilyWiql(-1)).toThrow();
  });
});

describe("Azure Boards JSON", () => {
  it("reads a work item family from recorded az boards query output", () => {
    const family = expectSuccess(
      decodeWorkItemFamilyJson(fixture("azBoardsQueryFamily.json"), 605892),
    );
    expect(family.items).toEqual([
      {
        id: 605892,
        title: "Remove languages",
        type: "Product Backlog Item",
        state: "Committed",
        parentId: null,
        assignedTo: "Sarah Lin",
        project: "WorkHub",
        url: "https://dev.azure.com/acme/0c9a2f1e-1111-4a5b-9c3d-2e4f6a8b0c1d/_workitems/edit/605892",
      },
      {
        id: 605901,
        title: "Tests",
        type: "Task",
        state: "To Do",
        parentId: 605892,
        assignedTo: null,
        project: "WorkHub",
        url: "https://dev.azure.com/acme/0c9a2f1e-1111-4a5b-9c3d-2e4f6a8b0c1d/_workitems/edit/605901",
      },
    ]);
    expect(family.rootDetails).toEqual({
      descriptionHtml: "<div>Languages removed in <b>Admin UI</b> still show up.</div>",
      criteriaHtml: "<ul><li>Removed languages no longer show in the picker</li></ul>",
      criteriaLabel: "Acceptance criteria",
      sprint: "Sprint 91",
      priority: 2,
      tags: ["2026.Q3", "groomed"],
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-10-04T12:00:00.000Z",
      stateChangedAt: "2026-10-01T08:10:00.000Z",
    });
  });

  it("falls back to repro steps for bugs, and reads a root iteration as no sprint", () => {
    const family = expectSuccess(
      decodeWorkItemFamilyJson(
        JSON.stringify([
          {
            id: 7,
            fields: {
              "System.Title": "Bug",
              "Microsoft.VSTS.TCM.ReproSteps": "<p>Open it</p>",
              "System.IterationPath": "WorkHub",
            },
          },
        ]),
        7,
      ),
    );
    expect(family.rootDetails?.criteriaLabel).toBe("Repro steps");
    expect(family.rootDetails?.criteriaHtml).toBe("<p>Open it</p>");
    expect(family.rootDetails?.sprint).toBeNull();
  });

  it("reads an empty answer as no items", () => {
    expect(expectSuccess(decodeWorkItemFamilyJson("", 7))).toEqual({
      items: [],
      rootDetails: null,
    });
  });

  it("reads a type's states without removed ones", () => {
    expect(expectSuccess(decodeWorkItemStatesJson(fixture("azWorkItemTypeStates.json")))).toEqual([
      { name: "To Do", category: "proposed" },
      { name: "In Progress", category: "in-progress" },
      { name: "Done", category: "completed" },
    ]);
  });

  it("maps work item REST URLs to their web page", () => {
    expect(workItemWebUrl("https://acme.visualstudio.com/abc-123/_apis/wit/workItems/582642")).toBe(
      "https://acme.visualstudio.com/abc-123/_workitems/edit/582642",
    );
    expect(workItemWebUrl("https://acme.visualstudio.com/other")).toBeNull();
  });
});
