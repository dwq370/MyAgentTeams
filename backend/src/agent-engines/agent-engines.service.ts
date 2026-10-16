import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { decryptSecret, encryptSecret, secretHint } from "../common/crypto";
import { DomainError } from "../domain/errors";
import { AgentEngineEntity, ProjectEntity } from "../entities";
import { CursorPlatformAdapter } from "../platform/cursor.adapter";

export interface EngineSecrets {
  apiKey: string | null;
  defaultModel: string;
  selected: boolean;
}

@Injectable()
export class AgentEnginesService {
  constructor(
    private readonly config: ConfigService,
    private readonly cursor: CursorPlatformAdapter,
    @InjectRepository(AgentEngineEntity) private readonly engines: Repository<AgentEngineEntity>,
    @InjectRepository(ProjectEntity) private readonly projects: Repository<ProjectEntity>,
  ) {}

  async list(userId: string) {
    const engines = await this.engines.find({ where: { ownerId: userId }, order: { createdAt: "DESC" } });
    const projects = engines.length
      ? await this.projects.find({ where: engines.map((engine) => ({ agentEngineId: engine.id })) })
      : [];
    return Promise.all(engines.map(async (engine) => ({
      ...(await this.present(engine)),
      projects: projects
        .filter((project) => project.agentEngineId === engine.id)
        .map((project) => ({ id: project.id, name: project.name })),
    })));
  }

  async create(userId: string, input: { name: string; cursorApiKey: string; defaultModel?: string }) {
    const name = input.name.trim();
    await this.assertNameFree(userId, name);
    const models = await this.cursor.verifyCredential(input.cursorApiKey.trim());
    await this.cursor.resolveModel(input.cursorApiKey.trim(), input.defaultModel?.trim() || "composer-2.5");
    const engine = await this.engines.save(
      this.engines.create({
        ownerId: userId,
        name,
        kind: "cursor",
        credentialEncrypted: encryptSecret(input.cursorApiKey.trim(), this.encryptionKey()),
        defaultModel: input.defaultModel?.trim() || "composer-2.5",
        runtime: "cloud",
        gitTokenEncrypted: null,
      }),
    );
    return { ...(await this.present(engine)), models, projects: [] };
  }

  async update(
    userId: string,
    engineId: string,
    input: { name?: string; cursorApiKey?: string; defaultModel?: string },
  ) {
    const engine = await this.requireOwned(userId, engineId);
    let models: string[] = [];
    const patch: Partial<AgentEngineEntity> = {};
    if (input.name && input.name.trim() !== engine.name) {
      await this.assertNameFree(userId, input.name.trim(), engine.id);
      patch.name = input.name.trim();
    }
    if (input.cursorApiKey) {
      models = await this.cursor.verifyCredential(input.cursorApiKey.trim());
      patch.credentialEncrypted = encryptSecret(input.cursorApiKey.trim(), this.encryptionKey());
    }
    if (input.defaultModel) {
      const requested = input.defaultModel.trim();
      const apiKey = input.cursorApiKey?.trim() || (await this.apiKey(engine.id));
      await this.cursor.resolveModel(apiKey, requested);
      patch.defaultModel = requested;
    }
    if (Object.keys(patch).length > 0) await this.engines.update(engine.id, patch);
    const projects = await this.projects.find({ where: { agentEngineId: engine.id } });
    return {
      ...(await this.present({ ...engine, ...patch })),
      models,
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
    };
  }

  async remove(userId: string, engineId: string) {
    await this.requireOwned(userId, engineId);
    const projects = await this.projects.find({ where: { agentEngineId: engineId } });
    if (projects.length > 0) {
      throw new DomainError("仍有项目选用该 Agent 引擎，不能删除", 409, {
        projects: projects.map((project) => ({ id: project.id, name: project.name })),
      });
    }
    await this.engines.delete({ id: engineId });
    return { ok: true };
  }

  async requireOwned(userId: string, engineId: string) {
    const engine = await this.engines.findOne({ where: { id: engineId, ownerId: userId } });
    if (!engine) throw new DomainError("Agent 引擎不存在", 404);
    return engine;
  }

  async summary(engineId: string | null) {
    if (!engineId) return null;
    const engine = await this.engines.findOne({ where: { id: engineId } });
    if (!engine) return null;
    return {
      id: engine.id,
      name: engine.name,
      kind: engine.kind,
      defaultModel: engine.defaultModel,
    };
  }

  async defaultModelForProject(projectId: string) {
    const secrets = await this.secretsForProject(projectId);
    return secrets.defaultModel;
  }

  async secretsForProject(projectId: string): Promise<EngineSecrets> {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project?.agentEngineId) {
      return { apiKey: null, defaultModel: "composer-2.5", selected: false };
    }
    const engine = await this.engines
      .createQueryBuilder("engine")
      .addSelect("engine.credentialEncrypted")
      .where("engine.id = :id", { id: project.agentEngineId })
      .getOne();
    if (!engine) return { apiKey: null, defaultModel: "composer-2.5", selected: false };
    return {
      apiKey: decryptSecret(engine.credentialEncrypted, this.encryptionKey()),
      defaultModel: engine.defaultModel || "composer-2.5",
      selected: true,
    };
  }

  private async present(engine: AgentEngineEntity) {
    const stored = await this.engines
      .createQueryBuilder("engine")
      .addSelect("engine.credentialEncrypted")
      .where("engine.id = :id", { id: engine.id })
      .getOne();
    return {
      id: engine.id,
      name: engine.name,
      kind: engine.kind,
      defaultModel: engine.defaultModel,
      runtime: engine.runtime,
      cursorHint: stored ? secretHint(decryptSecret(stored.credentialEncrypted, this.encryptionKey())) : null,
    };
  }

  private async apiKey(engineId: string) {
    const engine = await this.engines
      .createQueryBuilder("engine")
      .addSelect("engine.credentialEncrypted")
      .where("engine.id = :id", { id: engineId })
      .getOne();
    if (!engine?.credentialEncrypted) throw new DomainError("未配置 Cursor API Key");
    return decryptSecret(engine.credentialEncrypted, this.encryptionKey());
  }

  private async assertNameFree(userId: string, name: string, exceptId?: string) {
    const existing = await this.engines.findOne({ where: { ownerId: userId, name } });
    if (existing && existing.id !== exceptId) throw new DomainError("已有同名 Agent 引擎", 409);
  }

  private encryptionKey() {
    return this.config.getOrThrow<string>("APP_ENCRYPTION_KEY");
  }
}
