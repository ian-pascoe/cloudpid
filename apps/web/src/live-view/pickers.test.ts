import { describe, expect, it } from "vitest";
import { PickerWrites, pickerWriteScript } from "./pickers.ts";

describe("writing a local picker's value to the tab", () => {
  it("writes a value once, however many of input, change, blur and close report it", () => {
    const writes = new PickerWrites(4, { value: "2026-10-23" });

    expect(writes.next({ value: "2026-10-23" })).toBeUndefined();
    expect(writes.next({ value: "2026-11-01" })).toBe(
      pickerWriteScript(4, { value: "2026-11-01" }),
    );
    expect(writes.next({ value: "2026-11-01" })).toBeUndefined();
  });

  it("writes a select's chosen options by index", () => {
    const writes = new PickerWrites(2, { indexes: [0] });

    expect(writes.next({ indexes: [0] })).toBeUndefined();
    expect(writes.next({ indexes: [1, 3] })).toBe(pickerWriteScript(2, { indexes: [1, 3] }));
  });

  it("names the tab's element by its index in the registry, and the choice as JSON", () => {
    const script = pickerWriteScript(7, { value: '#ff0000"' });

    expect(script).toContain(`(7, {"value":"#ff0000\\""})`);
  });
});
