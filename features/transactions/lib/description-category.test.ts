import { describe, expect, it } from "vitest";
import { DESCRIPTION_OR_CATEGORY_MESSAGE, resolveDescriptionAndCategory } from "./description-category";

const categories = [{ id: "c-food", name: "Food" }];

describe("resolveDescriptionAndCategory", () => {
  it("Case A — description only saves uncategorized", () => {
    expect(resolveDescriptionAndCategory({ description: " Grocery shopping ", categoryId: "", categories })).toEqual({ ok: true, description: "Grocery shopping", categoryId: "" });
  });
  it("Case B — category only uses the category name as description", () => {
    expect(resolveDescriptionAndCategory({ description: "  ", categoryId: "c-food", categories })).toEqual({ ok: true, description: "Food", categoryId: "c-food" });
  });
  it("Case C — both are kept", () => {
    expect(resolveDescriptionAndCategory({ description: "Dinner at restaurant", categoryId: "c-food", categories })).toEqual({ ok: true, description: "Dinner at restaurant", categoryId: "c-food" });
  });
  it("Case D — neither is refused", () => {
    expect(resolveDescriptionAndCategory({ description: "", categoryId: "", categories })).toEqual({ ok: false, message: DESCRIPTION_OR_CATEGORY_MESSAGE });
  });
  it("a deleted category counts as no category", () => {
    expect(resolveDescriptionAndCategory({ description: "", categoryId: "gone", categories }).ok).toBe(false);
    expect(resolveDescriptionAndCategory({ description: "Tea", categoryId: "gone", categories })).toEqual({ ok: true, description: "Tea", categoryId: "" });
  });
});
