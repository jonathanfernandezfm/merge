import { createFileRoute } from "@tanstack/react-router";

import { MergeSettings } from "../merge/settings/MergeSettings";

export const Route = createFileRoute("/_chat/settings/merge")({
  component: MergeSettings,
});
