import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("app_user")
export class UserEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: "password_hash", select: false })
  passwordHash: string;

  @Column()
  name: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}

@Entity("project")
export class ProjectEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  @Column({ type: "text", default: "" })
  description: string;

  @Column({ name: "architecture_description", type: "text", default: "" })
  architectureDescription: string;

  @Column({ name: "owner_id", type: "uuid" })
  ownerId: string;

  @Column({ name: "agent_engine_id", type: "uuid", nullable: true })
  agentEngineId: string | null;

  @Column({ name: "git_token_encrypted", type: "text", nullable: true, select: false })
  gitTokenEncrypted: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}

@Entity("agent_engine")
@Index(["ownerId", "name"], { unique: true })
export class AgentEngineEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "owner_id", type: "uuid" })
  ownerId: string;

  @Column()
  name: string;

  @Column()
  kind: string;

  @Column({ name: "credential_encrypted", type: "text", select: false })
  credentialEncrypted: string;

  @Column({ name: "default_model" })
  defaultModel: string;

  @Column({ default: "cloud" })
  runtime: string;

  @Column({ name: "git_token_encrypted", type: "text", nullable: true, select: false })
  gitTokenEncrypted: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}

@Entity("project_member")
@Index(["projectId", "userId"], { unique: true })
export class ProjectMemberEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "user_id", type: "uuid" })
  userId: string;

  @Column({ name: "project_role" })
  projectRole: "owner" | "admin" | "member";

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("project_platform")
@Index(["projectId", "platform"], { unique: true })
export class ProjectPlatformEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column()
  platform: string;

  @Column({ name: "credential_encrypted", type: "text", select: false })
  credentialEncrypted: string;

  @Column({ name: "default_model" })
  defaultModel: string;

  @Column({ default: "cloud" })
  runtime: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}

@Entity("service")
@Index(["projectId", "name"], { unique: true })
export class ServiceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column()
  name: string;

  @Column({ name: "repo_url", type: "text" })
  repoUrl: string;

  @Column({ name: "default_branch" })
  defaultBranch: string;

  @Column({ name: "image_name" })
  imageName: string;

  @Column({ name: "git_token_encrypted", type: "text", nullable: true, select: false })
  gitTokenEncrypted: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("test_environment")
@Index(["projectId", "name"], { unique: true })
export class TestEnvironmentEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column()
  name: string;

  @Column({ default: "standalone" })
  kind: "standalone" | "kubernetes";

  @Column({ type: "text", nullable: true })
  url: string | null;

  @Column({ name: "deploy_entry", type: "text", default: "" })
  deployEntry: string;

  @Column({ name: "ssh_host", type: "varchar", nullable: true })
  sshHost: string | null;

  @Column({ name: "ssh_port", type: "int", nullable: true })
  sshPort: number | null;

  @Column({ name: "ssh_username", type: "varchar", nullable: true })
  sshUsername: string | null;

  @Column({ name: "ssh_password_encrypted", type: "text", nullable: true, select: false })
  sshPasswordEncrypted: string | null;

  @Column({ name: "kube_context", type: "varchar", nullable: true })
  kubeContext: string | null;

  @Column({ name: "cluster_server", type: "text", nullable: true })
  clusterServer: string | null;

  @Column({ name: "connection_info", type: "jsonb", nullable: true })
  connectionInfo: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("project_role")
@Index(["projectId", "code"], { unique: true })
export class ProjectRoleEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "owner_id", type: "uuid", nullable: true })
  ownerId: string | null;

  @Column({ name: "project_id", type: "uuid", nullable: true })
  projectId: string | null;

  @Column()
  code: string;

  @Column()
  name: string;

  @Column({ type: "text", default: "" })
  description: string;

  @Column({ type: "text", default: "" })
  duties: string;

  @Column({ name: "prompt_template", type: "text", default: "" })
  promptTemplate: string;

  @Column({ type: "jsonb", default: [] })
  permissions: string[];

  @Column({ name: "is_builtin", default: false })
  isBuiltin: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}

