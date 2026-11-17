import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, WorkTaskId, type WorkTask } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { WorkTaskInsights } from "./WorkTaskInsights.ts";
import * as WorkTaskNaming from "./WorkTaskNaming.ts";
import * as WorkTaskStore from "./WorkTaskStore.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const ID = WorkTaskId.make("task-1");

const task = (overrides: Partial<WorkTask> = {}): WorkTask => ({
  id: ID,
  projectId: ProjectId.make("project-1"),
  title: "feature/607374-copy-link",
  titleSource: "branch",
  description: null,
  workspace: {
    path: "/wt/task-1",
    branch: "feature/607374-copy-link",
    remoteName: "origin",
    remoteBranch: "feature/607374-copy-link",
    baseBranch: "main",
    setup: { status: "ready", steps: [], error: null, updatedAt: NOW },
  },
  legacyPullRequest: null,
  autoHandleReviewFeedback: false,
  waitingForUserReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

let itemTitle = "#607374 MXC00463 - AgentUI: Copying ticket link";
const item = {
  id: 607374,
  get title() {
    return itemTitle;
  },
  type: "Bug",
  state: "Active",
  parentId: null,
  assignedTo: null,
  url: null,
};

const layerDatabase = WorkTaskStore.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const harness = (options: {
  readonly generate: (
    store: WorkTaskStore.WorkTaskStore["Service"],
  ) => Effect.Effect<{ title: string }, unknown>;
  readonly workItem?: boolean;
  readonly seed?: Partial<WorkTask>;
}) => {
  const messages: Array<Record<string, unknown>> = [];
  const layer: Layer.Layer<WorkTaskNaming.WorkTaskNaming | WorkTaskStore.WorkTaskStore> =
    Layer.effect(
      WorkTaskNaming.WorkTaskNaming,
      Effect.gen(function* () {
        const store = yield* WorkTaskStore.WorkTaskStore;
        yield* store.insert(task(options.seed));
        return yield* WorkTaskNaming.make;
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.effect(
          TextGeneration,
          Effect.map(
            WorkTaskStore.WorkTaskStore,
            (store) =>
              ({
                generateThreadTitle: (input: Record<string, unknown>) => {
                  messages.push(input);
                  return options.generate(store);
                },
              }) as never,
          ),
        ).pipe(Layer.provide(layerDatabase)),
      ),
      Layer.provide(
        Layer.succeed(WorkTaskInsights, {
          workItem: () =>
            Effect.succeed(
              options.workItem === false
                ? null
                : { item, details: { descriptionHtml: "<p>Copy &amp; paste</p>" } },
            ),
        } as never),
      ),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest({})),
      Layer.provideMerge(layerDatabase),
    ) as never;
  return { messages, layer };
};

describe("WorkTaskNaming", () => {
  it.effect("name writes the generated title as generated", () => {
    const { messages, layer } = harness({
      generate: () => Effect.succeed({ title: "Copy ticket link" }),
    });
    return Effect.gen(function* () {
      const naming = yield* WorkTaskNaming.WorkTaskNaming;
      yield* naming.name(ID);
      const stored = yield* (yield* WorkTaskStore.WorkTaskStore).get(ID);
      assert.equal(stored?.title, "Copy ticket link");
      assert.equal(stored?.titleSource, "generated");
      assert.equal(messages[0]?.message, "Bug: " + item.title + "\n\nCopy & paste");
      assert.equal(messages[0]?.linkedContext, "");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a failed generation writes the stripped ADO title", () => {
    const { layer } = harness({ generate: () => Effect.fail("boom") });
    return Effect.gen(function* () {
      yield* (yield* WorkTaskNaming.WorkTaskNaming).name(ID);
      const stored = yield* (yield* WorkTaskStore.WorkTaskStore).get(ID);
      assert.equal(stored?.title, "AgentUI: Copying ticket link");
      assert.equal(stored?.titleSource, "generated");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a failed generation never stores a bare ticket number", () => {
    itemTitle = "#123";
    const { layer } = harness({ generate: () => Effect.fail("boom") });
    return Effect.gen(function* () {
      yield* (yield* WorkTaskNaming.WorkTaskNaming).name(ID);
      const stored = yield* (yield* WorkTaskStore.WorkTaskStore).get(ID);
      assert.equal(stored?.title, "feature/607374-copy-link");
      assert.equal(stored?.titleSource, "branch");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => void (itemTitle = "#607374 MXC00463 - AgentUI: Copying ticket link")),
      ),
    );
  });

  it.effect("no work item leaves the title alone", () => {
    const { layer } = harness({ workItem: false, generate: () => Effect.succeed({ title: "X" }) });
    return Effect.gen(function* () {
      yield* (yield* WorkTaskNaming.WorkTaskNaming).name(ID);
      const stored = yield* (yield* WorkTaskStore.WorkTaskStore).get(ID);
      assert.equal(stored?.title, "feature/607374-copy-link");
      assert.equal(stored?.titleSource, "branch");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a rename during generation keeps the user's title", () => {
    const { layer } = harness({
      generate: (store) =>
        store
          .update(ID, { title: "My name", titleSource: "user" })
          .pipe(Effect.as({ title: "Late title" })),
    });
    return Effect.gen(function* () {
      yield* (yield* WorkTaskNaming.WorkTaskNaming).name(ID);
      const stored = yield* (yield* WorkTaskStore.WorkTaskStore).get(ID);
      assert.equal(stored?.title, "My name");
      assert.equal(stored?.titleSource, "user");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rename with a title sets user; without one it generates", () => {
    const { layer } = harness({
      seed: { title: "Mine", titleSource: "user" },
      generate: () => Effect.succeed({ title: "Fresh" }),
    });
    return Effect.gen(function* () {
      const naming = yield* WorkTaskNaming.WorkTaskNaming;
      const typed = yield* naming.rename({ taskId: ID, title: "Typed" });
      assert.equal(typed.title, "Typed");
      assert.equal(typed.titleSource, "user");
      const ai = yield* naming.rename({ taskId: ID });
      assert.equal(ai.title, "Fresh");
      assert.equal(ai.titleSource, "generated");
    }).pipe(Effect.provide(layer));
  });
});
