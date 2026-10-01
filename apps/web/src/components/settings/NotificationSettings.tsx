import type { NotificationSound } from "@t3tools/contracts/settings";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  NOTIFICATION_SOUNDS,
  NOTIFICATION_VOLUMES,
  previewNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const completionSound = useScopedSettings((settings) => settings.completionSound);
  const attentionSound = useScopedSettings((settings) => settings.attentionSound);
  const volume = useScopedSettings((settings) => settings.notificationVolume);
  const updateSettings = useUpdateScopedSettings();

  return (
    <>
      <NotificationModeSetting />
      {hasNotificationSound(mode) ? (
        <>
          <SettingsRow
            {...searchableSetting("completion-sound")}
            description="Played when a thread finishes."
            control={
              <NotificationSoundMenu
                label="Completion sound"
                value={completionSound}
                defaultSound="classic"
                volume={volume}
                onChange={(sound) => updateSettings({ completionSound: sound })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("attention-sound")}
            description="Played when a thread fails or needs input or approval."
            control={
              <NotificationSoundMenu
                label="Attention sound"
                value={attentionSound}
                defaultSound="alert"
                volume={volume}
                onChange={(sound) => updateSettings({ attentionSound: sound })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("notification-volume")}
            description="Volume for notification sounds on this device."
            control={
              <Select
                value={String(volume)}
                onValueChange={(value) => {
                  const next = Number(value);
                  if (NOTIFICATION_VOLUMES.some((option) => option === next)) {
                    updateSettings({ notificationVolume: next });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-28" aria-label="Sound volume">
                  <SelectValue>{`${volume}%`}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {NOTIFICATION_VOLUMES.map((option) => (
                    <SelectItem key={option} hideIndicator value={String(option)}>
                      {`${option}%`}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : null}
    </>
  );
}

const soundOptionRowClassName = "grid grid-cols-[1fr_auto]";

function NotificationSoundMenu({
  label,
  value,
  defaultSound,
  volume,
  onChange,
}: {
  label: string;
  value: NotificationSound;
  defaultSound: NotificationSound;
  volume: number;
  onChange: (sound: NotificationSound) => void;
}) {
  const soundLabel = (sound: NotificationSound) =>
    sound === "off" ? "Off" : NOTIFICATION_SOUNDS[sound].label;
  const optionLabel = (sound: NotificationSound) => (
    <>
      {soundLabel(sound)}
      {sound === defaultSound ? <span className="text-muted-foreground"> (Default)</span> : null}
    </>
  );

  return (
    <Menu>
      <MenuTrigger
        aria-label={`${label}: ${soundLabel(value)}`}
        render={<SelectButton size="sm" />}
        className="w-auto min-w-0"
      >
        {optionLabel(value)}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next === "off" || Object.hasOwn(NOTIFICATION_SOUNDS, next)) {
              onChange(next as NotificationSound);
            }
          }}
        >
          <MenuRadioItem closeOnClick value="off">
            Off
          </MenuRadioItem>
          {Object.keys(NOTIFICATION_SOUNDS).map((key) => {
            const sound = key as keyof typeof NOTIFICATION_SOUNDS;
            return (
              <div key={sound} className={soundOptionRowClassName}>
                <MenuRadioItem closeOnClick value={sound}>
                  {optionLabel(sound)}
                </MenuRadioItem>
                <MenuItem
                  aria-label={`Play ${NOTIFICATION_SOUNDS[sound].label}`}
                  closeOnClick={false}
                  onClick={() => void previewNotificationSound(sound, volume)}
                >
                  <PlayIcon />
                </MenuItem>
              </div>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function NotificationModeSetting() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={
        permissionMessage ??
        "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while Merge is open."
      }
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(
                  "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                );
                return;
              }
              setRequesting(true);
              try {
                const permission = await Notification.requestPermission();
                if (permission !== "granted") {
                  setPermissionMessage(
                    "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                  );
                  return;
                }
              } catch {
                setPermissionMessage(
                  "Notifications are unavailable in this browser. Sound only is still available.",
                );
                return;
              } finally {
                setRequesting(false);
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
            <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
