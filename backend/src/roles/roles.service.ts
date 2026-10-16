import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, IsNull, Repository } from "typeorm";
import { DomainError } from "../domain/errors";
import { assertKnownPermissions, ROLE_TEMPLATES } from "../domain/policy";
import { ProjectRoleEntity, UserEntity } from "../entities";

@Injectable()
export class RolesService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(ProjectRoleEntity) private readonly roles: Repository<ProjectRoleEntity>,
  ) {}

  async onModuleInit() {
    await this.dataSource.query("SELECT pg_advisory_lock(814221)");
    try {
      const users = await this.users.find();
      for (const user of users) await this.ensureDefaults(user.id);
      await this.adoptProjectRoles();
    } finally {
      await this.dataSource.query("SELECT pg_advisory_unlock(814221)");
    }
  }

  async list(userId: string) {
    const roles = await this.ensureDefaults(userId);
    return roles
      .sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin) || a.code.localeCompare(b.code))
      .map((role) => this.present(role));
  }

  async create(
    userId: string,
    input: { code: string; name: string; description?: string; duties: string; promptTemplate: string; permissions: string[] },
  ) {
    await this.ensureDefaults(userId);
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
      throw new DomainError("角色编码需为大写字母开头，只含大写字母、数字和下划线");
    }
    assertKnownPermissions(input.permissions);
    const role = await this.roles.save(
      this.roles.create({
        ownerId: userId,
        projectId: null,
        code,
        name: input.name.trim(),
        description: input.description?.trim() ?? "",
        duties: input.duties.trim(),
        promptTemplate: input.promptTemplate.trim(),
        permissions: input.permissions,
        isBuiltin: false,
      }),
    );
    return this.present(role);
  }

  private async ensureDefaults(userId: string) {
    const existing = await this.roles.find({ where: { ownerId: userId, projectId: IsNull() } });
    const codes = new Set(existing.map((role) => role.code));
    const missing = ROLE_TEMPLATES.filter((template) => !codes.has(template.code));
    if (missing.length === 0) return existing;
    await this.roles.save(
      missing.map((template) =>
        this.roles.create({
          ownerId: userId,
          projectId: null,
          code: template.code,
          name: template.name,
          description: template.description,
          duties: template.duties,
          promptTemplate: template.promptTemplate,
          permissions: [...template.permissions],
          isBuiltin: true,
        }),
      ),
    );
    return this.roles.find({ where: { ownerId: userId, projectId: IsNull() } });
  }

  private async adoptProjectRoles() {
    await this.dataSource.query(`
      INSERT INTO project_role (owner_id, project_id, code, name, description, duties, prompt_template, permissions, is_builtin)
      SELECT DISTINCT ON (p.owner_id, pr.code)
        p.owner_id, NULL, pr.code, pr.name, pr.description, pr.duties, pr.prompt_template, pr.permissions, pr.is_builtin
      FROM project_role pr
      JOIN project p ON p.id = pr.project_id
      WHERE NOT EXISTS (
        SELECT 1 FROM project_role r
        WHERE r.owner_id = p.owner_id AND r.project_id IS NULL AND r.code = pr.code
      )
      ORDER BY p.owner_id, pr.code, pr.is_builtin DESC, pr.created_at
    `);
    await this.dataSource.query(`
      UPDATE team_member AS tm
      SET role_id = r.id
      FROM project_role old
      JOIN project p ON p.id = old.project_id
      JOIN project_role r ON r.owner_id = p.owner_id AND r.project_id IS NULL AND r.code = old.code
      WHERE tm.role_id = old.id AND old.project_id IS NOT NULL
    `);
    await this.dataSource.query(`
      DELETE FROM project_role pr
      WHERE pr.project_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM team_member tm WHERE tm.role_id = pr.id)
    `);
  }

  private present(role: ProjectRoleEntity) {
    return {
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      duties: role.duties,
      promptTemplate: role.promptTemplate,
      permissions: role.permissions,
      isBuiltin: role.isBuiltin,
    };
  }
}
