# AnyWear Infra agent instructions

This repository owns shared AWS infrastructure and environment operations after
the verified #54 cutover. During bootstrap, AnyWear-Service remains the deployed
infrastructure authority.

- Follow the [AnyWear kanban workflow](https://github.com/git-malu/AnyWear/blob/main/.agents/skills/kanban-workflow/SKILL.md)
  and its [GitHub operations reference](https://github.com/git-malu/AnyWear/blob/main/.agents/skills/kanban-workflow/references/github-operations.md).
- Read the accepted ownership ADR and deployment contracts before modifying
  infrastructure. Keep proposed targets separate from observed implementation.
- Preserve existing stack names, construct/logical IDs, physical resources,
  endpoints, outputs and runtime-owned configuration through extraction.
- Service owns application/Lambda/migration/verification source and immutable
  artifacts. Do not generate the shared API or read mutable peer `main` as a
  deployment input. Client publishes independently through deployed interfaces.
- Use `gh` for GitHub and `aws` for AWS. Verify account, profile and region before
  cloud commands. Run package/build commands here, never in the shell root.
- Before AWS mutations, verify the recorded environment writer, in-flight
  operations, exact artifact/Infra revisions, reviewed diff and rollback inputs.
  Repo-local Actions concurrency is not a cross-repository lock.
- Keep one Git writer per physical repository and one deployment writer per
  environment. Preserve other owners' work and verify cessation before handoff.
- Delegate independent repository tasks with explicit paths/ownership; review
  child results before integration. Do not clean shared worktrees.
- Review diffs, run `git diff --check`, and complete repository checks before
  publishing. PR merge alone does not establish deployed acceptance.
- Never commit credentials, runtime secrets or unredacted cloud diagnostics.

No CDK application or deployment pipeline is installed in this documentation-only
bootstrap. Concrete package/check commands will accompany the reviewed extraction.
