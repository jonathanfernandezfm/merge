// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId, WorkTaskId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as WorkTaskStore from "./WorkTaskStore.ts";

const REAL_SNAPSHOT = "/tmp/merge-resync/state.sqlite";

const WORKSPACE_JSON = JSON.stringify({
  path: "/repo/.t3/worktrees/app/feature-widgets",
  branch: "feature/widgets",
  remoteName: "origin",
  remoteBranch: "feature/widgets",
  baseBranch: "develop",
  setup: {
    status: "ready",
    steps: [
      {
        id: "fetch",
        label: "Fetch origin/feature/widgets",
        status: "done",
        log: "Fetched",
        startedAt: "2026-10-02T06:57:17.922Z",
        finishedAt: "2026-10-02T06:57:17.922Z",
      },
    ],
    error: null,
    updatedAt: "2026-10-02T06:57:19.484Z",
  },
});

const PULL_REQUEST_JSON = JSON.stringify({
  provider: "azure-devops",
  number: 53282,
  url: "https://dev.azure.com/acme/app/_git/app/pullrequest/53282",
  title: "Widgets",
  state: "merged",
  headBranch: "feature/widgets",
  baseBranch: "develop",
  checks: "passing",
  review: "approved",
  linkedAt: "2026-10-02T07:47:59.413Z",
  observedAt: "2026-10-12T11:22:33.237Z",
});

/** A row exactly as v0.0.10 wrote it, including its timestamp formats. */
const insertLegacyTask = (
  taskId: string,
  options: { archivedAt?: string; path?: string; deletedAt?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workspace = options.path
      ? JSON.stringify({ ...JSON.parse(WORKSPACE_JSON), path: options.path })
      : WORKSPACE_JSON;
    yield* sql`
      INSERT INTO projection_tasks (
        task_id, project_id, title, description, workspace_json, pull_request_json,
        auto_handle_review_feedback, auto_handle_ci_failures, waiting_for_user_reason,
        created_at, updated_at, merged_at, archived_at, deleted_at
      ) VALUES (
        ${taskId}, 'project-1', 'Widgets', NULL, ${workspace}, ${PULL_REQUEST_JSON},
        1, 0, NULL, '2026-10-02T06:57:17.900Z', '2026-10-02T06:57:19.484Z',
        '2026-10-12T11:22:21.961556+00:00', ${options.archivedAt ?? null}, ${options.deletedAt ?? null}
      )
    `;
  });

const layer = WorkTaskStore.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

