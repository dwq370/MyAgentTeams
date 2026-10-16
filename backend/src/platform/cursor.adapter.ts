import { Injectable } from "@nestjs/common";
import { DomainError } from "../domain/errors";
import { ListedModel, ModelSelection, modelChoices, selectModel } from "./model-selection";

type SdkRun = {
  id: string;
  supports: (operation: string) => boolean;
  cancel: () => Promise<void>;
  wait: () => Promise<{ status: string; result?: string; error?: { message?: string } }>;
};

type SdkAgent = {
  agentId: string;
  send: (prompt: string, options: unknown) => Promise<SdkRun>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

type SdkModule = {
  Cursor: { models: { list: (options: { apiKey: string }) => Promise<ListedModel[]> } };
  Agent: {
    create: (options: unknown) => Promise<SdkAgent>;
    resume: (agentId: string, options: unknown) => Promise<SdkAgent>;
  };
  CursorAgentError: new (...args: never[]) => Error;
};

export interface CloudRepo {
  url: string;
  startingRef: string;
}

export interface CursorRunOutcome {
  kind: "finished" | "run_error" | "startup_error" | "cancelled";
  runId?: string;
  message?: string;
  retryable?: boolean;
  helpUrl?: string;
  text?: string;
}

@Injectable()
export class CursorPlatformAdapter {
  async verifyCredential(apiKey: string): Promise<string[]> {
    return modelChoices(await this.listModels(apiKey));
  }

  async resolveModel(apiKey: string, requested: string): Promise<ModelSelection> {
    return this.selectionFrom(await this.listModels(apiKey), requested);
  }

  selectionFrom(models: ListedModel[], requested: string): ModelSelection {
    try {
      return selectModel(models, requested);
    } catch (error) {
      throw new DomainError(error instanceof Error ? error.message : "模型不可用");
    }
  }

  async createAgent(input: {
    apiKey: string;
    model: ModelSelection;
    repos: CloudRepo[];
    metadata: Record<string, string>;
  }): Promise<string> {
    const sdk = await this.load();
    let agent: SdkAgent | undefined;
    try {
      agent = await sdk.Agent.create({
        apiKey: input.apiKey,
        model: this.sdkModel(input.model),
        cloud: {
          repos: input.repos.map((repo) => ({ url: repo.url, startingRef: repo.startingRef })),
          metadata: input.metadata,
        },
      });
      if (!agent?.agentId) throw new DomainError("Cursor 未返回 Agent ID");
      return agent.agentId;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw this.asDomain(error, "创建 Cursor Agent 失败");
    } finally {
      await agent?.[Symbol.asyncDispose]().catch(() => undefined);
    }
  }

  async send(input: {
    apiKey: string;
    externalAgentId: string;
    model: ModelSelection;
    prompt: string;
    onText: (text: string) => Promise<void>;
    onRunId: (runId: string) => Promise<void>;
    shouldCancel: () => Promise<boolean>;
  }): Promise<CursorRunOutcome> {
    const sdk = await this.load();
    let agent: SdkAgent | undefined;
    try {
      agent = await sdk.Agent.resume(input.externalAgentId, {
        apiKey: input.apiKey,
        model: this.sdkModel(input.model),
      });
      let active: SdkRun | null = null;
      const run = await agent.send(input.prompt, {
        model: this.sdkModel(input.model),
        onDelta: async ({ update }: { update: { type?: string; text?: string } }) => {
          if (update?.type === "text-delta" && update.text) await input.onText(update.text);
          if (active && (await input.shouldCancel()) && active.supports("cancel")) {
            await active.cancel();
          }
        },
      });
      active = run;
      await input.onRunId(run.id);
      if ((await input.shouldCancel()) && run.supports("cancel")) await run.cancel();
      const result = await run.wait();
      if (result.status === "cancelled") return { kind: "cancelled", runId: run.id };
      if (result.status === "error") {
        return { kind: "run_error", runId: run.id, message: result.error?.message || "运行失败" };
      }
      return { kind: "finished", runId: run.id, text: result.result ?? "" };
    } catch (error) {
      const helpUrl = typeof error === "object" && error && "helpUrl" in error ? String((error as { helpUrl?: string }).helpUrl) : undefined;
      const retryable = typeof error === "object" && error && "isRetryable" in error ? Boolean((error as { isRetryable?: boolean }).isRetryable) : false;
      const message = error instanceof Error ? error.message : "Cursor 启动失败";
      if (this.isSdkError(error, sdk)) {
        return { kind: "startup_error", message, retryable, helpUrl };
      }
      return { kind: "startup_error", message, retryable, helpUrl };
    } finally {
      await agent?.[Symbol.asyncDispose]().catch(() => undefined);
    }
  }

  private async listModels(apiKey: string): Promise<ListedModel[]> {
    const sdk = await this.load();
    try {
      return await sdk.Cursor.models.list({ apiKey });
    } catch (error) {
      throw this.asDomain(error, "Cursor API Key 无效");
    }
  }

  private sdkModel(model: ModelSelection) {
    return model.params?.length ? model : { id: model.id };
  }

  private async load(): Promise<SdkModule> {
    try {
      return (await import("@cursor/sdk")) as SdkModule;
    } catch {
      throw new DomainError("服务器未能加载 Cursor SDK", 500);
    }
  }

  private isSdkError(error: unknown, sdk: SdkModule) {
    return error instanceof sdk.CursorAgentError;
  }

  private asDomain(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;
    const helpUrl = typeof error === "object" && error && "helpUrl" in error ? (error as { helpUrl?: string }).helpUrl : undefined;
    return new DomainError(helpUrl ? `${message} ${helpUrl}` : message || fallback, 400);
  }
}
