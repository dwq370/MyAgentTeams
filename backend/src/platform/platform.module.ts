import { Module } from "@nestjs/common";
import { CursorPlatformAdapter } from "./cursor.adapter";
import { GitHubClient } from "./github";
import { GitLabClient } from "./gitlab";
import { GitRepoClient } from "./git-repo";
import { KubectlProbe } from "./kubectl";
import { QueueService } from "./queue.service";
import { SshProbe } from "./ssh-probe";

@Module({
  providers: [GitHubClient, GitLabClient, GitRepoClient, KubectlProbe, SshProbe, CursorPlatformAdapter, QueueService],
  exports: [GitHubClient, GitLabClient, GitRepoClient, KubectlProbe, SshProbe, CursorPlatformAdapter, QueueService],
})
export class PlatformModule {}
