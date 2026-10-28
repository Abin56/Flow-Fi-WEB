import { describe, expect, it } from "vitest";

import { addablePeople, repeatedParticipantError } from "./split-participant-identity";

const people = [
  { id: "p-ravi", name: "Ravi" },
  { id: "p-anu", name: "Anu" },
];
const me = { personId: null, name: "Me", isMe: true };
const ravi = { personId: "p-ravi", name: "Ravi", isMe: false };

describe("repeatedParticipantError (H1: one person, one row)", () => {
  it("a typed name that is a picked person is refused — any case, any surrounding spaces", () => {
    for (const typed of ["Ravi", "ravi", "  RAVI "]) {
      expect(repeatedParticipantError([me, ravi, { personId: null, name: typed, isMe: false }], people)).toMatch(/is already in this split/);
    }
  });

  it("matches the person's People name even when the picked row was renamed", () => {
    const renamed = { personId: "p-ravi", name: "Ravi K", isMe: false };
    expect(repeatedParticipantError([me, renamed, { personId: null, name: "ravi", isMe: false }], people)).toMatch(/ravi is already/);
    expect(repeatedParticipantError([me, renamed, { personId: null, name: "ravi k", isMe: false }], people)).toMatch(/already/);
  });

  it("valid splits are untouched: distinct picked people, a new typed name, an unpicked existing name, a blank new row", () => {
    const anu = { personId: "p-anu", name: "Anu", isMe: false };
    expect(repeatedParticipantError([me, ravi, anu], people)).toBeNull();
    expect(repeatedParticipantError([me, ravi, { personId: null, name: "Sam", isMe: false }], people)).toBeNull();
    expect(repeatedParticipantError([me, { personId: null, name: "Anu", isMe: false }], people)).toBeNull(); // links to Anu at commit, once
    expect(repeatedParticipantError([me, ravi, { personId: null, name: "", isMe: false }], people)).toBeNull();
    expect(repeatedParticipantError([me, { personId: null, name: "Me", isMe: false }], [])).toBeNull();
  });
});

describe("addablePeople", () => {
  it("hides people already picked AND people already typed as a custom name", () => {
    expect(addablePeople(people, [me, ravi]).map((p) => p.id)).toEqual(["p-anu"]);
    expect(addablePeople(people, [me, { personId: null, name: " anu ", isMe: false }]).map((p) => p.id)).toEqual(["p-ravi"]);
    expect(addablePeople(people, [me]).map((p) => p.id)).toEqual(["p-ravi", "p-anu"]);
  });
});
