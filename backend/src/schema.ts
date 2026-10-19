export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS app_user (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar(320) NOT NULL UNIQUE,
    password_hash varchar(255) NOT NULL,
    name varchar(80) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_engine (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    name varchar(80) NOT NULL,
    kind varchar(32) NOT NULL,
    credential_encrypted text NOT NULL,
    default_model varchar(120) NOT NULL,
    runtime varchar(16) NOT NULL DEFAULT 'cloud',
    git_token_encrypted text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS project (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(120) NOT NULL,
    description text NOT NULL DEFAULT '',
    owner_id uuid NOT NULL REFERENCES app_user(id),
    git_token_encrypted text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS project_member (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    project_role varchar(16) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS project_platform (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    platform varchar(32) NOT NULL,
    credential_encrypted text NOT NULL,
    default_model varchar(120) NOT NULL,
    runtime varchar(16) NOT NULL DEFAULT 'cloud',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, platform)
  )`,
  `CREATE TABLE IF NOT EXISTS service (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name varchar(64) NOT NULL,
    repo_url text NOT NULL,
    default_branch varchar(200) NOT NULL,
    image_name varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS project_role (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    code varchar(32) NOT NULL,
    name varchar(80) NOT NULL,
    description text NOT NULL DEFAULT '',
    duties text NOT NULL DEFAULT '',
    prompt_template text NOT NULL DEFAULT '',
    permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_builtin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, code)
  )`,
  `CREATE TABLE IF NOT EXISTS team (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name varchar(120) NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS team_workspace (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    service_id uuid NOT NULL REFERENCES service(id) ON DELETE RESTRICT,
    baseline_ref varchar(200) NOT NULL,
    UNIQUE (team_id, service_id)
  )`,
  `CREATE TABLE IF NOT EXISTS service_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id uuid NOT NULL REFERENCES service(id) ON DELETE RESTRICT,
    team_id uuid NOT NULL REFERENCES team(id) ON DELETE RESTRICT,
    version varchar(64) NOT NULL,
    git_sha varchar(64),
    status varchar(32) NOT NULL,
    tag_name varchar(80),
    tag_status varchar(16) NOT NULL DEFAULT 'none',
    tag_error text,
    image_tag varchar(240),
    created_by_member_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (service_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS team_member (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    member_type varchar(16) NOT NULL,
    user_id uuid REFERENCES app_user(id) ON DELETE CASCADE,
    name varchar(80) NOT NULL,
    role_id uuid NOT NULL REFERENCES project_role(id) ON DELETE RESTRICT,
    duty_override text NOT NULL DEFAULT '',
    status varchar(16) NOT NULL,
    failure_reason text,
    tested_service_version_id uuid REFERENCES service_version(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS team_member_human_user
    ON team_member (team_id, user_id) WHERE user_id IS NOT NULL`,
  `DO $$ BEGIN
    ALTER TABLE service_version
      ADD CONSTRAINT service_version_author_fk
      FOREIGN KEY (created_by_member_id) REFERENCES team_member(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE TABLE IF NOT EXISTS agent (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL UNIQUE REFERENCES team_member(id) ON DELETE CASCADE,
    platform varchar(32) NOT NULL,
    external_agent_id varchar(120),
    model varchar(120) NOT NULL,
    runtime varchar(16) NOT NULL DEFAULT 'cloud',
    status varchar(16) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_workspace (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    parent_workspace_id uuid REFERENCES team_workspace(id) ON DELETE SET NULL,
    service_id uuid NOT NULL REFERENCES service(id) ON DELETE RESTRICT,
    repo_url text NOT NULL,
    branch varchar(200) NOT NULL,
    baseline_ref varchar(200) NOT NULL,
    forked boolean NOT NULL,
    fork_status varchar(16) NOT NULL,
    git_sha varchar(64),
    branch_origin varchar(16) NOT NULL DEFAULT 'baseline'
  )`,
  `ALTER TABLE agent_workspace ADD COLUMN IF NOT EXISTS branch_origin varchar(16) NOT NULL DEFAULT 'baseline'`,
  `UPDATE agent_workspace SET branch_origin = 'created' WHERE forked = true AND branch_origin = 'baseline'`,
  `CREATE TABLE IF NOT EXISTS member_contact (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES team_member(id) ON DELETE CASCADE,
    peer_member_id uuid NOT NULL REFERENCES team_member(id) ON DELETE CASCADE,
    UNIQUE (member_id, peer_member_id),
    CHECK (member_id <> peer_member_id)
  )`,
  `CREATE TABLE IF NOT EXISTS member_service (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES team_member(id) ON DELETE CASCADE,
    service_id uuid NOT NULL REFERENCES service(id) ON DELETE RESTRICT,
    UNIQUE (member_id, service_id)
  )`,
  `CREATE TABLE IF NOT EXISTS work_item (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    service_id uuid REFERENCES service(id) ON DELETE SET NULL,
    title varchar(200) NOT NULL,
    description text NOT NULL DEFAULT '',
    assignee_member_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
    creator_user_id uuid NOT NULL REFERENCES app_user(id),
    status varchar(16) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    work_item_id uuid REFERENCES work_item(id) ON DELETE SET NULL,
    prompt text NOT NULL,
    composed_prompt text NOT NULL DEFAULT '',
    role_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    external_run_id varchar(120),
    status varchar(32) NOT NULL,
    error_category varchar(32),
    error_message text,
    log text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  )`,
  `ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS usage jsonb`,
  `ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS duration_ms integer`,
  `CREATE TABLE IF NOT EXISTS test_report (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_version_id uuid NOT NULL REFERENCES service_version(id) ON DELETE CASCADE,
    author_member_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
    result varchar(16) NOT NULL,
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS system_release (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES team(id) ON DELETE RESTRICT,
    version varchar(64) NOT NULL,
    status varchar(16) NOT NULL,
    created_by_member_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS system_release_item (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id uuid NOT NULL REFERENCES system_release(id) ON DELETE CASCADE,
    service_id uuid NOT NULL REFERENCES service(id) ON DELETE RESTRICT,
    service_version_id uuid NOT NULL REFERENCES service_version(id) ON DELETE RESTRICT,
    UNIQUE (release_id, service_id)
  )`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS agent_engine_id uuid`,
  `INSERT INTO agent_engine (id, owner_id, name, kind, credential_encrypted, default_model, runtime, git_token_encrypted)
   SELECT pp.id, p.owner_id,
     left(p.name, 40) || ' · ' || substr(replace(pp.id::text, '-', ''), 1, 8),
     pp.platform, pp.credential_encrypted, pp.default_model, COALESCE(pp.runtime, 'cloud'), p.git_token_encrypted
   FROM project_platform pp
   JOIN project p ON p.id = pp.project_id
   WHERE NOT EXISTS (SELECT 1 FROM agent_engine e WHERE e.id = pp.id)`,
  `UPDATE project AS pr
   SET agent_engine_id = pp.id
   FROM project_platform pp
   WHERE pp.project_id = pr.id AND pr.agent_engine_id IS NULL`,
  `DO $$ BEGIN
     ALTER TABLE project
       ADD CONSTRAINT project_agent_engine_fk
       FOREIGN KEY (agent_engine_id) REFERENCES agent_engine(id) ON DELETE RESTRICT;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `ALTER TABLE service ADD COLUMN IF NOT EXISTS git_token_encrypted text`,
  `UPDATE service AS s
   SET git_token_encrypted = p.git_token_encrypted
   FROM project p
   WHERE s.project_id = p.id
     AND s.git_token_encrypted IS NULL
     AND p.git_token_encrypted IS NOT NULL`,
  `UPDATE service AS s
   SET git_token_encrypted = e.git_token_encrypted
   FROM project p
   JOIN agent_engine e ON e.id = p.agent_engine_id
   WHERE s.project_id = p.id
     AND s.git_token_encrypted IS NULL
     AND e.git_token_encrypted IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS test_environment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name varchar(80) NOT NULL,
    url text NOT NULL,
    deploy_entry text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
  )`,
  `ALTER TABLE team ADD COLUMN IF NOT EXISTS test_environment_id uuid`,
  `DO $$ BEGIN
     ALTER TABLE team
       ADD CONSTRAINT team_test_environment_fk
       FOREIGN KEY (test_environment_id) REFERENCES test_environment(id) ON DELETE RESTRICT;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `ALTER TABLE test_environment ADD COLUMN IF NOT EXISTS kind varchar(32) NOT NULL DEFAULT 'standalone'`,
  `ALTER TABLE test_environment ALTER COLUMN url DROP NOT NULL`,
  `ALTER TABLE test_environment ADD COLUMN IF NOT EXISTS ssh_host varchar(255)`,
  `ALTER TABLE test_environment ADD COLUMN IF NOT EXISTS ssh_port integer`,
  `ALTER TABLE test_environment ADD COLUMN IF NOT EXISTS ssh_username varchar(80)`,
  `ALTER TABLE test_environment ADD COLUMN IF NOT EXISTS ssh_password_encrypted text`,
  `ALTER TABLE test_environment ADD COLUMN IF NOT EXISTS kube_context varchar(200)`,
  `ALTER TABLE test_environment ADD COLUMN IF NOT EXISTS cluster_server text`,
  `ALTER TABLE test_environment ADD COLUMN IF NOT EXISTS connection_info jsonb`,
  `ALTER TABLE project_role ADD COLUMN IF NOT EXISTS owner_id uuid`,
  `UPDATE project_role AS pr
   SET owner_id = p.owner_id
   FROM project p
   WHERE pr.project_id = p.id AND pr.owner_id IS NULL`,
  `ALTER TABLE project_role ALTER COLUMN project_id DROP NOT NULL`,
  `DO $$ BEGIN
     ALTER TABLE project_role
       ADD CONSTRAINT project_role_owner_fk
       FOREIGN KEY (owner_id) REFERENCES app_user(id) ON DELETE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_role_owner_code
   ON project_role (owner_id, code) WHERE project_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS team_source (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    kind varchar(16) NOT NULL,
    url text NOT NULL,
    name varchar(200) NOT NULL,
    baseline_ref varchar(200) NOT NULL DEFAULT 'main',
    git_token_encrypted text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (team_id, url)
  )`,
  ...[
    "app_user",
    "agent_engine",
    "project",
    "project_member",
    "project_platform",
    "service",
    "project_role",
    "team",
    "team_workspace",
    "team_source",
    "service_version",
    "team_member",
    "agent",
    "agent_workspace",
    "member_service",
    "member_contact",
    "work_item",
    "agent_run",
    "test_report",
    "system_release",
    "system_release_item",
    "test_environment",
  ].map(
    (table) =>
      `ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT gen_random_uuid()`,
  ),
];
