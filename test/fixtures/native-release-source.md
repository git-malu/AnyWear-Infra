# Native release verification fixture

`github-native-release-verification.json` is exact stdout of this read-only CLI
command on 2026-10-08:

```text
gh release verify v6 --repo bdehamer/delme --format json
```

Its raw SHA-256 is
`cd31c6b48807df60c5fb4ae0d41d71233f56f9804a379bdcbd1fb8c4d843d614`.
The signed example bundle is also maintained by GitHub CLI in
[`github_release_bundle.json`](https://github.com/cli/cli/blob/trunk/pkg/cmd/attestation/test/data/github_release_bundle.json),
Git blob `8ca506dcbfe0e79d68cf908fdc75cf85fffe0ddb` (GitHub CLI, MIT license).

The fixture preserves actual verified output fields and GitHub's native release
certificate identity. It proves neither Service publication nor an AnyWear runtime
gate. Tests that change its statement explicitly exercise offline policy parsing;
they do not claim the original signature verifies those synthetic Service inputs.
