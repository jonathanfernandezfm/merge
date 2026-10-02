import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildT3ProjectFileJsonSchema,
  parseT3ProjectFile,
  setT3ProjectFileCopyRules,
  T3ProjectFileFromJson,
} from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("buildT3ProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema with the published $id", () => {
    const schema = buildT3ProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://t3.codes/schema/t3.json");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents every supported field", () => {
    const schema = buildT3ProjectFileJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          items?: { properties: Record<string, unknown>; required: ReadonlyArray<string> };
        }
      >;
      required?: ReadonlyArray<string>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      "$schema",
      "defaultThreadEnvMode",
      "iconPath",
      "scripts",
      "workspace",
      "worktreeSubmodules",
    ]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.iconPath?.description).toContain("Workspace-relative path");
    expect(schema.properties.defaultThreadEnvMode?.description).toContain("new threads start");

    const script = schema.properties.scripts?.items;
    expect(script?.required).toEqual(["name", "command"]);
    expect(Object.keys(script?.properties ?? {}).sort()).toEqual([
      "async",
      "autoOpenPreview",
      "command",
      "icon",
      "name",
      "previewUrl",
      "runOnWorktreeCreate",
    ]);
  });

  it("stays JSON-serializable", () => {
    const schema = buildT3ProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseT3ProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseT3ProjectFile('{ "defaultThreadEnvMode": "worktree" }')).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });

  it("returns null for malformed or invalid contents", () => {
    expect(parseT3ProjectFile("{ not json")).toBeNull();
    expect(parseT3ProjectFile('{ "defaultThreadEnvMode": "spaceship" }')).toBeNull();
  });
});

describe("setT3ProjectFileCopyRules", () => {
  it("replaces copy rules and keeps every other key", () => {
    const next = setT3ProjectFileCopyRules(
      `{
        // team scripts
        "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
        "workspace": { "copy": [{ "from": ".env" }] },
      }`,
      [{ from: ".env.local", required: true }],
    );

    expect(parseT3ProjectFile(next ?? "")).toEqual({
      scripts: [{ name: "Dev", command: "pnpm dev" }],
      workspace: { copy: [{ from: ".env.local", required: true }] },
    });
  });

  it("creates a file when none exists and drops an emptied workspace", () => {
    const created = setT3ProjectFileCopyRules(null, [{ from: ".env" }]);
    expect(parseT3ProjectFile(created ?? "")?.workspace).toEqual({ copy: [{ from: ".env" }] });
    expect(parseT3ProjectFile(created ?? "")?.$schema).toBe("https://t3.codes/schema/t3.json");

    const emptied = setT3ProjectFileCopyRules(created, []);
    expect(parseT3ProjectFile(emptied ?? "")).toEqual({
      $schema: "https://t3.codes/schema/t3.json",
    });
  });

  it("refuses to overwrite a file that does not parse", () => {
    expect(setT3ProjectFileCopyRules("{ not json", [{ from: ".env" }])).toBeNull();
    expect(setT3ProjectFileCopyRules("[]", [{ from: ".env" }])).toBeNull();
    expect(
      setT3ProjectFileCopyRules('{ "defaultThreadEnvMode": "spaceship" }', [{ from: ".env" }]),
    ).toBeNull();
  });
});
