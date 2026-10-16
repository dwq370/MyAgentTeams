import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { DomainError } from "../domain/errors";
import { ProjectMemberEntity, ProjectRoleEntity, TeamEntity, TeamMemberEntity } from "../entities";

const RANK = { member: 1, admin: 2, owner: 3 } as const;
export type ProjectAccess = keyof typeof RANK;

@Injectable()
export class AccessService {
  constructor(
    @InjectRepository(ProjectMemberEntity) private readonly projectMembers: Repository<ProjectMemberEntity>,
    @InjectRepository(ProjectRoleEntity) private readonly roles: Repository<ProjectRoleEntity>,
    @InjectRepository(TeamEntity) private readonly teams: Repository<TeamEntity>,
    @InjectRepository(TeamMemberEntity) private readonly teamMembers: Repository<TeamMemberEntity>,
  ) {}

  async requireProject(userId: string, projectId: string, min: ProjectAccess) {
    const membership = await this.projectMembers.findOne({ where: { projectId, userId } });
    if (!membership || RANK[membership.projectRole] < RANK[min]) {
      throw new DomainError(min === "member" ? "没有项目权限" : "需要项目管理员权限", 403);
    }
    return membership;
  }

  async requireTeam(userId: string, teamId: string, min: ProjectAccess = "member") {
    const team = await this.teams.findOne({ where: { id: teamId } });
    if (!team) throw new DomainError("Team 不存在", 404);
    const membership = await this.requireProject(userId, team.projectId, min);
    return { team, membership };
  }

  async requireHumanTeammate(userId: string, teamId: string) {
    const { team, membership } = await this.requireTeam(userId, teamId, "member");
    const human = await this.teamMembers.findOne({ where: { teamId, userId, memberType: "human" } });
    if (!human) throw new DomainError("你不在这个 Team 中", 403);
    const role = await this.roles.findOne({ where: { id: human.roleId } });
    if (!role) throw new DomainError("角色不存在", 404);
    return { team, membership, human, role };
  }
}
