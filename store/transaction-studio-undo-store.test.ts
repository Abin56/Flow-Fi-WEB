import { beforeEach, describe, expect, it } from "vitest";
import { useTransactionStudioUndoStore } from "./transaction-studio-undo-store";

const DOC = "doc-1";

function edit(id: string, recordId = "rec-1") {
  return { id, description: id, entries: [{ recordId, before: { notes: "old" }, after: { notes: "new" } }] };
}

beforeEach(() => {
  useTransactionStudioUndoStore.setState({ stacks: {} });
});

describe("transaction-studio-undo-store", () => {
  it("popUndo returns null when the stack is empty", () => {
    expect(useTransactionStudioUndoStore.getState().popUndo(DOC)).toBeNull();
  });

  it("push then popUndo returns the pushed edit and moves it to the redo stack", () => {
    const { push, popUndo } = useTransactionStudioUndoStore.getState();
    push(DOC, edit("e1"));
    const popped = popUndo(DOC);
    expect(popped?.id).toBe("e1");
    expect(useTransactionStudioUndoStore.getState().stacks[DOC]?.undo).toHaveLength(0);
    expect(useTransactionStudioUndoStore.getState().stacks[DOC]?.redo).toHaveLength(1);
  });

  it("popRedo after popUndo restores the edit to the undo stack (redo undoes the undo)", () => {
    const { push, popUndo, popRedo } = useTransactionStudioUndoStore.getState();
    push(DOC, edit("e1"));
    popUndo(DOC);
    const redone = popRedo(DOC);
    expect(redone?.id).toBe("e1");
    expect(useTransactionStudioUndoStore.getState().stacks[DOC]?.undo).toHaveLength(1);
    expect(useTransactionStudioUndoStore.getState().stacks[DOC]?.redo).toHaveLength(0);
  });

  it("a new push clears the redo stack (a fresh edit invalidates undone history)", () => {
    const { push, popUndo } = useTransactionStudioUndoStore.getState();
    push(DOC, edit("e1"));
    push(DOC, edit("e2"));
    popUndo(DOC); // undoes e2, redo now has e2
    expect(useTransactionStudioUndoStore.getState().stacks[DOC]?.redo).toHaveLength(1);
    push(DOC, edit("e3"));
    expect(useTransactionStudioUndoStore.getState().stacks[DOC]?.redo).toHaveLength(0);
  });

  it("undo pops in LIFO order across multiple edits", () => {
    const { push, popUndo } = useTransactionStudioUndoStore.getState();
    push(DOC, edit("e1"));
    push(DOC, edit("e2"));
    expect(popUndo(DOC)?.id).toBe("e2");
    expect(popUndo(DOC)?.id).toBe("e1");
    expect(popUndo(DOC)).toBeNull();
  });

  it("keeps separate stacks per documentId", () => {
    const { push, popUndo } = useTransactionStudioUndoStore.getState();
    push("doc-a", edit("a1"));
    push("doc-b", edit("b1"));
    expect(popUndo("doc-a")?.id).toBe("a1");
    expect(useTransactionStudioUndoStore.getState().stacks["doc-b"]?.undo).toHaveLength(1);
  });

  it("clear empties both stacks for a document", () => {
    const { push, clear } = useTransactionStudioUndoStore.getState();
    push(DOC, edit("e1"));
    clear(DOC);
    const stack = useTransactionStudioUndoStore.getState().stacks[DOC];
    expect(stack?.undo).toHaveLength(0);
    expect(stack?.redo).toHaveLength(0);
  });
});
