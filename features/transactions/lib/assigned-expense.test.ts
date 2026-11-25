import { describe, expect, it } from "vitest";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import { assignedPerson } from "./assigned-expense";

const p = (name: string, share: number, isMe = false, personId: string | null = isMe ? null : `id-${name}`): ExpenseParticipant => ({ personId, name, share, installmentId: null, isMe, receivedStatus: isMe ? "notApplicable" : "yetToReceive" });
const expense = (participants: ExpenseParticipant[], splitType: Expense["splitType"] = "custom"): Expense => ({ participants, splitType, totalAmount: 300 }) as Expense;

describe("assignedPerson — paid for someone else vs a real split", () => {
  it("one person owing the whole amount, no Me share (Smart Capture 'Someone else') → For that person", () => {
    expect(assignedPerson(expense([p("ABIN", 299)]))).toEqual({ personId: "id-ABIN", name: "ABIN" });
  });
  it("a Me row with ₹0 beside the person is still 'paid for' them", () => {
    expect(assignedPerson(expense([p("Me", 0, true), p("ABIN", 299)]))?.name).toBe("ABIN");
  });
  it("a genuine split (my share above ₹0) is NOT paid-for", () => {
    expect(assignedPerson(expense([p("Me", 150, true), p("ABIN", 150)]))).toBeNull();
  });
  it("several others without me is not a single 'For' person", () => {
    expect(assignedPerson(expense([p("A", 100), p("B", 200)]))).toBeNull();
  });
  it("plain expenses and missing expenses are not assigned", () => {
    expect(assignedPerson(expense([], "none"))).toBeNull();
    expect(assignedPerson(null)).toBeNull();
  });
});
