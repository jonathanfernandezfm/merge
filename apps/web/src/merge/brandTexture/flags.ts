/** Release and Dev builds show the Merge texture where Nightly shows its sky. */
export const MERGE_TEXTURE_ENABLED = true;

/** The send button keeps the message-action accent; it never paints the sidebar stage art. */
export const SEND_BUTTON_STAGE_ART_ENABLED = false;

/** Disabled (e.g. empty composer) the send button stays the accent, dimmed, instead of upstream's gray. */
export const MERGE_SEND_BUTTON_CLASS =
  "disabled:bg-message-action disabled:text-message-action-foreground disabled:opacity-64";
