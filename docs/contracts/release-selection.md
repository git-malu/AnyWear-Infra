# Committed Service release selection

The permanent path uses one canonical `anywear_infra_selection` v2 file committed
under `selections/<name>.json`. Its fields are `schema_version`, `record_type`,
`release`, `image`, `lambdas`, `runtime_policy`, and `schema`. The release and
component fields keep their previous exact immutable IDs, hashes, build sources,
schema boundaries, and baseline provenance. There is no publication receipt.
Historical v1 selections and deployment/operation records are archival inputs;
the current runtime rejects them rather than changing their meaning.

`scripts/artifact-consumer.mjs` exports:

```js
const binding = {
  trustedInfraRoot: '/absolute/infra-checkout',
  expectedInfraSha: '<full-reviewed-Infra-commit>',
  selectionFile: 'selections/beta-baseline.json',
  selectionSha256: '<SHA-256-of-exact-committed-canonical-bytes>',
};
const selector = await loadCommittedSelection(binding);
const verified = await verifySelection(binding, '/external/temporary/assets', io);
```

The loader requires the exact Infra origin/full commit, clean tracked/untracked
source, no replacement refs or hidden-index flags, a regular tracked selection
blob with no path links, and exact canonical committed/working bytes and hash.
The caller supplies the trust root and pin; the loader never derives authority
from a deployment record, reconstructed selector, current HEAD, or vendor path.

The consumer automatically verifies the immutable release/tag/source, exact
completed-success main publisher repository/workflow/run/attempt/head owner
before and after, one complete native statement and all five asset verifications,
every selected asset ID/name/uploaded state/API size/digest/downloaded byte hash,
and all manifest/component/schema contracts. Actions publication ZIPs and their
lifetime are not runtime inputs. CLI telemetry is fixed disabled and only the
explicit read-only Service token reaches native/API commands.

```sh
node scripts/artifact-consumer.mjs \
  --selection selections/beta-baseline.json \
  --selection-sha256 '<raw-selection-sha256>' \
  --trusted-infra-root '/absolute/infra-checkout' \
  --infra-sha '<full-reviewed-Infra-commit>' \
  --output-dir '/external/temporary/assets'
```

Deployment and operation records use schema v2. Their `selection` contains
`file`, `sha256`, `release`, and `components`; `components` contains `image`,
`lambdas`, `runtime_policy`, and `schema`. The file/hash must resolve at the
explicit Infra pin. E2E uses its reviewed `compatibility.infra` and `.infra-source`
checkout for this same loader, even when it reconstructs a selector to compare a
record. A reconstructed temporary selector is never the verification authority.

This is a source contract. Publishing its code or committing the preserved
`beta-baseline.json` selection does not claim a runtime cutover or live native
verification. The current release remains immutable and is verified by ordinary
workflows before mutation credentials are requested.
