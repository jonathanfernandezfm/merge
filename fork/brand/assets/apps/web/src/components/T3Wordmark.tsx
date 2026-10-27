import type { ImgHTMLAttributes } from "react";

import mergeLogoUrl from "../assets/merge-logo.webp";
import { cn } from "../lib/utils";

/** The Merge brand mark. Size it with a height class; width follows the logo's aspect ratio. */
export function T3Wordmark(props: ImgHTMLAttributes<HTMLImageElement>) {
  const { alt, className, ...rest } = props;
  return (
    <img
      alt={alt ?? ""}
      draggable={false}
      {...rest}
      className={cn("object-contain", className)}
      src={mergeLogoUrl}
      width={256}
      height={197}
    />
  );
}
