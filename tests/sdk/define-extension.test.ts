import { describe, it, expect } from "vitest";
import { defineExtension } from "../../src/sdk/index.js";
import type { DollyExtension } from "../../src/sdk/types.js";

describe("defineExtension", () => {
  it("should return the same spec object (identity function)", () => {
    const spec: DollyExtension = {
      name: "test-ext",
      version: "1.0.0",
      description: "A test extension",
      createModule({ id }) {
        return {
          id,
          execute: async () => null,
          getInputPremise: () => "input",
          getOutputPremise: () => "output",
          init: async () => {},
          onStop: async () => {},
        };
      },
    };

    const result = defineExtension(spec);
    expect(result).toBe(spec); // same reference
  });

  it("should preserve all spec fields", () => {
    const spec: DollyExtension = {
      name: "full-ext",
      version: "2.0.0",
      description: "Full extension with CLI",
      createModule({ id }) {
        return {
          id,
          execute: async () => null,
          getInputPremise: () => "",
          getOutputPremise: () => "",
          init: async () => {},
          onStop: async () => {},
        };
      },
      cliCommands: [
        {
          name: "greet",
          description: "Say hello",
          handler: async () => {},
        },
      ],
    };

    const result = defineExtension(spec);
    expect(result.name).toBe("full-ext");
    expect(result.version).toBe("2.0.0");
    expect(result.description).toBe("Full extension with CLI");
    expect(result.cliCommands).toHaveLength(1);
    expect(result.cliCommands![0].name).toBe("greet");
  });

  it("should maintain type safety for createModule", () => {
    const spec = defineExtension({
      name: "typed",
      version: "1.0.0",
      description: "Type safe",
      createModule({ id, config }) {
        return {
          id,
          execute: async () => null,
          getInputPremise: () => "",
          getOutputPremise: () => "",
          init: async () => {},
          onStop: async () => {},
        };
      },
    });

    // Should be able to call createModule with correct params
    const mod = spec.createModule({ id: "test", config: { key: "value" } });
    expect(mod.id).toBe("test");
  });
});
