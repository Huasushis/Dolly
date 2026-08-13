import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { readAndAdaptDataset, createSplit } from
  "../../../scripts/experiments/probes/memory-longmemeval-retrieval-v0/common.mjs";
import { recomputeTreatmentForTest } from
  "../../../scripts/experiments/probes/memory-longmemeval-retrieval-v0/verify.mjs";
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
  it("freezes the version-3 protocol and rejects decision-changing preregistration mutations", () => {
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
      "2031b24421badb5da860461ff0dd718762aa91e7f3e7d661f473a025ef0f7930",
    );
    expect((preregistration as any).experimentVersion).toBe(3);
    expect(createHash("sha256").update(readFileSync(
      "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-artifacts.md",
    )).digest("hex")).toBe("3a60f3f69a7257243ec9b51306b97265d5f5a9628b2e8bffa12368c05ba9968f");

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

  it("recursively strips source gold fields, verifies duplicate sessions, and freezes the split", () => {
    const rows = readAndAdaptDataset(process.cwd());
    const split = createSplit(rows);
    expect(rows).toHaveLength(500);
    expect(split.development).toHaveLength(147);
    expect(split.evaluation).toHaveLength(353);
    for (const row of rows) {
      expect(Object.keys(row.input)).toEqual(["question_id", "question", "sessions"]);
      expect(new Set(row.input.sessions.map((session) => session.session_id)).size).toBe(
        row.input.sessions.length,
      );
      for (const session of row.input.sessions) {
        for (const message of session.messages) expect(Object.keys(message)).toEqual(["role", "content"]);
      }
    }
  });

  it("keeps the frozen condition and weight matrix and distinguishes position from no-position", () => {
    const result = evaluateTreatmentQuestion(fixture());

    expect(result.conditions.map((condition) => condition.conditionId)).toEqual(CONDITION_ORDER);
    expect(result.conditions[0]?.variants.map((variant) => variant.weight)).toEqual([0]);
    for (const condition of result.conditions.slice(1)) {
      expect(condition.variants.map((variant) => variant.weight)).toEqual(ASSOCIATION_WEIGHTS);
      expect(condition.cost.edgeCount).toBeGreaterThan(0);
      expect(condition.cost.edgeBytes).toBeGreaterThan(0);
      expect(condition.cost.corpusRawSessionBytes).toBeGreaterThan(0);
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

  it("keeps the exact binary64 BM25 evaluation order at a one-ULP ranking boundary", () => {
    const input: LongMemEvalTreatmentInput = {
      question_id: "q263",
      question: "𝟙𝟚 alpha beta the gamma",
      sessions: [
        { session_id: "s0𝟙", messages: [{ role: "user", content: "𝟙𝟚 beta café alpha i" }, { role: "assistant", content: "東京" }, { role: "USER", content: "東京 x beta i" }, { role: "assistant", content: "beta" }] },
        { session_id: "s1é", messages: [{ role: "USER", content: "𝟙𝟚 beta 東京 ＡＬＰＨＡ alpha café" }] },
        { session_id: "s2𝟙", messages: [{ role: "user", content: "i x gamma gamma gamma i" }, { role: "user", content: "𝟙𝟚 the i 𝟙𝟚" }] },
        { session_id: "s3é", messages: [{ role: "USER", content: "ＡＬＰＨＡ x ＡＬＰＨＡ i gamma beta" }, { role: "assistant", content: "東京" }] },
        { session_id: "s4é", messages: [] },
        { session_id: "s5", messages: [{ role: "USER", content: "gamma alpha" }, { role: "user", content: "" }, { role: "USER", content: "the alpha" }, { role: "assistant", content: "café the beta 東京 café alpha" }] },
      ],
    };
    const treatment = evaluateTreatmentQuestion(input).conditions[0]!.variants[0]!.ranking
      .map((row) => row.sessionId);
    const independent = (recomputeTreatmentForTest(input as unknown as Record<string, unknown>)[0] as any)
      .variants[0].ranking.map((row: { sessionId: string }) => row.sessionId);
    expect(treatment.slice(0, 3)).toEqual(["s2𝟙", "s3é", "s1é"]);
    expect(independent).toEqual(treatment);
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
    expect(() => evaluateTreatmentQuestion(fixture(), {
      "recurrence-no-position": 0.5,
      "repeated-adjacent-position": 1,
      "shuffled-position": 2,
      content: 0,
    } as never)).toThrow(/selected weights/u);
  });
});