describe("WorkTaskStore", () => {
  it.effect("round-trips a v0.0.10 projection_tasks row", () =>
    Effect.gen(function* () {
      const store = yield* WorkTaskStore.WorkTaskStore;
      yield* insertLegacyTask("task-1");

      const [task] = yield* store.list();
      assert.isDefined(task);
      if (!task) return;
      assert.strictEqual(task.id, "task-1");
      assert.strictEqual(task.workspace.branch, "feature/widgets");
      assert.strictEqual(task.workspace.setup.steps[0]?.status, "done");
      assert.strictEqual(task.legacyPullRequest?.number, 53282);
      assert.isTrue(task.autoHandleReviewFeedback);
      assert.strictEqual(task.mergedAt, "2026-10-12T11:22:21.961556+00:00");

      // Writing it back keeps every field, and the legacy pull request stays untouched.
      const updated = yield* store.update(task.id, { waitingForUserReason: "Pick a base" });
      assert.deepStrictEqual(yield* store.get(task.id), updated);
      assert.deepStrictEqual(
        { ...updated, waitingForUserReason: null, updatedAt: "" },
        {
          ...task,
          updatedAt: "",
        },
      );

      const sql = yield* SqlClient.SqlClient;
      const [raw] = yield* sql<{ readonly pull_request_json: string; readonly ci: number }>`
        SELECT pull_request_json, auto_handle_ci_failures AS ci FROM projection_tasks
      `;
      assert.deepStrictEqual(
        JSON.parse(raw?.pull_request_json ?? ""),
        JSON.parse(PULL_REQUEST_JSON),
      );
      assert.strictEqual(raw?.ci, 0);

      const missing = yield* Effect.flip(store.update(WorkTaskId.make("nope"), {}));
      assert.strictEqual(missing.reason, "not-found");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("links() returns the task rows of merge_thread_links", () =>
    Effect.gen(function* () {
      const store = yield* WorkTaskStore.WorkTaskStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO merge_thread_links (thread_id, task_id, folder_id, origin, updated_at) VALUES
          ('thread-a', 'task-1', NULL, 'user', '2026-01-01T00:00:00.000Z'),
          ('thread-b', 'task-1', 'folder-1', 'review-feedback', '2026-01-01T00:00:00.000Z'),
          ('thread-c', 'task-2', NULL, NULL, '2026-01-01T00:00:00.000Z'),
          ('thread-d', NULL, 'folder-1', NULL, '2026-01-01T00:00:00.000Z')
      `;
      assert.deepStrictEqual(
        (yield* store.links()).map((link) => [link.threadId, link.taskId, link.origin]),
        [
          ["thread-a", "task-1", "user"],
          ["thread-b", "task-1", "review-feedback"],
          ["thread-c", "task-2", null],
        ],
      );

      yield* store.unlink(ThreadId.make("thread-b"));
      yield* store.link(ThreadId.make("thread-d"), WorkTaskId.make("task-2"), "system");
      assert.deepStrictEqual(
        (yield* store.links()).map((link) => link.threadId),
        ["thread-a", "thread-c", "thread-d"],
      );
      // Unlinking a task thread keeps its folder.
      const [folder] = yield* sql<{ readonly folder_id: string | null }>`
        SELECT folder_id FROM merge_thread_links WHERE thread_id = 'thread-b'
      `;
      assert.strictEqual(folder?.folder_id, "folder-1");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("changes emits on subscribe and again after update", () =>
    Effect.gen(function* () {
      const store = yield* WorkTaskStore.WorkTaskStore;
      yield* insertLegacyTask("task-1");
      const fiber = yield* store.changes.pipe(
        Stream.mapEffect(() => store.list()),
        Stream.map((tasks) => tasks[0]?.title),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* store.update(WorkTaskId.make("task-1"), { title: "Renamed" });
      const titles = Array.from(yield* Fiber.join(fiber));
      assert.strictEqual(titles.at(-1), "Renamed");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ownsWorktree ignores archived and deleted tasks", () =>
    Effect.gen(function* () {
      const store = yield* WorkTaskStore.WorkTaskStore;
      yield* insertLegacyTask("active", { path: "/wt/active" });
      yield* insertLegacyTask("archived", {
        path: "/wt/archived",
        archivedAt: "2026-10-07T12:18:37.726Z",
      });
      yield* insertLegacyTask("deleted", {
        path: "/wt/deleted",
        deletedAt: "2026-10-07T12:18:37.726Z",
      });
      assert.isTrue(yield* store.ownsWorktree("/wt/active"));
      assert.isFalse(yield* store.ownsWorktree("/wt/archived"));
      assert.isFalse(yield* store.ownsWorktree("/wt/deleted"));
      assert.isFalse(yield* store.ownsWorktree("/wt/other"));
      assert.deepStrictEqual(
        (yield* store.list()).map((task) => task.id),
        ["active", "archived"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect.skipIf(!NodeFS.existsSync(REAL_SNAPSHOT))(
    "decodes every task of the real v0.0.10 snapshot",
    () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-work-tasks-"));
      const sourcePath = NodePath.join(directory, "state.sqlite");
      NodeFS.copyFileSync(REAL_SNAPSHOT, sourcePath);
      return Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        // Production path: the V2 database is created from the legacy one next to it.
        const layerDatabase = SqlitePersistence.layerConfig.pipe(
          Layer.provide(
            ServerConfig.layer({ ...config, dbPath: NodePath.join(directory, "statev2.sqlite") }),
          ),
        );
        yield* Effect.gen(function* () {
          const store = yield* WorkTaskStore.WorkTaskStore;
          const tasks = yield* store.list();
          assert.strictEqual(tasks.length, 22);
          assert.strictEqual(tasks.filter((task) => task.archivedAt !== null).length, 10);
          const links = yield* store.links();
          assert.strictEqual(links.length, 125);
          const ids = new Set(tasks.map((task) => task.id));
          assert.isTrue(links.every((link) => ids.has(link.taskId)));
        }).pipe(Effect.provide(WorkTaskStore.layer.pipe(Layer.provide(layerDatabase))));
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        ),
      );
    },
  );
});
