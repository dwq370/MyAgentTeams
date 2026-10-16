export interface ModelParam {
  id: string;
  value: string;
}

export interface ModelVariantChoice {
  displayName: string;
  params: ModelParam[];
  isDefault?: boolean;
}

export interface ListedModel {
  id: string;
  displayName: string;
  aliases?: string[];
  variants?: ModelVariantChoice[];
}

export interface ModelSelection {
  id: string;
  params?: ModelParam[];
}

export function modelChoices(models: ListedModel[]): string[] {
  const labels: string[] = [];
  for (const model of models) {
    if (!model.variants?.length) {
      labels.push(model.displayName || model.id);
      continue;
    }
    for (const variant of model.variants) labels.push(variantLabel(model, variant));
  }
  return [...new Set(labels)];
}

export function selectModel(models: ListedModel[], requested: string): ModelSelection {
  const raw = requested.trim();
  if (!raw) throw new Error("未选择模型");
  const needle = normalize(raw);
  const byIdentity = models.find(
    (model) =>
      normalize(model.id) === needle ||
      normalize(model.displayName) === needle ||
      (model.aliases ?? []).some((alias) => normalize(alias) === needle),
  );
  if (byIdentity) return withDefaultVariant(byIdentity);

  const hits: { model: ListedModel; variant: ModelVariantChoice }[] = [];
  for (const model of models) {
    for (const variant of model.variants ?? []) {
      const base = normalize(variant.displayName);
      const label = normalize(variantLabel(model, variant));
      if (base === needle || label === needle) hits.push({ model, variant });
    }
  }
  if (hits.length === 0) throw new Error(`模型「${raw}」不可用，请在 Agent 引擎里重新选择`);
  const chosen = pickVariant(hits);
  return { id: chosen.model.id, params: chosen.variant.params };
}

function withDefaultVariant(model: ListedModel): ModelSelection {
  const variant = model.variants?.find((item) => item.isDefault) ?? model.variants?.[0];
  if (!variant) return { id: model.id };
  return { id: model.id, params: variant.params };
}

function pickVariant(hits: { model: ListedModel; variant: ModelVariantChoice }[]) {
  if (hits.length === 1) return hits[0];
  const marked = hits.find((hit) => hit.variant.isDefault);
  if (marked) return marked;
  const fallback = hits[0].model.variants?.find((item) => item.isDefault);
  const context = fallback?.params.find((param) => param.id === "context")?.value;
  if (context) {
    const sameContext = hits.find((hit) => hit.variant.params.some((param) => param.id === "context" && param.value === context));
    if (sameContext) return sameContext;
  }
  return hits[0];
}

function variantLabel(model: ListedModel, variant: ModelVariantChoice) {
  const base = variant.displayName.replace(/\s+/g, " ").trim();
  const siblings = (model.variants ?? []).filter((item) => item.displayName.replace(/\s+/g, " ").trim().toLowerCase() === base.toLowerCase());
  if (siblings.length < 2) return base;
  const context = variant.params.find((param) => param.id === "context")?.value;
  const effort = variant.params.find((param) => param.id === "reasoning_effort" || param.id === "effort")?.value;
  const fast = variant.params.find((param) => param.id === "fast")?.value === "true" ? "Fast" : "";
  const detail = [context, effort, fast].filter(Boolean).join(" ");
  return detail ? `${base} · ${detail}` : base;
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
