import assert from "node:assert/strict";
import test from "node:test";
import { selectModel, type ListedModel } from "./model-selection.ts";

const models: ListedModel[] = [
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    variants: [
      {
        displayName: "Grok 4.7  Extra High",
        params: [
          { id: "context", value: "256k" },
          { id: "reasoning_effort", value: "xhigh" },
          { id: "fast", value: "false" },
        ],
      },
      {
        displayName: "Grok 4.7  High Fast",
        params: [
          { id: "context", value: "500k" },
          { id: "reasoning_effort", value: "high" },
          { id: "fast", value: "true" },
        ],
        isDefault: true,
      },
      {
        displayName: "Grok 4.7  Extra High",
        params: [
          { id: "context", value: "500k" },
          { id: "reasoning_effort", value: "xhigh" },
          { id: "fast", value: "false" },
        ],
      },
    ],
  },
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer"],
    variants: [
      { displayName: "Composer 2.5", params: [{ id: "fast", value: "true" }], isDefault: true },
      { displayName: "Composer 2.5", params: [{ id: "fast", value: "false" }] },
    ],
  },
];

test("display name Grok 4.7 Extra High maps to grok-4.7 with extra-high params", () => {
  const selected = selectModel(models, "Grok 4.7 Extra High");
  assert.equal(selected.id, "grok-4.7");
  assert.deepEqual(selected.params, [
    { id: "context", value: "500k" },
    { id: "reasoning_effort", value: "xhigh" },
    { id: "fast", value: "false" },
  ]);
});

test("model id uses the default variant", () => {
  const selected = selectModel(models, "grok-4.7");
  assert.equal(selected.id, "grok-4.7");
  assert.equal(selected.params?.find((param) => param.id === "reasoning_effort")?.value, "high");
});

test("disambiguated label selects the 256k extra-high variant", () => {
  const selected = selectModel(models, "Grok 4.7 Extra High · 256k xhigh");
  assert.equal(selected.params?.find((param) => param.id === "context")?.value, "256k");
});

test("unknown model is rejected", () => {
  assert.throws(() => selectModel(models, "not-a-model"), /不可用/);
});
