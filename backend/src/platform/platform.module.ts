import { Module } from "@nestjs/common";
import { CursorPlatformAdapter } from "./cursor.adapter";
import { GitHubClient } from "./github";
import { GitLabClient } from "./gitlab";
import { GitRepoClient } from "./git-repo";
import { LocalGit } from "./local-git";
import { KubectlProbe } from "./kubectl";
import { QueueService } from "./queue.service";
import { SshProbe } from "./ssh-probe";

@Module({
  providers: [GitHubClient, GitLabClient, LocalGit, GitRepoClient, KubectlProbe, SshProbe, CursorPlatformAdapter, QueueService],
  exports: [GitHubClient, GitLabClient, LocalGit, GitRepoClient, KubectlProbe, SshProbe, CursorPlatformAdapter, QueueService],
})
export class PlatformModule {}
