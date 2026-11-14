import { describe, expect, it } from "vitest";
import { peopleNames } from "./people-payment-decision";

describe("peopleNames — names read naturally", () => {
  it("one, two, or several", () => {
    expect(peopleNames(["Sanju"])).toBe("Sanju");
    expect(peopleNames(["Sanju", "AMMA"])).toBe("Sanju and AMMA");
    expect(peopleNames(["Sanju", "AMMA", "Ravi"])).toBe("Sanju and 2 others");
  });
});
