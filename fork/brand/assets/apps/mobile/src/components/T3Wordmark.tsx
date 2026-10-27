import { Image } from "expo-image";
import type { ColorValue } from "react-native";

const MERGE_LOGO_SOURCE = require("../../assets/merge-logo.webp");
const MERGE_LOGO_ASPECT_RATIO = 256 / 197;

/**
 * The Merge brand mark, matching the web sidebar's T3Wordmark image.
 * Width derives from the logo's aspect ratio. The logo is full color, so
 * `color` and `colorClassName` are accepted for API compatibility but ignored.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Image
      accessibilityLabel="Merge"
      accessibilityIgnoresInvertColors
      source={MERGE_LOGO_SOURCE}
      contentFit="contain"
      style={{ height: props.height, width: props.height * MERGE_LOGO_ASPECT_RATIO }}
    />
  );
}
