# Resolved examples

`runtime-config.minimal.json` is a structurally complete resolved configuration,
not a production credential file. Secret values are represented only by
`SecretRef`. The example intentionally uses the reserved `.invalid` endpoint.

Examples MUST validate against the named schema and all cross-field rules in
the configuration specification. They are normative only where another
specification section explicitly says so.

`tool-broker-config.stdio.json` is a non-secret closed-registry example with
one verified-package stdio transport and one aliased read-only tool. Its
embedded input/output schema digests are the SHA-256 values of their JCS bytes.
