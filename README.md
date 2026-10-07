# AnyWear Infra

Private repository for AnyWear's shared AWS CDK application and infrastructure
operations. Extraction is tracked in [AnyWear #54](https://github.com/git-malu/AnyWear/issues/54).

This initial repository bootstrap contains documentation only. The Service-owned
CDK application remains authoritative until the reviewed migration and cutover.
No deployment workflows, cloud credentials or automatic deployments are enabled.

The proposed ownership boundary is shared infrastructure in this repository,
immutable application artifacts from Service, independent Client publishing through
deployed outputs, and system qualification in AnyWear-E2E. The ownership ADR must
be accepted before extraction implementation; Beta delivery and resource identity
verification are separate gates.

Read [AGENTS.md](AGENTS.md) before changing the repository. The root AnyWear shell
is a local workspace and does not deploy infrastructure.
