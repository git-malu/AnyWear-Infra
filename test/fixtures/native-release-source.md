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

## Genuine v0.2 output

`github-native-release-verification-v0.2.json` preserves the unmodified stdout of
`gh release verify service-baseline-b5bb8ec69ec68a99a0a9c87ec8a84dc2b1ae8a29bb88e46f6808dc8d71c84332 --repo git-malu/AnyWear-Service --format json`
captured on 2026-10-08 with `gh 2.101.0 (2026-09-15)`, exit 0. The owner's
retained forensic source is `native/release.json` in
`anywear-issue54-current-publisher-repair-round-20261008T093000Z/sealed-failure-forensics`.
All five separate `verify-asset --format json` outputs are byte-identical; the
manager independently matched the result with gh 2.102.0.

- Raw stdout: 5681 bytes, SHA-256
  `cf0bf9a5550ec9b475cb9b1fea68b793a39a2e640431deb69f075254d23ab0e2`.
- Signed DSSE payload: 1267 bytes, SHA-256
  `a146004b9e828e3395fdb6739b4cea1c1da7deff1508aed5d8ef967914369e2f`.
- Canonical statement SHA-256:
  `88c900b54c66a042490f91ec9a1443bb441f34102e6512b9b9b26040f46baa63`.

Release `406660922` has the exact target and five asset identities, but its
publisher run `37757528038/1` failed and emitted no publication artifact. This is
a genuine serialization and parser-policy fixture; it does not qualify that
release for selection, adoption or deployment. Cryptographic verification belongs
to the native CLI. Tests that mutate its statement and payload exercise offline
policy only; the retained signature does not verify those mutations.

The official [Release specification](https://github.com/in-toto/attestation/blob/fd2609c16bcb0ac53443e2b4612977f997e8f9a5/spec/predicates/release.md)
and [v0.2 proto](https://github.com/in-toto/attestation/blob/fd2609c16bcb0ac53443e2b4612977f997e8f9a5/protos/in_toto_attestation/predicates/release/v0.2/release.proto)
define `packageId` as a stable package identifier. The document's schema/examples
still print v0.1 URIs despite its v0.2 header and migration note; the proto and
genuine output establish the observed v0.2 shape. GitHub additionally signs
`databaseId` for the release and uses its repository ID as `packageId`; these are
distinct exact identity bindings, not interchangeable aliases.

Runner-version CLI provenance is pinned to tag `v2.101.0`, commit
`0cf1092493af067646fc5f3db9421c6a6ec9c938`: its
[release verifier](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/release/verify/verify.go)
and [signature policy](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/release/shared/attestation.go)
retain native cryptographic verification. Its
[signed example](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/attestation/test/data/github_release_bundle.json)
remains v0.1, so the original fixture and its provenance remain unchanged for
backward compatibility.
