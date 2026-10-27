// @effect-diagnostics nodeBuiltinImport:off -- Reads recorded az fixtures and makes a temp workspace.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import { branchWorkItems, createChildWorkItem, linkBranchWorkItem } from "./workItems.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./testFixtures/${name}`, import.meta.url), "utf8");

const output = (stdout: string) => ({
  exitCode: 0 as never,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function harness(options: {
  readonly branch: string | null;
  readonly linked?: string | null;
  readonly kind?: string;
  readonly az?: (args: ReadonlyArray<string>) => string;
}) {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-wi-")));
  const az: Array<ReadonlyArray<string>> = [];
  const git: Array<ReadonlyArray<string>> = [];
  const layer = Layer.mergeAll(
    Layer.mock(VcsProcess.VcsProcess)({
      run: (input) => {
        az.push([input.command, ...input.args]);
        return Effect.succeed(output(options.az?.(input.args) ?? ""));
      },
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: (input) => {
        git.push(input.args);
        const isBranchRead = input.args[0] === "symbolic-ref";
        return Effect.succeed({
          ...output(isBranchRead && options.branch ? `${options.branch}\n` : ""),
          exitCode: (isBranchRead && options.branch === null ? 1 : 0) as never,
        });
      },
      readConfigValue: () => Effect.succeed(options.linked ?? null),
    }),
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
      resolve: () =>
        Effect.succeed({
          kind: SourceControlProviderKind.make(options.kind ?? "azure-devops"),
        } as unknown as SourceControlProviderRegistry.SourceControlProviderRegistration["provider"]),
    }),
    Layer.mock(KnownWorkspaces.KnownWorkspaces)({ contains: () => Effect.succeed(false) }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3-merge-wi-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { root, az, git, layer };
}

describe("merge.workItems", () => {
  it.effect("reads the branch's work item family with each type's states", () => {
    const h = harness({
      branch: "feature/#605892-remove-languages",
      az: (args) =>
        args[0] === "boards"
          ? fixture("azBoardsQueryFamily.json")
          : fixture("azWorkItemTypeStates.json"),
    });
    return Effect.gen(function* () {
      const result = yield* branchWorkItems({ cwd: h.root });
      assert.strictEqual(result.source, "branch-name");
      assert.strictEqual(result.root?.id, 605892);
      assert.strictEqual(result.rootDetails?.sprint, "Sprint 91");
      assert.deepStrictEqual(
        result.children.map((child) => child.id),
        [605901],
      );
      assert.deepStrictEqual(Object.keys(result.states).toSorted(), [
        "Product Backlog Item",
        "Task",
      ]);
      // One family query, then one states read per type, all as argv.
      expect(h.az[0]).toEqual(
        expect.arrayContaining(["az", "boards", "query", "--wiql", "--output", "json"]),
      );
      expect(h.az.slice(1).map((args) => args.at(-4))).toEqual(
        expect.arrayContaining(["type=Product Backlog Item", "type=Task"]),
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does not call az outside Azure DevOps or without an id in the branch", () =>
    Effect.gen(function* () {
      const github = harness({ branch: "feature/#605892-x", kind: "github" });
      const fromGithub = yield* branchWorkItems({ cwd: github.root }).pipe(
        Effect.provide(github.layer),
      );
      assert.isFalse(fromGithub.supported);
      assert.deepStrictEqual(github.az, []);

      const plain = harness({ branch: "main" });
      const fromPlain = yield* branchWorkItems({ cwd: plain.root }).pipe(
        Effect.provide(plain.layer),
      );
      assert.isTrue(fromPlain.supported);
      assert.isNull(fromPlain.workItemId);
      assert.deepStrictEqual(plain.az, []);
    }),
  );

  it.effect("rejects a cwd that is not a known workspace before running anything", () => {
    const h = harness({ branch: "feature/#605892-x" });
    const elsewhere = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-wi-other-"));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(branchWorkItems({ cwd: elsewhere }));
      assert.strictEqual(error.detail, "Work items need a known workspace.");
      assert.deepStrictEqual(h.az, []);
      assert.deepStrictEqual(h.git, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("links and unlinks the checked-out branch through git config", () => {
    const h = harness({ branch: "feature/x" });
    return Effect.gen(function* () {
      yield* linkBranchWorkItem({ cwd: h.root, id: 9001 });
      yield* linkBranchWorkItem({ cwd: h.root, id: null });
      assert.deepStrictEqual(h.git.slice(1), [
        ["config", "branch.feature/x.work-item", "9001"],
        ["symbolic-ref", "--short", "-q", "HEAD"],
        ["config", "--unset", "branch.feature/x.work-item"],
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "creates a child in its parent's area and iteration, with values kept as flags' own",
    () => {
      const h = harness({
        branch: "feature/x",
        az: (args) =>
          args.includes("show")
            ? JSON.stringify({
                fields: {
                  "System.TeamProject": "P",
                  "System.AreaPath": "P\\Team",
                  "System.IterationPath": "P\\Sprint 1",
                },
              })
            : args.includes("create")
              ? JSON.stringify({ id: 12 })
              : "{}",
      });
      return Effect.gen(function* () {
        const created = yield* createChildWorkItem({
          cwd: h.root,
          parentId: 7,
          type: "Task",
          title: "--help; rm -rf",
        });
        assert.deepStrictEqual(created, { id: 12 });
        const [, create, relate] = h.az;
        expect(create).toEqual(
          expect.arrayContaining([
            "--project=P",
            "--type=Task",
            "--title=--help; rm -rf",
            "--area=P\\Team",
            "--iteration=P\\Sprint 1",
          ]),
        );
        expect(relate).toEqual(
          expect.arrayContaining(["relation", "add", "--id", "12", "--target-id", "7"]),
        );
      }).pipe(Effect.provide(h.layer));
    },
  );
});
