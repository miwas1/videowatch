import { describe, expect, it } from "vitest";
import { commandFromKeyboardEvent } from "./shortcuts";

describe("keyboard accessibility shortcuts", () => {
  it("maps required keyboard shortcuts to product commands", () => {
    expect(commandFromKeyboardEvent({ altKey: true, shiftKey: true, key: "A", repeat: false })).toBe("toggle_ad");
    expect(commandFromKeyboardEvent({ altKey: true, shiftKey: true, key: "D", repeat: false })).toBe("describe_now");
    expect(commandFromKeyboardEvent({ altKey: true, shiftKey: true, key: "T", repeat: false })).toBe("read_screen_text");
    expect(commandFromKeyboardEvent({ altKey: true, shiftKey: true, key: "S", repeat: false })).toBe("summarize_so_far");
  });

  it("ignores repeated or non-modified key presses so focus is not trapped", () => {
    expect(commandFromKeyboardEvent({ altKey: true, shiftKey: true, key: "D", repeat: true })).toBeNull();
    expect(commandFromKeyboardEvent({ altKey: false, shiftKey: true, key: "D", repeat: false })).toBeNull();
  });
});