@Entity("team")
@Index(["projectId", "name"], { unique: true })
export class TeamEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column()
  name: string;

  @Column({ type: "text", default: "" })
  description: string;

  @Column({ name: "test_environment_id", type: "uuid", nullable: true })
  testEnvironmentId: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("team_source")
@Index(["teamId", "url"], { unique: true })
export class TeamSourceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "team_id", type: "uuid" })
  teamId: string;

  @Column({ type: "varchar", length: 16 })
  kind: "group" | "repo";

  @Column({ type: "text" })
  url: string;

  @Column({ type: "varchar", length: 200 })
  name: string;

  @Column({ name: "baseline_ref", type: "varchar", length: 200, default: "main" })
  baselineRef: string;

  @Column({ name: "git_token_encrypted", type: "text", nullable: true, select: false })
  gitTokenEncrypted: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("team_workspace")
@Index(["teamId", "serviceId"], { unique: true })
export class TeamWorkspaceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "team_id", type: "uuid" })
  teamId: string;

  @Column({ name: "service_id", type: "uuid" })
  serviceId: string;

  @Column({ name: "baseline_ref" })
  baselineRef: string;
}

@Entity("service_version")
@Index(["serviceId", "version"], { unique: true })
export class ServiceVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "service_id", type: "uuid" })
  serviceId: string;

  @Column({ name: "team_id", type: "uuid" })
  teamId: string;

  @Column()
  version: string;

  @Column({ name: "git_sha", type: "varchar", nullable: true })
  gitSha: string | null;

  @Column()
  status: "draft" | "ready_for_test" | "testing" | "passed" | "failed";

  @Column({ name: "tag_name", type: "varchar", nullable: true })
  tagName: string | null;

  @Column({ name: "tag_status", default: "none" })
  tagStatus: "none" | "tagged" | "skipped" | "failed";

  @Column({ name: "tag_error", type: "text", nullable: true })
  tagError: string | null;

  @Column({ name: "image_tag", type: "varchar", nullable: true })
  imageTag: string | null;

  @Column({ name: "created_by_member_id", type: "uuid", nullable: true })
  createdByMemberId: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("team_member")
export class TeamMemberEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "team_id", type: "uuid" })
  teamId: string;

  @Column({ name: "member_type" })
  memberType: "human" | "agent";

  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId: string | null;

  @Column()
  name: string;

  @Column({ name: "role_id", type: "uuid" })
  roleId: string;

  @Column({ name: "duty_override", type: "text", default: "" })
  dutyOverride: string;

  @Column()
  status: "pending" | "active" | "failed";

  @Column({ name: "failure_reason", type: "text", nullable: true })
  failureReason: string | null;

  @Column({ name: "tested_service_version_id", type: "uuid", nullable: true })
  testedServiceVersionId: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("agent")
export class AgentEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "member_id", type: "uuid", unique: true })
  memberId: string;

  @Column()
  platform: string;

  @Column({ name: "external_agent_id", type: "varchar", nullable: true })
  externalAgentId: string | null;

  @Column()
  model: string;

  @Column({ default: "cloud" })
  runtime: string;

  @Column()
  status: "pending" | "active" | "failed";

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("agent_workspace")
export class AgentWorkspaceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "agent_id", type: "uuid" })
  agentId: string;

  @Column({ name: "parent_workspace_id", type: "uuid", nullable: true })
  parentWorkspaceId: string | null;

  @Column({ name: "service_id", type: "uuid" })
  serviceId: string;

  @Column({ name: "repo_url", type: "text" })
  repoUrl: string;

  @Column()
  branch: string;

  @Column({ name: "baseline_ref" })
  baselineRef: string;

  @Column()
  forked: boolean;

  @Column({ name: "fork_status" })
  forkStatus: "planned" | "ready" | "failed";

  @Column({ name: "branch_origin", default: "baseline" })
  branchOrigin: "baseline" | "created" | "selected";

  @Column({ name: "git_sha", type: "varchar", nullable: true })
  gitSha: string | null;

  @Column({ name: "local_path", type: "text", nullable: true })
  localPath: string | null;
}

