export type AccessibilityCommand = "toggle_ad" | "describe_now" | "read_screen_text" | "summarize_so_far";

export function commandFromKeyboardEvent(event: Pick<KeyboardEvent, "altKey" | "shiftKey" | "key" | "repeat">): AccessibilityCommand | null {
  if (!event.altKey || !event.shiftKey || event.repeat) return null;
  const key = event.key.toLowerCase();
  if (key === "a") return "toggle_ad";
  if (key === "d") return "describe_now";
  if (key === "t") return "read_screen_text";
  if (key === "s") return "summarize_so_far";
  return null;
}
