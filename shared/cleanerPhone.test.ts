import { describe, expect, it } from "vitest";
import { normalizeCleanerPhone, pickCleanerPhone } from "./cleaner-phone";

describe("cleaner phone", () => {
  it("normalizza spazi e scarta vuoti", () => {
    expect(normalizeCleanerPhone("  327  871  1092 ")).toBe("327 871 1092");
    expect(normalizeCleanerPhone("")).toBeNull();
    expect(normalizeCleanerPhone(null)).toBeNull();
  });

  it("preferisce il mobile al telefono fisso", () => {
    expect(pickCleanerPhone({ mobile: "3281112222", phone: "021234567" })).toBe("3281112222");
    expect(pickCleanerPhone({ mobile: " ", phone: "3511784825" })).toBe("3511784825");
    expect(pickCleanerPhone({ mobile: null, phone: null })).toBeNull();
  });
});
