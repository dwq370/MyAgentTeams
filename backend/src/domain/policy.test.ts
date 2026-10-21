import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCanRecordTest,
  assertReleaseItems,
  assertVersionTransition,
  assignmentRequired,
  composeAgentPrompt,
  forksWorkspace,
  parseGitGroup,
  parseGitHubRepo,
  parseGitRepo,
  roleDeletionBlock,
  tagNameForVersion,
  memberBranchName,
  workspaceBranch,
} from "./policy";
import { DomainError } from "./errors";

describe("role policy", () => {
  it("requires service assignment for developers and testers", () => {
    assert.equal(assignmentRequired(["service:develop"]), true);
    assert.equal(assignmentRequired(["service:test"]), true);
    assert.equal(assignmentRequired(["system:release"]), false);
    assert.equal(forksWorkspace(["service:version:create"]), false);
    assert.equal(forksWorkspace(["service:develop", "service:version:create"]), true);
  });

  it("blocks role deletion while members remain", () => {
    assert.equal(roleDeletionBlock([]), null);
    const block = roleDeletionBlock([{ id: "1", name: "开发 A", memberType: "agent" }]);
    assert.equal(block?.members.length, 1);
  });
});

describe("versions", () => {
  it("follows the service version state machine", () => {
    assert.doesNotThrow(() => assertVersionTransition("draft", "ready_for_test"));
    assert.throws(() => assertVersionTransition("draft", "passed"), DomainError);
    assert.throws(() => assertCanRecordTest("draft"), DomainError);
    assert.doesNotThrow(() => assertCanRecordTest("testing"));
  });

  it("publishes only passed service versions", () => {
    const services = new Set(["svc"]);
    assert.throws(
      () => assertReleaseItems([{ serviceId: "svc", status: "draft" }], services),
      /测试通过/,
    );
    assert.doesNotThrow(() => assertReleaseItems([{ serviceId: "svc", status: "passed" }], services));
  });
});

describe("workspace and prompt", () => {
  it("builds a stable fork branch", () => {
    assert.equal(workspaceBranch("Order Dev", "12345678-aaaa-bbbb-cccc-ddddeeee", "order-service"), "agents/order-dev/order-service");
    assert.equal(tagNameForVersion("1.2.0"), "v1.2.0");
    assert.equal(memberBranchName("epvs", "张三", "feature"), "agentteams-epvs/张三/feature");
    assert.equal(memberBranchName("Order Dev", "SWE 1", "order service"), "agentteams-Order-Dev/SWE-1/order-service");
    assert.throws(() => memberBranchName("epvs", "张三", ".."), DomainError);
  });

  it("maps the current role text into the next prompt", () => {
    const first = composeAgentPrompt({
      roleName: "软件开发工程师",
      duties: "旧职责",
      promptTemplate: "只改分配的服务",
      dutyOverride: "",
      workspaces: [],
      prompt: "实现下单",
    });
    const second = composeAgentPrompt({
      roleName: "软件开发工程师",
      duties: "新职责",
      promptTemplate: "只改分配的服务",
      dutyOverride: "",
      workspaces: [],
      prompt: "实现下单",
    });
    assert.match(first, /旧职责/);
    assert.match(second, /新职责/);
    assert.equal(first.includes("新职责"), false);
    assert.equal(first.includes("architecture.md"), false);
  });

  it("includes architecture.md in the architect prompt", () => {
    const prompt = composeAgentPrompt({
      roleName: "系统架构师",
      duties: "评估需求",
      promptTemplate: "你是系统架构师。",
      dutyOverride: "",
      workspaces: [],
      architectureDocument: "# 上下文\nmageai 提供任务接口",
      prompt: "评估这个需求",
    });
    assert.match(prompt, /architecture\.md：\n# 上下文/);
    assert.match(prompt, /评估需求时对照它/);
    const empty = composeAgentPrompt({
      roleName: "系统架构师",
      duties: "评估需求",
      promptTemplate: "你是系统架构师。",
      dutyOverride: "",
      workspaces: [],
      architectureDocument: "",
      prompt: "评估这个需求",
    });
    assert.match(empty, /还没有架构描述/);
  });

  it("parses GitHub repositories", () => {
    assert.deepEqual(parseGitHubRepo("https://github.com/acme/order-service.git"), {
      owner: "acme",
      repo: "order-service",
    });
    assert.equal(parseGitHubRepo("https://gitlab.com/acme/order-service"), null);
  });

  it("parses GitHub and GitLab repositories", () => {
    assert.equal(parseGitRepo("https://github.com/acme/order-service.git")?.host, "github");
    assert.deepEqual(parseGitRepo("https://gitlab.com/acme/group/order-service"), {
      host: "gitlab",
      origin: "https://gitlab.com",
      hostname: "gitlab.com",
      owner: "acme",
      repo: "order-service",
      projectPath: "acme/group/order-service",
    });
    assert.equal(parseGitRepo("https://gitlab.example.com/team/billing")?.host, "gitlab");
    assert.equal(parseGitRepo("http://192.168.31.85:8077/beet/api.git")?.origin, "http://192.168.31.85:8077");
    assert.equal(parseGitRepo("http://gitlab.com/acme/order-service")?.origin, "http://gitlab.com");
    assert.equal(parseGitGroup("http://192.168.31.85:8077/beet")?.origin, "http://192.168.31.85:8077");
    assert.equal(parseGitGroup("http://192.168.31.85:8077/beet")?.path, "beet");
    assert.equal(parseGitGroup("http://github.com/epvs")?.origin, "https://github.com");
    assert.equal(parseGitGroup("http://github.com/epvs/api"), null);
  });
});