@Entity("member_contact")
@Index(["memberId", "peerMemberId"], { unique: true })
export class MemberContactEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "member_id", type: "uuid" })
  memberId: string;

  @Column({ name: "peer_member_id", type: "uuid" })
  peerMemberId: string;
}

@Entity("member_service")
@Index(["memberId", "serviceId"], { unique: true })
export class MemberServiceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "member_id", type: "uuid" })
  memberId: string;

  @Column({ name: "service_id", type: "uuid" })
  serviceId: string;
}

@Entity("work_item")
export class WorkItemEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "team_id", type: "uuid" })
  teamId: string;

  @Column({ name: "service_id", type: "uuid", nullable: true })
  serviceId: string | null;

  @Column()
  title: string;

  @Column({ type: "text", default: "" })
  description: string;

  @Column({ name: "assignee_member_id", type: "uuid", nullable: true })
  assigneeMemberId: string | null;

  @Column({ name: "creator_user_id", type: "uuid" })
  creatorUserId: string;

  @Column()
  status: "open" | "in_progress" | "done";

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}

export interface RunUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  rawCostCents: number | null;
  chargedCents: number | null;
}

@Entity("agent_run")
export class AgentRunEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "agent_id", type: "uuid" })
  agentId: string;

  @Column({ name: "work_item_id", type: "uuid", nullable: true })
  workItemId: string | null;

  @Column({ type: "text" })
  prompt: string;

  @Column({ name: "composed_prompt", type: "text", default: "" })
  composedPrompt: string;

  @Column({ name: "role_snapshot", type: "jsonb", default: {} })
  roleSnapshot: Record<string, unknown>;

  @Column({ name: "external_run_id", type: "varchar", nullable: true })
  externalRunId: string | null;

  @Column()
  status: "queued" | "running" | "finished" | "error" | "startup_error" | "cancelled";

  @Column({ name: "error_category", type: "varchar", nullable: true })
  errorCategory: "startup" | "run" | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage: string | null;

  @Column({ type: "text", default: "" })
  log: string;

  @Column({ default: "chat" })
  purpose: "chat" | "architecture";

  @Column({ name: "target_project_id", type: "uuid", nullable: true })
  targetProjectId: string | null;

  @Column({ type: "jsonb", nullable: true })
  usage: RunUsageSnapshot | null;

  @Column({ name: "duration_ms", type: "int", nullable: true })
  durationMs: number | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @Column({ name: "finished_at", type: "timestamptz", nullable: true })
  finishedAt: Date | null;
}

@Entity("test_report")
export class TestReportEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "service_version_id", type: "uuid" })
  serviceVersionId: string;

  @Column({ name: "author_member_id", type: "uuid", nullable: true })
  authorMemberId: string | null;

  @Column()
  result: "passed" | "failed";

  @Column({ type: "text", default: "" })
  notes: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("system_release")
@Index(["projectId", "version"], { unique: true })
export class SystemReleaseEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "team_id", type: "uuid" })
  teamId: string;

  @Column()
  version: string;

  @Column()
  status: "draft" | "published";

  @Column({ name: "created_by_member_id", type: "uuid", nullable: true })
  createdByMemberId: string | null;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}

@Entity("system_release_item")
@Index(["releaseId", "serviceId"], { unique: true })
export class SystemReleaseItemEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "release_id", type: "uuid" })
  releaseId: string;

  @Column({ name: "service_id", type: "uuid" })
  serviceId: string;

  @Column({ name: "service_version_id", type: "uuid" })
  serviceVersionId: string;
}

export const ALL_ENTITIES = [
  UserEntity,
  AgentEngineEntity,
  ProjectEntity,
  ProjectMemberEntity,
  ProjectPlatformEntity,
  ServiceEntity,
  TestEnvironmentEntity,
  ProjectRoleEntity,
  TeamEntity,
  TeamSourceEntity,
  TeamWorkspaceEntity,
  ServiceVersionEntity,
  TeamMemberEntity,
  AgentEntity,
  AgentWorkspaceEntity,
  MemberContactEntity,
  MemberServiceEntity,
  WorkItemEntity,
  AgentRunEntity,
  TestReportEntity,
  SystemReleaseEntity,
  SystemReleaseItemEntity,
];
