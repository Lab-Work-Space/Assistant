// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// Every github_ tool is sensitive (SENSITIVE_TOOL).
import { READ, DESTRUCTIVE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('github', {
  github_get_me: { ...READ, sensitive: true },
  github_list_my_organizations: { ...READ, sensitive: true },
  github_list_org_repositories: { ...READ, sensitive: true },
  github_list_user_repositories: { ...READ, sensitive: true },
  github_search_repositories: { ...READ, sensitive: true },
  github_get_repository_info: { ...READ, sensitive: true },
  github_list_repository_issues: { ...READ, sensitive: true },
  github_list_repository_pulls: { ...READ, sensitive: true },
  github_list_repository_commits: { ...READ, sensitive: true },
  github_get_issue: { ...READ, sensitive: true },
  github_get_pull_request: { ...READ, sensitive: true },
  github_create_branch: { ...DESTRUCTIVE, sensitive: true },
  github_create_or_update_file: { ...DESTRUCTIVE, sensitive: true },
  github_create_pull_request: { ...DESTRUCTIVE, sensitive: true },
});
