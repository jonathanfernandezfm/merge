import type { ClientSettings, NotificationSound } from "@t3tools/contracts/settings";

import clickUrl from "./assets/snap-shot-click.mp3";
import whooshUrl from "./assets/snap-shot-whoosh.mp3";
import classicUrl from "./assets/notification-completion.mp3";
import dingUrl from "./assets/notification-ding.mp3";
import alertUrl from "./assets/notification-input.mp3";
import riseUrl from "./assets/notification-rise.mp3";

type NotificationMode = ClientSettings["notificationMode"];

export const NOTIFICATION_SOUNDS = {
  classic: { label: "Classic", url: classicUrl },
  alert: { label: "Alert", url: alertUrl },
  ding: { label: "Ding", url: dingUrl },
  rise: { label: "Rise", url: riseUrl },
  whoosh: { label: "Whoosh", url: whooshUrl },
  click: { label: "Click", url: clickUrl },
} satisfies Record<Exclude<NotificationSound, "off">, { label: string; url: string }>;

export const NOTIFICATION_VOLUMES = [25, 50, 75, 100] as const;
export const NOTIFICATION_MODE_LABELS = {
  off: "Off",
  notifications: "Notifications only",
  sound: "Sound only",
  "notifications-and-sound": "Notifications with sound",
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  let image: string | null = null;
  if (count > 0 && (!bridge || bridge.getClientPlatform?.() === "win32")) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(32, 32, 28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 32, 34);
      image = canvas.toDataURL("image/png");
    }
  }
  if (!bridge) {
    if (image) {
      if (!badgeFavicon) {
        originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
        badgeFavicon = document.createElement("link");
        badgeFavicon.rel = "icon";
        badgeFavicon.type = "image/png";
        badgeFavicon.sizes.value = "64x64";
        originalFavicon?.remove();
        document.head.append(badgeFavicon);
      }
      badgeFavicon.href = image;
    } else if (badgeFavicon) {
      badgeFavicon.remove();
      badgeFavicon = undefined;
      if (originalFavicon) document.head.append(originalFavicon);
      originalFavicon = undefined;
    }
  }
  void bridge?.setNotificationBadge?.({ count, image }).catch(() => undefined);
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  audioContext ??= new AudioContext();
  void audioContext.resume().catch(() => undefined);
}

/** Plays a sound from a settings gesture, unlocking audio first. */
export async function previewNotificationSound(sound: NotificationSound, volume: number) {
  audioContext ??= new AudioContext();
  await audioContext.resume().catch(() => undefined);
  await playNotificationSound(sound, volume, () => true);
}

export async function playNotificationSound(
  sound: NotificationSound,
  volume: number,
  shouldPlay: () => boolean,
) {
  if (sound === "off" || volume <= 0) return;
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  const { url } = NOTIFICATION_SOUNDS[sound];
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    const decoded = await buffer;
    if (!shouldPlay() || context.state !== "running") return;
    const source = context.createBufferSource();
    source.buffer = decoded;
    const gain = context.createGain();
    gain.gain.value = Math.min(volume, 100) / 100;
    source.connect(gain).connect(context.destination);
    source.start();
  } catch {
    buffers.delete(url);
  }
}
