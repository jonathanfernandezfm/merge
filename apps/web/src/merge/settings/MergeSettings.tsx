import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { Switch } from "~/components/ui/switch";
import { useWorkTasksInSidebar } from "../workTasks/settings";

export function MergeSettings() {
  const [workTasksInSidebar, setWorkTasksInSidebar] = useWorkTasksInSidebar();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Work Tasks">
        <SettingsRow
          title="Work Tasks in sidebar"
          description="Show the Work Tasks section in the sidebar. The Work Taskboard stays available from the command palette. Applies to this browser."
          control={
            <Switch
              aria-label="Work Tasks in sidebar"
              checked={workTasksInSidebar}
              onCheckedChange={(checked) => setWorkTasksInSidebar(checked)}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
