import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_WEIGHTS,
  CONDITION_ORDER,
  evaluateTreatmentQuestion,
  tokenize,
  type LongMemEvalTreatmentInput,
} from "../../../scripts/experiments/probes/memory-longmemeval-retrieval-v0/treatment.mjs";

function fixture(): LongMemEvalTreatmentInput {
  const sessionIds = Array.from({ length: 12 }, (_, index) => `session-${String(index).padStart(2, "0")}`);
  const sessions = sessionIds.map((_, index) => index < 2
    ? [
        { role: "user", content: `alpha anchor ${index}` },
        { role: "assistant", content: `beta bridge ${index}` },
        { role: "user", content: `gamma target ${index}` },
      ]
    : [
        { role: "user", content: `gamma candidate ${index}` },
        { role: "assistant", content: `unrelated value ${index}` },
      ]);
  return {
    question_id: "question-a",
    question: "Where is alpha connected?",
    sessions: sessionIds.map((sessionId, index) => ({
      session_id: sessionId,
      messages: sessions[index]!,
    })),
  };
}

describe("LongMemEval-S gold-blind retrieval treatment", () => {
  it("freezes the version-2 protocol and rejects decision-changing preregistration mutations", () => {
    const protocol = readFileSync(
      "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-protocol.md",
    );
    const preregistration = JSON.parse(readFileSync(
      "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0.json",
      "utf8",
    )) as Record<string, unknown>;
    const schema = JSON.parse(readFileSync(
      "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-schema.json",
      "utf8",
    )) as Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(preregistration), validate.errors?.map((error) => error.message).join("; ")).toBe(true);
    expect(createHash("sha256").update(protocol).digest("hex")).toBe(
      "b3f24eeaaf11e247f8908d3b483debf3be21c6b5672d25f52f9d79fd3a6f515e",
    );

    const mutate = (mutation: (copy: any) => void) => {
      const copy = structuredClone(preregistration);
      mutation(copy);
      return validate(copy);
    };
    expect(mutate((copy) => { copy.conditions.treatments[0].frozenParameters.weightGrid[0] = 0.2; })).toBe(false);
    expect(mutate((copy) => { copy.execution.casePlan[1].maximumCount = 1400; })).toBe(false);
    expect(mutate((copy) => { copy.decisionRules.supported[1] = "always pass"; })).toBe(false);
    expect(mutate((copy) => { copy.domainDesign.treatmentProjectionFields.push("answer"); })).toBe(false);
    expect(mutate((copy) => { copy.safetyBoundary.moduleLaunchAllowed = true; })).toBe(false);
  });

  it("keeps the frozen condition and weight matrix and distinguishes position from no-position", () => {
    const result = evaluateTreatmentQuestion(fixture());

    expect(result.conditions.map((condition) => condition.conditionId)).toEqual(CONDITION_ORDER);
    expect(result.conditions[0]?.variants.map((variant) => variant.weight)).toEqual([0]);
    for (const condition of result.conditions.slice(1)) {
      expect(condition.variants.map((variant) => variant.weight)).toEqual(ASSOCIATION_WEIGHTS);
      expect(condition.cost.edgeCount).toBeGreaterThan(0);
      expect(condition.cost.edgeBytes).toBeGreaterThan(0);
      expect(condition.cost.rawSessionBytes).toBeGreaterThan(0);
    }

    const noPosition = result.conditions.find(
      (condition) => condition.conditionId === "recurrence-no-position",
    )!;
    const adjacent = result.conditions.find(
      (condition) => condition.conditionId === "repeated-adjacent-position",
    )!;
    const noPositionCandidate = noPosition.variants[0]!.ranking.find(
      (row) => row.sessionId === "session-02",
    );
    const adjacentCandidate = adjacent.variants[0]!.ranking.find(
      (row) => row.sessionId === "session-02",
    );
    expect(noPositionCandidate?.associationScore).toBe(1);
    expect(adjacentCandidate?.associationScore).toBe(0);
  });

  it("accepts only the closed gold-blind input projection", () => {
    const input = fixture();
    expect(() => evaluateTreatmentQuestion({
      ...input,
      answer_session_ids: ["session-02"],
    } as unknown as LongMemEvalTreatmentInput)).toThrow(/gold-blind treatment contract/u);
    expect(() => evaluateTreatmentQuestion({
      ...input,
      sessions: input.sessions.map((session, index) => index === 0
        ? {
            ...session,
            messages: session.messages.map((message, messageIndex) => messageIndex === 0
              ? { ...message, has_answer: true }
              : message),
          }
        : session),
    } as unknown as LongMemEvalTreatmentInput)).toThrow(/gold-blind treatment contract/u);
  });

  it("keeps empty sessions and empty content as valid zero-length evidence", () => {
    const input = fixture();
    const emptyInput: LongMemEvalTreatmentInput = {
      ...input,
      sessions: input.sessions.map((session, index) => ({
        ...session,
        messages: index === 0
          ? []
          : index === 1
            ? [{ role: "user", content: "" }]
            : session.messages,
      })),
    };
    const result = evaluateTreatmentQuestion(emptyInput);
    expect(result.conditions[0]?.variants[0]?.ranking).toHaveLength(10);
  });

  it("uses NFKC lowercase Unicode tokens, minimum length two, and the frozen stop list", () => {
    expect(tokenize("What ＤＥＧＲＥＥ did I get in ２０２４? A x")).toEqual([
      "degree",
      "did",
      "get",
      "2024",
    ]);
  });

  it("uses only a frozen selected weight during evaluation", () => {
    const result = evaluateTreatmentQuestion(fixture(), {
      "recurrence-no-position": 0.5,
      "repeated-adjacent-position": 1,
      "shuffled-position": 2,
    });
    expect(result.conditions.slice(1).map((condition) =>
      condition.variants.map((variant) => variant.weight)
    )).toEqual([[0.5], [1], [2]]);
    expect(() => evaluateTreatmentQuestion(fixture(), {
      "recurrence-no-position": 0.5,
      "repeated-adjacent-position": 3,
      "shuffled-position": 2,
    })).toThrow(/outside the frozen grid/u);
  });
});
