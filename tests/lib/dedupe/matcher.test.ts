import { describe, expect, it } from "vitest";

import {
  candidatePairs,
  nameKeyOf,
  planQueueUpdate,
  scorePair,
  type MatchableContact,
} from "@/lib/dedupe/matcher";
import { normalizeEmail } from "@/lib/contacts/normalize";

let nextId = 1;
function contact(over: Partial<MatchableContact>): MatchableContact {
  return {
    id: nextId++,
    firstName: null,
    lastName: null,
    displayName: "",
    company: null,
    emailsNormalized: [],
    phonesE164: [],
    groupIds: [],
    ...over,
  };
}

function named(
  first: string,
  last: string,
  over: Partial<MatchableContact> = {}
): MatchableContact {
  return contact({
    firstName: first,
    lastName: last,
    displayName: `${first} ${last}`,
    ...over,
  });
}

describe("scorePair — SPEC §10 acceptance battery", () => {
  it("Bob Smith vs Robert Smith clears the threshold on nickname equivalence", () => {
    const pair = scorePair(named("Bob", "Smith"), named("Robert", "Smith"));
    expect(pair).not.toBeNull();
    expect(pair!.score).toBeGreaterThanOrEqual(0.85);
    expect(pair!.reasons.some((r) => r.startsWith("jw:"))).toBe(true);
  });

  it("Bob Smith vs Bob Smythe sits in the corroboration band: suggested only with same company", () => {
    const alone = scorePair(named("Bob", "Smith"), named("Bob", "Smythe"));
    expect(alone).toBeNull();

    const together = scorePair(
      named("Bob", "Smith", { company: "Acme Corp" }),
      named("Bob", "Smythe", { company: "Acme Corp" })
    );
    expect(together).not.toBeNull();
    expect(together!.score).toBeCloseTo(0.85, 5);
    expect(together!.reasons).toContain("same_company");
  });

  it("Jon Doe vs Don Joe is below threshold, with or without corroboration", () => {
    expect(scorePair(named("Jon", "Doe"), named("Don", "Joe"))).toBeNull();
    expect(
      scorePair(
        named("Jon", "Doe", { company: "Acme" }),
        named("Don", "Joe", { company: "Acme" })
      )
    ).toBeNull();
  });

  it("gmail-normalized emails match at 1.0: j.smith+news@gmail.com ≡ jsmith@gmail.com", () => {
    const a = named("J", "Smith", {
      emailsNormalized: [normalizeEmail("j.smith+news@gmail.com")],
    });
    const b = named("Jay", "Smithson", {
      emailsNormalized: [normalizeEmail("jsmith@gmail.com")],
    });
    const pair = scorePair(a, b);
    expect(pair).not.toBeNull();
    expect(pair!.score).toBe(1.0);
    expect(pair!.reasons).toContain("email_match");
  });

  it("E.164 phone match scores 0.95", () => {
    const pair = scorePair(
      named("Ana", "Silva", { phonesE164: ["+447700900123"] }),
      named("Anna", "Da Silva", { phonesE164: ["+447700900123"] })
    );
    expect(pair).not.toBeNull();
    expect(pair!.score).toBeGreaterThanOrEqual(0.95);
    expect(pair!.reasons).toContain("phone_match");
  });

  it("a shared freemail domain does NOT corroborate; a shared org domain does", () => {
    const viaGmail = scorePair(
      named("Bob", "Smith", { emailsNormalized: ["bob@gmail.com"] }),
      named("Bob", "Smythe", { emailsNormalized: ["bobs@gmail.com"] })
    );
    expect(viaGmail).toBeNull();

    const viaOrg = scorePair(
      named("Bob", "Smith", { emailsNormalized: ["bob@acme.dev"] }),
      named("Bob", "Smythe", { emailsNormalized: ["b.smythe@acme.dev"] })
    );
    expect(viaOrg).not.toBeNull();
    expect(viaOrg!.reasons).toContain("same_email_domain");
  });

  it("a shared group corroborates the 0.90–0.95 band", () => {
    const pair = scorePair(
      named("Bob", "Smith", { groupIds: [7] }),
      named("Bob", "Smythe", { groupIds: [7, 9] })
    );
    expect(pair).not.toBeNull();
    expect(pair!.reasons).toContain("shared_group");
  });

  it("katee-style nickname first tokens compare as equal (Katherine ≡ Kate)", () => {
    const pair = scorePair(
      named("Katherine", "Johnson"),
      named("Kate", "Johnson")
    );
    expect(pair).not.toBeNull();
    expect(pair!.score).toBeGreaterThanOrEqual(0.85);
  });

  it("middle tokens are dropped before comparing", () => {
    expect(
      nameKeyOf({
        firstName: "Ana",
        lastName: "Maria Silva",
        displayName: "Ana Maria Silva",
      })
    ).toEqual({ first: "ana", last: "silva", full: "ana silva" });
  });

  it("emits canonical a<b ids", () => {
    const a = named("Bob", "Smith");
    const b = named("Robert", "Smith");
    const pair = scorePair(b, a)!;
    expect(pair.aId).toBeLessThan(pair.bId);
  });
});

describe("candidatePairs — blocking scan", () => {
  it("finds nickname pairs, email pairs, and phone pairs across a contact set", () => {
    const list = [
      named("Bob", "Smith"),
      named("Robert", "Smith"),
      named("Zoe", "Chen", { emailsNormalized: ["zoe@corp.io"] }),
      named("Zoey", "Chen-Adams", { emailsNormalized: ["zoe@corp.io"] }),
      named("Uma", "Patel", { phonesE164: ["+14155550001"] }),
      named("U", "P", { phonesE164: ["+14155550001"] }),
      named("Totally", "Unrelated"),
    ];
    const pairs = candidatePairs(list);
    const keys = pairs.map((p) => `${p.aId}:${p.bId}`);
    expect(keys).toContain(`${list[0].id}:${list[1].id}`);
    expect(keys).toContain(`${list[2].id}:${list[3].id}`);
    expect(keys).toContain(`${list[4].id}:${list[5].id}`);
    expect(pairs.every((p) => p.score >= 0.85)).toBe(true);
    expect(keys.some((k) => k.includes(`${list[6].id}`))).toBe(false);
  });

  it("reports each pair once even when it shares several buckets", () => {
    const a = named("Bob", "Smith", { emailsNormalized: ["b@x.io"] });
    const b = named("Robert", "Smith", { emailsNormalized: ["b@x.io"] });
    const pairs = candidatePairs([a, b]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons).toContain("email_match");
  });
});

describe("planQueueUpdate — dismissal memory", () => {
  const pair = (aId: number, bId: number): ReturnType<typeof scorePair> & object => ({
    aId,
    bId,
    score: 0.9,
    reasons: ["jw:0.96"],
  });

  it("a dismissed pair never re-enters the queue", () => {
    const plan = planQueueUpdate(
      [{ aId: 1, bId: 2, status: "dismissed" }],
      [pair(1, 2)]
    );
    expect(plan.insert).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
  });

  it("a merged pair is not re-suggested either", () => {
    const plan = planQueueUpdate(
      [{ aId: 1, bId: 2, status: "merged" }],
      [pair(1, 2)]
    );
    expect(plan.insert).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
  });

  it("new pairs insert, re-found open pairs update, stale open pairs drop", () => {
    const plan = planQueueUpdate(
      [
        { aId: 1, bId: 2, status: "open" },
        { aId: 3, bId: 4, status: "open" },
      ],
      [pair(1, 2), pair(5, 6)]
    );
    expect(plan.update.map((p) => [p.aId, p.bId])).toEqual([[1, 2]]);
    expect(plan.insert.map((p) => [p.aId, p.bId])).toEqual([[5, 6]]);
    expect(plan.remove).toEqual([{ aId: 3, bId: 4 }]);
  });
});
