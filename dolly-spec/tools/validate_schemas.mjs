#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFiles = fs.readdirSync(path.join(root, "schemas"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => path.join(root, "schemas", name));
schemaFiles.push(path.join(root, "test-vectors", "vector.schema.json"));
schemaFiles.push(path.join(root, "test-vectors", "fixture.schema.json"));

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);
const schemas = schemaFiles.map((file) => [file, JSON.parse(fs.readFileSync(file, "utf8"))]);

for (const [file, schema] of schemas) {
  if (!ajv.validateSchema(schema)) {
    throw new Error(`${path.relative(root, file)} meta-schema failure: ${ajv.errorsText(ajv.errors)}`);
  }
  ajv.addSchema(schema);
}
for (const [file, schema] of schemas) {
  try {
    if (!ajv.getSchema(schema.$id)) throw new Error("schema did not compile");
  } catch (error) {
    throw new Error(`${path.relative(root, file)} compile failure: ${error.message}`);
  }
}

const schemaBase = "https://dolly.example/spec/0.1/schemas/";
// §10 of docs/spec/core/06-storage-and-recovery.md; every storage error is a pre-apply
// gate failure or all-or-nothing rollback, so each envelope carries outcome "not_applied".
const STORAGE_ERROR_OUTCOMES = new Map([
  ["STORAGE_INSTANCE_LOCKED", "not_applied"],
  ["STORAGE_UNSAFE_SQLITE_BUILD", "not_applied"],
  ["STORAGE_UNSAFE_CONFIGURATION", "not_applied"],
  ["STORAGE_BUSY", "not_applied"],
  ["STORAGE_FULL", "not_applied"],
  ["STORAGE_CORRUPT", "not_applied"],
  ["STORAGE_IDEMPOTENCY_CONFLICT", "not_applied"],
  ["STORAGE_SEQUENCE_CONFLICT", "not_applied"],
  ["STORAGE_MIGRATION_REQUIRED", "not_applied"],
]);
const registryFile = path.join(root, "protocol", "extension-rpc-v1.registry.json");
const rpcRegistry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
const registryValidator = ajv.getSchema(`${schemaBase}extension-rpc-registry.schema.json`);
if (!registryValidator || !registryValidator(rpcRegistry)) {
  throw new Error(`protocol/extension-rpc-v1.registry.json: ${ajv.errorsText(registryValidator?.errors)}`);
}

const methodContracts = rpcRegistry.requests.map((contract) => [
  contract.caller,
  contract.method,
  contract.params_schema,
  contract.result_schema,
]);
const notificationContracts = rpcRegistry.notifications.map((contract) => [
  contract.caller,
  contract.method,
  contract.params_schema,
]);

if (methodContracts.length !== 31 || new Set(methodContracts.map((entry) => entry[1])).size !== 31) {
  throw new Error("Extension RPC v1 request registry must contain 31 unique methods");
}
if (notificationContracts.length !== 6 || new Set(notificationContracts.map((entry) => entry[1])).size !== 6) {
  throw new Error("Extension RPC v1 notification registry must contain 6 unique methods");
}
for (const [, method, paramsSchema, resultSchema] of methodContracts) {
  if (!ajv.getSchema(paramsSchema)) throw new Error(`${method}: params schema did not compile: ${paramsSchema}`);
  if (!ajv.getSchema(resultSchema)) throw new Error(`${method}: result schema did not compile: ${resultSchema}`);
}
for (const [, method, paramsSchema] of notificationContracts) {
  if (!ajv.getSchema(paramsSchema)) throw new Error(`${method}: notification params schema did not compile: ${paramsSchema}`);
}
const requestContractsByMethod = new Map(rpcRegistry.requests.map((contract) => [contract.method, contract]));
for (const contract of rpcRegistry.requests) {
  if (contract.reconciliation.kind !== "method") continue;
  const statusContract = requestContractsByMethod.get(contract.reconciliation.method);
  if (!statusContract) {
    throw new Error(`${contract.method}: reconciliation method is not registered: ${contract.reconciliation.method}`);
  }
  if (statusContract.caller !== contract.caller || statusContract.state_changing) {
    throw new Error(`${contract.method}: reconciliation method must be a read-only request by the same caller`);
  }
}

function assertValid(label, schemaId, value, expected = true) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`${label}: unknown schema ${schemaId}`);
  const actual = validate(value);
  if (actual !== expected) {
    throw new Error(`${label}: expected valid=${expected}; ${ajv.errorsText(validate.errors)}`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function testUuid(suffix) {
  return `0198ab31-6c44-7e8a-b2bb-${String(suffix).padStart(12, "0")}`;
}

function testDigest(character) {
  return `sha256:${character.repeat(64)}`;
}

const testAssetId = `ast_b3_${"a".repeat(52)}`;

function walkRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const child of value) walkRefs(child, refs);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") refs.push(child);
      else walkRefs(child, refs);
    }
  }
  return refs;
}

const schemaFileById = new Map(schemas.map(([file, schema]) => [schema.$id, file]));
function localSchemaBundle(uri) {
  const [rawPath] = uri.split("#", 1);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawPath)) return null;
  if (rawPath.includes("?")) throw new Error(`schema URI query is not permitted: ${uri}`);
  const schemasRoot = path.join(root, "schemas");
  const rootFile = path.resolve(root, decodeURIComponent(rawPath));
  if (!(rootFile === schemasRoot || rootFile.startsWith(`${schemasRoot}${path.sep}`))) {
    throw new Error(`schema URI escapes schemas/: ${uri}`);
  }
  const pending = [rootFile];
  const visited = new Set();
  const resources = {};
  let rootSchema;
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    const schema = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof schema.$id !== "string") throw new Error(`${file} lacks $id`);
    if (resources[schema.$id] !== undefined &&
        canonicalJson(resources[schema.$id]) !== canonicalJson(schema)) {
      throw new Error(`duplicate schema resource $id ${schema.$id}`);
    }
    resources[schema.$id] = schema;
    visited.add(file);
    if (file === rootFile) rootSchema = schema;
    for (const ref of walkRefs(schema)) {
      const refBase = ref.split("#", 1)[0];
      if (!refBase) continue;
      let target;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(refBase)) {
        target = schemaFileById.get(refBase);
        if (!target) throw new Error(`unresolved absolute schema dependency ${refBase}`);
      } else {
        target = path.resolve(path.dirname(file), decodeURIComponent(refBase));
      }
      if (!(target === schemasRoot || target.startsWith(`${schemasRoot}${path.sep}`)) ||
          !fs.existsSync(target)) {
        throw new Error(`missing or escaping schema dependency ${refBase}`);
      }
      pending.push(target);
    }
  }
  const bundle = { schema: "dolly.schema-bundle/v1", root: rootSchema.$id, resources };
  const digest = `sha256:${crypto.createHash("sha256").update(canonicalJson(bundle)).digest("hex")}`;
  return { digest, rootSchema };
}

const actionResultValidatorIds = new Set([
  "org.dolly.validator.channel-send-result@1",
  "org.dolly.validator.skills-result@1",
  "org.dolly.validator.alarm-result@1",
  "org.dolly.validator.memory-search-result@1",
  "org.dolly.validator.napcatqq-action-result@1",
]);
const actionArgumentValidatorIds = new Set([
  "org.dolly.validator.napcatqq-action@1",
]);
function actionContractSemanticErrors(descriptor) {
  const errors = [];
  const seenNames = new Set();
  for (const action of descriptor.actions ?? []) {
    if (seenNames.has(action.name)) errors.push(`duplicate Action name ${action.name}`);
    seenNames.add(action.name);
    for (const field of ["arguments_schema", "result_schema"]) {
      const binding = action[field];
      if (binding === null || typeof binding !== "object") {
        errors.push(`${action.name}.${field} is not a SchemaBinding`);
        continue;
      }
      let bundle;
      try {
        bundle = localSchemaBundle(binding.uri);
      } catch (error) {
        errors.push(`${action.name}.${field}: ${error.message}`);
        continue;
      }
      if (bundle === null) continue;
      if (bundle.digest !== binding.schema_digest) {
        errors.push(`${action.name}.${field} schema_digest mismatch`);
      }
      const annotationKey = field === "result_schema"
        ? "x-dolly-action-result-validator"
        : "x-dolly-action-arguments-validator";
      const annotation = bundle.rootSchema[annotationKey] ?? null;
      if (canonicalJson(annotation) !== canonicalJson(binding.semantic_validator)) {
        errors.push(`${action.name}.${field} validator annotation mismatch`);
      }
      if (binding.semantic_validator !== null) {
        const key = `${binding.semantic_validator.id}@${binding.semantic_validator.revision}`;
        const available = field === "result_schema"
          ? actionResultValidatorIds
          : actionArgumentValidatorIds;
        if (!available.has(key)) errors.push(`unavailable validator ${key}`);
      }
    }
  }
  return errors;
}

function assertSemantic(label, validateErrors, value, expected = true, context = undefined) {
  const errors = validateErrors(value, context);
  const actual = errors.length === 0;
  if (actual !== expected) {
    throw new Error(`${label}: expected semantic validity=${expected}; ${errors.join("; ")}`);
  }
}

function localJsonPointerExists(document, reference) {
  if (reference === "#") return true;
  if (!reference.startsWith("#/")) return false;
  let value = document;
  for (const token of reference.slice(2).split("/").map((part) =>
    part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, token)) return false;
    value = value[token];
  }
  return true;
}

function embeddedSchemaReferenceErrors(schema, label) {
  const errors = [];
  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["$ref", "$dynamicRef"].includes(key)) {
        if (typeof child !== "string" || !child.startsWith("#")) {
          errors.push(`${label} contains a cross-document or remote ${key}`);
        } else if (!localJsonPointerExists(schema, child)) {
          errors.push(`${label} contains an unresolved or unsupported local ${key} ${child}`);
        }
      } else {
        visit(child);
      }
    }
  }
  visit(schema);
  return errors;
}

function embeddedSchemaCompileErrors(schema, label) {
  const errors = [];
  const isolatedAjv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(isolatedAjv);
  if (!isolatedAjv.validateSchema(schema)) {
    errors.push(`${label} is not a valid Draft 2020-12 schema: ${isolatedAjv.errorsText(isolatedAjv.errors)}`);
    return errors;
  }
  try {
    isolatedAjv.compile(schema);
  } catch (error) {
    errors.push(`${label} does not compile as a self-contained Draft 2020-12 schema: ${error.message}`);
  }
  return errors;
}

function schemaKeywordPresent(value, keyword) {
  if (Array.isArray(value)) return value.some((item) => schemaKeywordPresent(item, keyword));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    key === keyword || schemaKeywordPresent(child, keyword));
}

function effectiveConfigOverlayErrors(value) {
  const extensionCount = Object.keys(value.extension_config).length;
  const moduleCount = Object.keys(value.module_config).length;
  const effectiveConfig = { ...value.extension_config, ...value.module_config };
  const errors = [];
  if (extensionCount > 1024) errors.push("Extension config exceeds its 1024-member input ceiling");
  if (moduleCount > 1024) errors.push("Module config exceeds its 1024-member input ceiling");
  if (Object.keys(effectiveConfig).length > 1024) {
    errors.push("resolved effective_config exceeds the 1024-member consumer ceiling");
  }
  return errors;
}

const boundaryExtensionConfig = Object.fromEntries(
  Array.from({ length: 1024 }, (_, index) => [`key-${String(index).padStart(4, "0")}`, index]),
);
assertSemantic(
  "effective config overlay at 1024 members",
  effectiveConfigOverlayErrors,
  {
    extension_config: boundaryExtensionConfig,
    module_config: { "key-0000": "module override" },
  },
);
assertSemantic(
  "effective config overlay at 1025 disjoint members",
  effectiveConfigOverlayErrors,
  {
    extension_config: boundaryExtensionConfig,
    module_config: { "module-only-key": true },
  },
  false,
);

function configSchemaBundleErrors(config, claimedDigest, bundle, bindingUri, label) {
  const errors = [];
  if (claimedDigest !== canonicalDigest(bundle)) {
    errors.push(`${label} schema-bundle digest does not equal sha256(JCS(bundle))`);
  }
  if (bundle?.schema !== "dolly.schema-bundle/v1" || typeof bundle?.root !== "string" ||
      bundle?.resources === null || typeof bundle?.resources !== "object" ||
      Array.isArray(bundle?.resources) || !Object.hasOwn(bundle.resources, bundle.root)) {
    return [...errors, `${label} schema bundle has an invalid envelope or missing root`];
  }
  if (typeof bindingUri !== "string" || bindingUri.includes("?") || bindingUri.includes("#")) {
    errors.push(`${label} config schema binding must be a whole-resource URI without query or fragment`);
  } else {
    try {
      new URL(bindingUri);
    } catch {
      errors.push(`${label} config schema binding must be an absolute resource URI`);
    }
    if (bundle.root !== bindingUri) {
      errors.push(`${label} schema-bundle root does not equal the frozen config binding URI`);
    }
  }
  const isolatedAjv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(isolatedAjv);
  try {
    for (const [resourceId, schema] of Object.entries(bundle.resources)) {
      if (schemaKeywordPresent(schema, "default")) {
        errors.push(`${label} schema resource ${resourceId} contains forbidden default annotations`);
      }
      if (schema !== null && typeof schema === "object" && schema.$id !== undefined &&
          schema.$id !== resourceId) {
        errors.push(`${label} schema resource key does not equal its $id`);
      }
      isolatedAjv.addSchema(schema, resourceId);
    }
    const validate = isolatedAjv.getSchema(bundle.root);
    if (validate === undefined) {
      errors.push(`${label} root schema did not compile`);
    } else if (!validate(config)) {
      errors.push(`${label} value fails its frozen schema bundle: ${isolatedAjv.errorsText(validate.errors)}`);
    }
  } catch (error) {
    errors.push(`${label} schema bundle does not compile: ${error.message}`);
  }
  return errors;
}

function toolBrokerConfigSemanticErrors(config) {
  const errors = [];
  for (const [serverId, server] of Object.entries(config.servers)) {
    if (server.transport.kind === "streamable_http") {
      try {
        const endpoint = new URL(server.transport.endpoint);
        if (endpoint.username !== "" || endpoint.password !== "") {
          errors.push(`${serverId}.transport.endpoint contains forbidden userinfo`);
        }
        if (endpoint.search !== "" || server.transport.endpoint.includes("?")) {
          errors.push(`${serverId}.transport.endpoint contains a forbidden query`);
        }
        if (endpoint.hash !== "" || server.transport.endpoint.includes("#")) {
          errors.push(`${serverId}.transport.endpoint contains a forbidden fragment`);
        }
      } catch (error) {
        errors.push(`${serverId}.transport.endpoint is not a parseable URL: ${error.message}`);
      }
    }
    for (const [toolAlias, tool] of Object.entries(server.tools)) {
      for (const field of ["input_schema", "output_schema"]) {
        const digestField = `${field}_digest`;
        const digest = canonicalDigest(tool[field]);
        if (tool[digestField] !== digest) {
          errors.push(`${serverId}.${toolAlias}.${digestField} does not equal sha256(JCS(${field}))`);
        }
        errors.push(...embeddedSchemaReferenceErrors(tool[field], `${serverId}.${toolAlias}.${field}`));
        errors.push(...embeddedSchemaCompileErrors(tool[field], `${serverId}.${toolAlias}.${field}`));
      }
    }
  }
  return errors;
}

const cases = [[
  path.join(root, "examples", "runtime-config.minimal.json"),
  "https://dolly.example/spec/0.1/schemas/runtime-config.schema.json",
], [
  path.join(root, "examples", "tool-broker-config.stdio.json"),
  "https://dolly.example/spec/0.1/schemas/tool-broker-config.schema.json",
]];
for (const name of fs.readdirSync(path.join(root, "test-vectors"), { recursive: true })) {
  if (typeof name === "string" && name.endsWith(".json") &&
      !name.endsWith(".schema.json") && !name.startsWith(`fixtures${path.sep}`)) {
    cases.push([
      path.join(root, "test-vectors", name),
      "https://dolly.example/spec/0.1/test-vectors/vector.schema.json",
    ]);
  }
}
for (const name of fs.readdirSync(path.join(root, "test-vectors", "fixtures"))) {
  if (name.endsWith(".json")) {
    cases.push([
      path.join(root, "test-vectors", "fixtures", name),
      "https://dolly.example/spec/0.1/test-vectors/fixture.schema.json",
    ]);
  }
}

for (const [file, schemaId] of cases) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  assertValid(path.relative(root, file), schemaId, value);
  if (schemaId.endsWith("/runtime-config.schema.json")) {
    for (const [moduleId, module] of Object.entries(value.spec.modules)) {
      assertSemantic(`runtime config Descriptor ${moduleId}`, actionContractSemanticErrors, module.descriptor);
    }
    assertSemantic(
      "runtime config nested Tool Broker",
      toolBrokerConfigSemanticErrors,
      value.spec.services.tool_broker,
    );
  }
  if (schemaId.endsWith("/tool-broker-config.schema.json")) {
    assertSemantic(path.relative(root, file), toolBrokerConfigSemanticErrors, value);
  }
  if (value.schema === "dolly.test-vector/v1" && Array.isArray(value.expected?.emitted)) {
    for (const [index, emitted] of value.expected.emitted.entries()) {
      if (typeof emitted?.error === "string") {
        const relative = path.relative(root, file);
        const envelope = { ...emitted, code: emitted.error, message: "test", details: {} };
        delete envelope.error;
        assertValid(`${relative}.expected.emitted[${index}] error envelope`, `${schemaBase}error.schema.json`, envelope);
        const outcome = STORAGE_ERROR_OUTCOMES.get(emitted.error);
        if (!outcome) {
          throw new Error(`${relative}.expected.emitted[${index}]: unknown storage error code ${emitted.error}`);
        }
        if (emitted.outcome !== outcome || outcome !== "not_applied") {
          throw new Error(`${relative}.expected.emitted[${index}]: outcome must be "${outcome}" per §10`);
        }
      }
      if (emitted?.schema === "dolly.action-result/v1") {
        assertValid(
          `${path.relative(root, file)}.expected.emitted[${index}]`,
          `${schemaBase}action-result.schema.json`,
          emitted,
        );
      }
    }
  }
  if (value.test_id === "TST-CORE-009") {
    const evidenceDigests = new Map();
    for (const [caseName, replayCase] of Object.entries(value.stimulus?.cases ?? {})) {
      const command = replayCase.commands?.find((entry) => entry.command === "RecordReplayEvidence");
      if (!command) throw new Error(`${path.relative(root, file)}.${caseName}: missing replay-evidence command`);
      const actualDigest = canonicalDigest(command.record);
      if (command.expected_evidence_digest !== actualDigest) {
        throw new Error(`${path.relative(root, file)}.${caseName}: replay-evidence command digest is stale`);
      }
      evidenceDigests.set(caseName, actualDigest);
    }
    const completeDigest = evidenceDigests.get("complete");
    const authorizationAssertion = value.expected.assertions.find(
      (entry) => entry.path === "/complete/activation/next_attempt_authorization",
    );
    if (authorizationAssertion?.value?.evidence_digest !== completeDigest) {
      throw new Error(`${path.relative(root, file)}: retry authorization does not bind the complete evidence digest`);
    }
    const evidenceEvent = value.expected.emitted.find(
      (entry) => entry.case === "complete" && entry.event === "ActivationReplayEvidenceRecorded",
    );
    if (evidenceEvent?.evidence_digest !== completeDigest) {
      throw new Error(`${path.relative(root, file)}: emitted replay-evidence event digest is stale`);
    }
  }
  if (value.schema === "dolly.test-fixture/v1" && value.kind === "block_draft") {
    assertValid(path.relative(root, file), "https://dolly.example/spec/0.1/schemas/block-draft.schema.json", value.value);
  }
  if (value.schema === "dolly.test-fixture/v1" && value.kind === "descriptor_graph") {
    assertValid(path.relative(root, file), "https://dolly.example/spec/0.1/schemas/module-descriptor.schema.json", value.value.source_descriptor);
    assertSemantic(path.relative(root, file), actionContractSemanticErrors, value.value.source_descriptor);
  }
}

const toolBrokerConfig = JSON.parse(fs.readFileSync(
  path.join(root, "examples", "tool-broker-config.stdio.json"), "utf8",
));
const futureMcpToolBroker = structuredClone(toolBrokerConfig);
futureMcpToolBroker.servers["local-files"].protocol_version = "2026-07-28";
assertValid(
  "MCP 2026-07-28 requires a versioned Tool Broker contract",
  `${schemaBase}tool-broker-config.schema.json`,
  futureMcpToolBroker,
  false,
);
for (const [label, executable] of [
  ["absolute Tool Broker stdio executable", "/bin/tool"],
  ["parent-segment Tool Broker stdio executable", "bin/../tool"],
  ["current-segment Tool Broker stdio executable", "./tool"],
]) {
  const value = structuredClone(toolBrokerConfig);
  value.servers["local-files"].transport.executable = executable;
  assertValid(label, `${schemaBase}tool-broker-config.schema.json`, value, false);
}
const insecureHttpToolBroker = structuredClone(toolBrokerConfig);
insecureHttpToolBroker.servers["local-files"].transport = {
  kind: "streamable_http",
  endpoint: "http://tools.example.invalid/mcp",
  credential_ref: null,
  tls_spki_sha256: [],
};
assertValid(
  "non-HTTPS Tool Broker endpoint",
  `${schemaBase}tool-broker-config.schema.json`,
  insecureHttpToolBroker,
  false,
);
const credentialInToolBrokerEndpoint = structuredClone(toolBrokerConfig);
credentialInToolBrokerEndpoint.servers["local-files"].transport = {
  kind: "streamable_http",
  endpoint: "https://user:raw-secret@tools.example.invalid/mcp?token=raw-secret#fragment",
  credential_ref: null,
  tls_spki_sha256: [],
};
assertValid(
  "Tool Broker endpoint with userinfo/query remains shape-valid",
  `${schemaBase}tool-broker-config.schema.json`,
  credentialInToolBrokerEndpoint,
);
assertSemantic(
  "Tool Broker endpoint with userinfo/query/fragment",
  toolBrokerConfigSemanticErrors,
  credentialInToolBrokerEndpoint,
  false,
);
for (const [label, endpoint] of [
  ["Tool Broker endpoint with empty query delimiter", "https://tools.example.invalid/mcp?"],
  ["Tool Broker endpoint with empty fragment delimiter", "https://tools.example.invalid/mcp#"],
]) {
  const value = structuredClone(toolBrokerConfig);
  value.servers["local-files"].transport = {
    kind: "streamable_http",
    endpoint,
    credential_ref: null,
    tls_spki_sha256: [],
  };
  assertValid(`${label} remains shape-valid`, `${schemaBase}tool-broker-config.schema.json`, value);
  assertSemantic(label, toolBrokerConfigSemanticErrors, value, false);
}
for (const [label, inputSchema] of [
  ["boolean Tool Broker input schema", true],
  ["scalar-root Tool Broker input schema", { type: "string" }],
]) {
  const value = structuredClone(toolBrokerConfig);
  value.servers["local-files"].tools["read-file"].input_schema = inputSchema;
  value.servers["local-files"].tools["read-file"].input_schema_digest = canonicalDigest(inputSchema);
  assertValid(label, `${schemaBase}tool-broker-config.schema.json`, value, false);
}
for (const [label, reference] of [
  ["Tool Broker cross-document schema reference", "other-schema.json#/$defs/Input"],
  ["Tool Broker remote schema reference", "https://attacker.invalid/schema.json"],
]) {
  const value = structuredClone(toolBrokerConfig);
  const tool = value.servers["local-files"].tools["read-file"];
  tool.input_schema = { type: "object", $ref: reference };
  tool.input_schema_digest = canonicalDigest(tool.input_schema);
  assertValid(`${label} remains registry-schema-valid`, `${schemaBase}tool-broker-config.schema.json`, value);
  assertSemantic(label, toolBrokerConfigSemanticErrors, value, false);
}
for (const [label, field, invalidSchema] of [
  ["Tool Broker embedded schema invalid type keyword", "output_schema", { type: "not-a-json-schema-type" }],
  ["Tool Broker embedded schema invalid required keyword", "input_schema", { type: "object", required: "path" }],
]) {
  const value = structuredClone(toolBrokerConfig);
  const tool = value.servers["local-files"].tools["read-file"];
  tool[field] = invalidSchema;
  tool[`${field}_digest`] = canonicalDigest(invalidSchema);
  assertValid(`${label} remains registry-schema-valid`, `${schemaBase}tool-broker-config.schema.json`, value);
  assertSemantic(label, toolBrokerConfigSemanticErrors, value, false);
}

const validToolInvoke = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-tool-invoke.json"), "utf8",
)).params;
assertValid(
  "read-only Tool invoke with an idempotency key",
  `${schemaBase}tool-invoke.schema.json`,
  { ...validToolInvoke, idempotency_key: "not-authority" },
  false,
);

const validToolOperationBinding = {
  schema: "dolly.tool-operation-binding/v1",
  instance_id: "main",
  module_id: "main-brain",
  operation_id: testUuid(470),
  tool_transaction_id: testUuid(471),
  activation_id: testUuid(472),
  activation_lease_generation: 3,
  config_revision: 7,
  tool_server_id: "local-files",
  tool_name: "read-file",
  tool_schema_digest: toolBrokerConfig.servers["local-files"].tools["read-file"].input_schema_digest,
  arguments: { path: "notes/example.txt" },
  side_effect_class: "read_only",
  idempotency: { kind: "none" },
  idempotency_key: null,
  authorized_deadline: "2026-08-21T01:02:03.000000Z",
  request_digest: testDigest("1"),
  tool_server_generation: 7,
  server_request_id: testUuid(473),
  server_contract: structuredClone(toolBrokerConfig.servers["local-files"]),
  confirmation_decision: "not_required",
};
assertValid(
  "closed Tool operation binding",
  `${schemaBase}tool-operation-binding.schema.json`,
  validToolOperationBinding,
);
assertValid(
  "Tool operation binding with an undeclared field",
  `${schemaBase}tool-operation-binding.schema.json`,
  { ...validToolOperationBinding, mutable_queue_state: "ready" },
  false,
);
assertValid(
  "read-only Tool operation binding with an idempotency key",
  `${schemaBase}tool-operation-binding.schema.json`,
  { ...validToolOperationBinding, idempotency_key: "not-authority" },
  false,
);

const validAuthorizedToolLedgerRecord = {
  schema: "dolly.tool-call-ledger/v1",
  ledger_revision: 1,
  state: "AUTHORIZED",
  operation_binding: validToolOperationBinding,
  operation_digest: canonicalDigest(validToolOperationBinding),
  outbound_digest: null,
  terminal_result: null,
  terminal_result_digest: null,
};
assertValid(
  "AUTHORIZED Tool ledger record",
  `${schemaBase}tool-call-ledger-record.schema.json`,
  validAuthorizedToolLedgerRecord,
);
assertValid(
  "AUTHORIZED Tool ledger record with an outbound digest",
  `${schemaBase}tool-call-ledger-record.schema.json`,
  { ...validAuthorizedToolLedgerRecord, outbound_digest: testDigest("2") },
  false,
);

const validDispatchedToolLedgerRecord = {
  ...validAuthorizedToolLedgerRecord,
  ledger_revision: 2,
  state: "DISPATCHED",
  outbound_digest: testDigest("2"),
};
assertValid(
  "DISPATCHED Tool ledger record",
  `${schemaBase}tool-call-ledger-record.schema.json`,
  validDispatchedToolLedgerRecord,
);
assertValid(
  "DISPATCHED Tool ledger record without an outbound digest",
  `${schemaBase}tool-call-ledger-record.schema.json`,
  { ...validDispatchedToolLedgerRecord, outbound_digest: null },
  false,
);

const validToolSuccessResult = {
  operation_id: validToolOperationBinding.operation_id,
  status: "succeeded",
  output: { text: "example" },
  error: null,
  server_request_id: validToolOperationBinding.server_request_id,
};

const validSucceededToolLedgerRecord = {
  ...validDispatchedToolLedgerRecord,
  ledger_revision: 3,
  state: "SUCCEEDED",
  terminal_result: validToolSuccessResult,
  terminal_result_digest: canonicalDigest(validToolSuccessResult),
};
assertValid(
  "SUCCEEDED Tool ledger record",
  `${schemaBase}tool-call-ledger-record.schema.json`,
  validSucceededToolLedgerRecord,
);
assertValid(
  "SUCCEEDED Tool ledger record with a skipped revision",
  `${schemaBase}tool-call-ledger-record.schema.json`,
  { ...validSucceededToolLedgerRecord, ledger_revision: 4 },
  false,
);

const toolDispatchNotAppliedResult = {
  operation_id: validToolOperationBinding.operation_id,
  status: "failed",
  output: null,
  error: {
    code: "TOOL_DISPATCH_NOT_APPLIED",
    retryable: false,
    outcome: "not_applied",
    message: "The request did not cross the dispatch boundary.",
    details: {},
  },
  server_request_id: null,
};
const validPredispatchFailedToolLedgerRecord = {
  ...validAuthorizedToolLedgerRecord,
  ledger_revision: 2,
  state: "FAILED",
  terminal_result: toolDispatchNotAppliedResult,
  terminal_result_digest: canonicalDigest(toolDispatchNotAppliedResult),
};
assertValid(
  "zero-byte-proved FAILED Tool ledger record",
  `${schemaBase}tool-call-ledger-record.schema.json`,
  validPredispatchFailedToolLedgerRecord,
);
assertValid(
  "zero-byte-proved FAILED Tool ledger record with an outbound digest",
  `${schemaBase}tool-call-ledger-record.schema.json`,
  { ...validPredispatchFailedToolLedgerRecord, outbound_digest: testDigest("2") },
  false,
);

const authorityVector = JSON.parse(fs.readFileSync(
  path.join(root, "test-vectors", "core", "TST-AUTH-001-policy-binding-origin.json"),
  "utf8",
));
const validActivationPremises = authorityVector.initial.premise_record;
const authorityRecordSchema = `${schemaBase}runtime-authority-record.schema.json`;
assertValid(
  "closed Module activation premise",
  `${schemaBase}module-activation-premises.schema.json`,
  validActivationPremises,
);
assertValid("Module activation premise authority record", authorityRecordSchema, validActivationPremises);
for (const origin of authorityVector.initial.installed_components) {
  assertValid("closed installed-component origin authority record", authorityRecordSchema, origin);
}
for (const definition of validActivationPremises.permission_policy_definitions) {
  assertValid("closed permission-policy definition authority record", authorityRecordSchema, definition);
  const { definition_digest: definitionDigest, ...definitionWithoutDigest } = definition;
  const expectedDefinitionDigest = canonicalDigest(definitionWithoutDigest);
  if (definitionDigest !== expectedDefinitionDigest) {
    throw new Error(`permission-policy definition authority record digest: expected ${expectedDefinitionDigest}, got ${definitionDigest}`);
  }
}
for (const binding of validActivationPremises.permission_policy_backend_bindings) {
  assertValid("closed permission-policy backend-binding authority record", authorityRecordSchema, binding);
  const { binding_digest: bindingDigest, ...bindingWithoutDigest } = binding;
  const expectedBindingDigest = canonicalDigest(bindingWithoutDigest);
  if (bindingDigest !== expectedBindingDigest) {
    throw new Error(`permission-policy backend-binding authority record digest: expected ${expectedBindingDigest}, got ${bindingDigest}`);
  }
}
assertValid(
  "closed Linux service-candidate authority record",
  authorityRecordSchema,
  validActivationPremises.service_candidate,
);
const {
  candidate_digest: serviceCandidateDigest,
  ...serviceCandidateWithoutDigest
} = validActivationPremises.service_candidate;
const expectedServiceCandidateDigest = canonicalDigest(serviceCandidateWithoutDigest);
if (serviceCandidateDigest !== expectedServiceCandidateDigest) {
  throw new Error(`Linux service-candidate authority record digest: expected ${expectedServiceCandidateDigest}, got ${serviceCandidateDigest}`);
}
const { premises_digest: premisesDigest, ...premisesWithoutDigest } = validActivationPremises;
const expectedPremisesDigest = canonicalDigest(premisesWithoutDigest);
if (premisesDigest !== expectedPremisesDigest) {
  throw new Error(`Module activation premise authority record digest: expected ${expectedPremisesDigest}, got ${premisesDigest}`);
}
assertValid(
  "Module activation premise with an undeclared field",
  `${schemaBase}module-activation-premises.schema.json`,
  { ...validActivationPremises, current_path: "/not-authority" },
  false,
);
const {
  permission_policy_backend_bindings: validBackendBindings,
  ...premisesWithoutBackendBindings
} = validActivationPremises;
assertValid(
  "Module activation premise with the removed binding field",
  `${schemaBase}module-activation-premises.schema.json`,
  {
    ...premisesWithoutBackendBindings,
    permission_policy_bindings: validBackendBindings,
  },
  false,
);
assertValid(
  "legacy permission-policy binding schema",
  authorityRecordSchema,
  {
    ...validBackendBindings[0],
    schema: "dolly.permission-policy-binding/v1",
  },
  false,
);
assertValid(
  "service candidate without its digest",
  authorityRecordSchema,
  serviceCandidateWithoutDigest,
  false,
);

const authorityRuntimeConfig = JSON.parse(fs.readFileSync(
  path.join(root, "examples", "runtime-config.minimal.json"),
  "utf8",
));
const resolvedAuthorityConfig = {
  runtime_config: authorityRuntimeConfig,
  permission_policy_selections: [{
    policy_id: validBackendBindings[0].policy_id,
    policy_revision: validBackendBindings[0].policy_revision,
    policy_definition_digest: validBackendBindings[0].policy_definition_digest,
    binding_id: validBackendBindings[0].binding_id,
    binding_revision: validBackendBindings[0].binding_revision,
    binding_digest: validBackendBindings[0].binding_digest,
  }],
  service_candidate: validActivationPremises.service_candidate,
};
const validConfigRevisionMapping = {
  schema: "dolly.config-revision-mapping/v1",
  daemon_installation_id: validActivationPremises.daemon_installation_id,
  instance_id: validActivationPremises.instance_id,
  config_revision: validActivationPremises.config_revision,
  config_digest: canonicalDigest(resolvedAuthorityConfig),
  canonical_config: resolvedAuthorityConfig,
};
assertValid("closed config revision mapping", authorityRecordSchema, validConfigRevisionMapping);
assertValid(
  "config revision mapping with revision zero",
  authorityRecordSchema,
  { ...validConfigRevisionMapping, config_revision: 0 },
  false,
);
const validRuntimeAuthorityState = {
  schema: "dolly.runtime-authority-state/v1",
  authority_schema_version: 1,
  daemon_installation_id: validConfigRevisionMapping.daemon_installation_id,
  instance_id: validConfigRevisionMapping.instance_id,
  current_config_revision: validConfigRevisionMapping.config_revision,
  current_config_digest: validConfigRevisionMapping.config_digest,
};
assertValid("closed current Runtime authority state", authorityRecordSchema, validRuntimeAuthorityState);
assertValid(
  "unknown Runtime authority schema version",
  authorityRecordSchema,
  { ...validRuntimeAuthorityState, authority_schema_version: 2 },
  false,
);

function resolveEffectiveConfig(extensionConfig, moduleConfig) {
  return { ...structuredClone(extensionConfig), ...structuredClone(moduleConfig) };
}

const effectiveConfigVector = JSON.parse(fs.readFileSync(
  path.join(root, "test-vectors", "config", "TST-CONFIG-003-effective-config-overlay.json"),
  "utf8",
));
const frozenExtensionConfigBeforeOverlay = canonicalJson(effectiveConfigVector.initial.extension_config);
const resolvedEffectiveConfig = resolveEffectiveConfig(
  effectiveConfigVector.initial.extension_config,
  effectiveConfigVector.initial.module_config,
);
const expectedEffectiveConfig = effectiveConfigVector.expected.assertions
  .find((assertion) => assertion.path === "/effective_config")?.value;
const expectedEffectiveConfigDigest = effectiveConfigVector.expected.assertions
  .find((assertion) => assertion.path === "/effective_config_digest")?.value;
if (canonicalJson(resolvedEffectiveConfig) !== canonicalJson(expectedEffectiveConfig)) {
  throw new Error("effective config oracle: shallow overlay result differs from TST-CONFIG-003");
}
if (canonicalDigest(resolvedEffectiveConfig) !== expectedEffectiveConfigDigest) {
  throw new Error("effective config oracle: JCS digest differs from TST-CONFIG-003");
}
if (canonicalJson(effectiveConfigVector.initial.extension_config) !== frozenExtensionConfigBeforeOverlay) {
  throw new Error("effective config oracle: overlay mutated Extension configuration");
}

const descriptorFixture = JSON.parse(fs.readFileSync(
  path.join(root, "test-vectors", "fixtures", "neighbor-is-both-input-producer-and-output-consumer.json"),
  "utf8",
)).value.source_descriptor;

// TST-DESC-001 neighbor projection: the vector's expected projection groups
// MUST be schema-conformant Contract values. The activation-manifest
// projection reuses the module-descriptor Contract/ActionContract schemas, so
// validating the vector's expected values against those properties proves the
// expected manifest is acceptable and a token-injected group array (the
// previously demonstrated contradiction) cannot pass.
const descProjectionVector = JSON.parse(fs.readFileSync(
  path.join(root, "test-vectors", "core", "TST-DESC-001-neighbor-projection.json"),
  "utf8",
));
if (descProjectionVector.schema !== "dolly.test-vector/v1" || descProjectionVector.test_id !== "TST-DESC-001") {
  throw new Error("TST-DESC-001: unexpected vector identity");
}
const descAssertionValue = (suffix) => descProjectionVector.expected.assertions.find(
  (entry) => entry.path === `/manifest/neighbor_descriptors/0/projection/${suffix}`,
)?.value;
const projectedEmits = descAssertionValue("emits");
const projectedAccepts = descAssertionValue("accepts");
const projectedActions = descAssertionValue("actions");
if (
  projectedEmits === undefined ||
  projectedAccepts === undefined ||
  projectedActions === undefined
) {
  throw new Error("TST-DESC-001: projection emits/accepts/actions must be asserted");
}
for (const [group, label] of [
  [projectedEmits, "emits"],
  [projectedAccepts, "accepts"],
  [projectedActions, "actions"],
]) {
  assertValid(
    `TST-DESC-001 projection.${label}`,
    `${schemaBase}module-descriptor.schema.json#/properties/${label}`,
    group,
  );
}
if (
  canonicalJson({
    emits: projectedEmits,
    accepts: projectedAccepts,
    actions: projectedActions,
  }) !== canonicalJson({
    emits: descriptorFixture.emits,
    accepts: descriptorFixture.accepts,
    actions: descriptorFixture.actions,
  })
) {
  throw new Error("TST-DESC-001: projected groups must equal the source descriptor groups");
}
// The demonstrated contradiction — a leading string token inside the projected
// group arrays — is not a Contract/ActionContract and MUST fail the schema.
assertValid(
  "TST-DESC-001 token-injected emits",
  `${schemaBase}module-descriptor.schema.json#/properties/emits`,
  ["contract", projectedEmits],
  false,
);
assertValid(
  "TST-DESC-001 token-injected accepts",
  `${schemaBase}module-descriptor.schema.json#/properties/accepts`,
  ["contract", projectedAccepts],
  false,
);
assertValid(
  "TST-DESC-001 token-injected actions",
  `${schemaBase}module-descriptor.schema.json#/properties/actions`,
  ["authorized-contracts", ...projectedActions],
  false,
);
const frozenActionContract = structuredClone(descriptorFixture.actions[0]);
const targetedCommittedAction = {
  action_id: testUuid(250),
  name: frozenActionContract.name,
  arguments: { subject: "example" },
  target: { module_id: descriptorFixture.module_id },
  contract_binding: {
    module_id: descriptorFixture.module_id,
    descriptor_revision: descriptorFixture.descriptor_revision,
    action_contract_digest: canonicalDigest(frozenActionContract),
    action_contract: frozenActionContract,
  },
};
assertValid(
  "targeted CommittedAction with frozen contract binding",
  `${schemaBase}common.schema.json#/$defs/CommittedAction`,
  targetedCommittedAction,
);
const targetedActionWithoutBinding = structuredClone(targetedCommittedAction);
delete targetedActionWithoutBinding.contract_binding;
assertValid(
  "targeted CommittedAction without contract binding",
  `${schemaBase}common.schema.json#/$defs/CommittedAction`,
  targetedActionWithoutBinding,
  false,
);
const untargetedActionWithBinding = structuredClone(targetedCommittedAction);
delete untargetedActionWithBinding.target;
assertValid(
  "untargeted CommittedAction with contract binding",
  `${schemaBase}common.schema.json#/$defs/CommittedAction`,
  untargetedActionWithBinding,
  false,
);
const duplicateActionDescriptor = structuredClone(descriptorFixture);
duplicateActionDescriptor.actions.push({
  ...structuredClone(duplicateActionDescriptor.actions[0]),
  description: "A distinct contract with the same forbidden Action name",
});
assertValid(
  "schema-valid duplicate Action name",
  "https://dolly.example/spec/0.1/schemas/module-descriptor.schema.json",
  duplicateActionDescriptor,
);
assertSemantic("duplicate Action name", actionContractSemanticErrors, duplicateActionDescriptor, false);

const unavailableResultValidatorDescriptor = structuredClone(descriptorFixture);
unavailableResultValidatorDescriptor.actions[0].result_schema.semantic_validator.revision = 2;
assertValid(
  "schema-valid unavailable result validator",
  "https://dolly.example/spec/0.1/schemas/module-descriptor.schema.json",
  unavailableResultValidatorDescriptor,
);
assertSemantic(
  "unavailable result validator",
  actionContractSemanticErrors,
  unavailableResultValidatorDescriptor,
  false,
);
const napcatArgumentValidator = { id: "org.dolly.validator.napcatqq-action", revision: 1 };
const napcatResultValidator = { id: "org.dolly.validator.napcatqq-action-result", revision: 1 };
const napcatFixedContractRows = [
  ["org.dolly.channel.send", "schemas/channel-send.schema.json", "schemas/channel-send-result.schema.json", "non_idempotent_write", null, { id: "org.dolly.validator.channel-send-result", revision: 1 }],
  ["org.dolly.channel.qq.mailbox", "schemas/napcatqq-action.schema.json#/$defs/MailboxArgs", "schemas/napcatqq-result.schema.json#/$defs/MailboxResult", "idempotent_write", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.conversation", "schemas/napcatqq-action.schema.json#/$defs/ConversationArgs", "schemas/napcatqq-result.schema.json#/$defs/ConversationResult", "idempotent_write", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.send", "schemas/napcatqq-action.schema.json#/$defs/QqSendArgs", "schemas/napcatqq-result.schema.json#/$defs/SendResult", "non_idempotent_write", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.media", "schemas/napcatqq-action.schema.json#/$defs/MediaArgs", "schemas/napcatqq-result.schema.json#/$defs/MediaResult", "idempotent_write", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.message-control", "schemas/napcatqq-action.schema.json#/$defs/MessageControlArgs", "schemas/napcatqq-result.schema.json#/$defs/MessageControlResult", "non_idempotent_write", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.catalog", "schemas/napcatqq-action.schema.json#/$defs/CatalogArgs", "schemas/napcatqq-result.schema.json#/$defs/CatalogResult", "read_only", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.query.invoke", "schemas/napcatqq-action.schema.json#/$defs/QueryInvokeArgs", "schemas/napcatqq-result.schema.json#/$defs/InvokeResult", "read_only", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.mutate.invoke", "schemas/napcatqq-action.schema.json#/$defs/MutateInvokeArgs", "schemas/napcatqq-result.schema.json#/$defs/InvokeResult", "non_idempotent_write", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.manage.invoke", "schemas/napcatqq-action.schema.json#/$defs/ManageInvokeArgs", "schemas/napcatqq-result.schema.json#/$defs/InvokeResult", "non_idempotent_write", napcatArgumentValidator, napcatResultValidator],
  ["org.dolly.channel.qq.files.invoke", "schemas/napcatqq-action.schema.json#/$defs/FilesInvokeArgs", "schemas/napcatqq-result.schema.json#/$defs/InvokeResult", "non_idempotent_write", napcatArgumentValidator, napcatResultValidator],
];
function localActionSchemaBinding(uri, semanticValidator) {
  const bundle = localSchemaBundle(uri);
  if (bundle === null) throw new Error(`NapCat fixed contract unexpectedly uses remote schema ${uri}`);
  return { uri, schema_digest: bundle.digest, semantic_validator: semanticValidator };
}
const napcatFacadeDescriptor = {
  ...structuredClone(descriptorFixture),
  module_id: "qq-consumer-facade-a",
  descriptor_revision: 1,
  display_name: "NapCatQQ consumer facade",
  accepts: {
    summary: "Targeted QQ actions from one trusted consumer principal",
    part_kinds: ["text", "json", "asset"],
    action_names: napcatFixedContractRows.map(([name]) => name),
  },
  emits: {
    summary: "Private bounded QQ action results",
    part_kinds: ["json", "asset"],
    action_names: [],
  },
  actions: napcatFixedContractRows.map(([
    name, argumentsUri, resultUri, sideEffectClass, argumentsValidator, resultValidator,
  ]) => ({
    name,
    arguments_schema: localActionSchemaBinding(argumentsUri, argumentsValidator),
    result_schema: localActionSchemaBinding(resultUri, resultValidator),
    description: `Fixed NapCatQQ facade contract for ${name}`,
    side_effect_class: sideEffectClass,
  })),
  activation_replay_contract: {
    mode: "fenced_replay",
    evidence: "activation_ledger",
    ledger: {
      namespace: "org.dolly.channel.napcatqq.facade-activation",
      schema_version: "v1",
      location: "module_state_directory",
    },
  },
  metadata: {},
};
assertValid(
  "fixed NapCatQQ facade Descriptor",
  "https://dolly.example/spec/0.1/schemas/module-descriptor.schema.json",
  napcatFacadeDescriptor,
);
assertSemantic("fixed NapCatQQ ActionContracts", actionContractSemanticErrors, napcatFacadeDescriptor);
const unavailableNapcatArgumentValidatorDescriptor = structuredClone(napcatFacadeDescriptor);
unavailableNapcatArgumentValidatorDescriptor.actions[1].arguments_schema.semantic_validator.revision = 2;
assertSemantic(
  "unavailable NapCat argument validator",
  actionContractSemanticErrors,
  unavailableNapcatArgumentValidatorDescriptor,
  false,
);

function assertExactObjectKeys(label, value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}: expected exactly [${expected.join(", ")}], got [${actual.join(", ")}]`);
  }
}

function assertRpcIdentifier(label, value, { allowNull = false } = {}) {
  if (allowNull && value === null) return;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128) {
    throw new Error(`${label}: request/response id must be a non-empty UTF-8 string of at most 128 bytes`);
  }
}

const requestContractByMethod = new Map(rpcRegistry.requests.map((contract) => [contract.method, contract]));
const notificationContractByMethod = new Map(rpcRegistry.notifications.map((contract) => [contract.method, contract]));
const jsonRpcErrorCodes = new Set([-32700, -32600, -32601, -32602, -32603]);
for (let code = -32012; code <= -32001; code += 1) jsonRpcErrorCodes.add(code);

const rpcErrorPolicies = new Map([
  [-32700, { errorName: "parse_error", retryable: [false], outcomes: ["not_applied"], nullId: true }],
  [-32600, { errorName: "invalid_request", retryable: [false], outcomes: ["not_applied"], nullId: true }],
  [-32601, { errorName: "method_not_found", retryable: [false], outcomes: ["not_applied"] }],
  [-32602, { errorName: "invalid_params", retryable: [false], outcomes: ["not_applied"] }],
  [-32603, { errorName: "internal_error", retryable: [false], outcomes: ["not_applied", "applied", "unknown"] }],
  [-32001, { errorName: "deadline_exceeded", retryable: [false, true], outcomes: ["not_applied", "applied", "unknown"] }],
  [-32002, { errorName: "cancelled", retryable: [false, true], outcomes: ["not_applied", "applied", "unknown"] }],
  [-32003, { errorName: "not_ready", retryable: [true], outcomes: ["not_applied"] }],
  [-32004, { errorName: "capability_denied", retryable: [false], outcomes: ["not_applied"] }],
  [-32005, { errorName: "stale_generation", retryable: [false], outcomes: ["not_applied"] }],
  [-32006, { errorName: "revision_conflict", retryable: [true], outcomes: ["not_applied"] }],
  [-32007, { errorName: "temporarily_unavailable", retryable: [true], outcomes: ["not_applied"] }],
  [-32008, { errorName: "resource_exhausted", retryable: [true], outcomes: ["not_applied"] }],
  [-32009, { errorName: "quarantined", retryable: [false], outcomes: ["not_applied"] }],
  [-32010, { errorName: "state_migration_required", retryable: [false], outcomes: ["not_applied"] }],
  [-32011, { errorName: "permanent_failure", retryable: [false], outcomes: ["not_applied", "applied"] }],
  [-32012, { errorName: "protocol_version_unsupported", retryable: [false], outcomes: ["not_applied"] }],
]);

function rpcErrorSemanticErrors(error) {
  const errors = [];
  const policy = rpcErrorPolicies.get(error?.code);
  if (!policy) return ["unregistered JSON-RPC error code"];
  if (error.data?.details?.error_name !== policy.errorName) {
    errors.push(`details.error_name must be ${policy.errorName}`);
  }
  if (!policy.retryable.includes(error.data?.retryable)) {
    errors.push(`retryable is incompatible with ${policy.errorName}`);
  }
  if (!policy.outcomes.includes(error.data?.outcome)) {
    errors.push(`outcome is incompatible with ${policy.errorName}`);
  }
  return errors;
}

function rpcErrorEnvelopeSemanticErrors(response) {
  const errors = rpcErrorSemanticErrors(response?.error);
  const policy = rpcErrorPolicies.get(response?.error?.code);
  if (response?.id === null) {
    if (policy?.nullId !== true) errors.push("null id is permitted only for parse_error or invalid_request");
  } else if (typeof response?.id !== "string" || response.id.length === 0 ||
      Buffer.byteLength(response.id, "utf8") > 128) {
    errors.push("response id must be null where permitted or a non-empty UTF-8 string of at most 128 bytes");
  }
  return errors;
}

function assertProtocolExample(example) {
  const file = path.join(root, "protocol", "examples", example.name);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const label = `protocol/examples/${example.name}`;
  if (doc?.jsonrpc !== "2.0") throw new Error(`${label}: jsonrpc must equal 2.0`);

  if (example.kind === "request") {
    assertExactObjectKeys(label, doc, ["jsonrpc", "id", "method", "params"]);
    assertRpcIdentifier(`${label}.id`, doc.id);
    if (doc.method !== example.method) throw new Error(`${label}: expected method ${example.method}`);
    if (Buffer.byteLength(doc.method, "utf8") > 160) throw new Error(`${label}: method exceeds 160 bytes`);
    const contract = requestContractByMethod.get(doc.method);
    if (!contract) throw new Error(`${label}: method is not in the request registry`);
    assertValid(`${label}.params`, contract.params_schema, doc.params, example.payloadValid);
    return { id: doc.id, method: doc.method };
  }

  if (example.kind === "notification") {
    assertExactObjectKeys(label, doc, ["jsonrpc", "method", "params"]);
    if (doc.method !== example.method) throw new Error(`${label}: expected method ${example.method}`);
    if (Buffer.byteLength(doc.method, "utf8") > 160) throw new Error(`${label}: method exceeds 160 bytes`);
    const contract = notificationContractByMethod.get(doc.method);
    if (!contract) throw new Error(`${label}: method is not in the notification registry`);
    assertValid(`${label}.params`, contract.params_schema, doc.params, example.payloadValid);
    return { id: null, method: doc.method };
  }

  if (example.kind === "success") {
    const contract = requestContractByMethod.get(example.method);
    if (!contract) throw new Error(`${label}: response method is not in the request registry`);
    assertRpcIdentifier(`${label}.id`, doc.id);
    assertExactObjectKeys(label, doc, ["jsonrpc", "id", "result"]);
    assertValid(`${label}.result`, contract.result_schema, doc.result, example.payloadValid);
    return { id: doc.id, method: example.method };
  }
  if (example.kind === "error") {
    assertExactObjectKeys(label, doc, ["jsonrpc", "id", "error"]);
    assertExactObjectKeys(`${label}.error`, doc.error, ["code", "message", "data"]);
    if (!Number.isInteger(doc.error.code) || !jsonRpcErrorCodes.has(doc.error.code)) {
      throw new Error(`${label}.error.code: not a registered JSON-RPC v1 error code`);
    }
    const policy = rpcErrorPolicies.get(doc.error.code);
    assertRpcIdentifier(`${label}.id`, doc.id, { allowNull: policy?.nullId === true });
    if (doc.id === null && policy?.nullId !== true) {
      throw new Error(`${label}.id: null is permitted only for parse-error or invalid-request responses`);
    }
    if (example.method !== null && !requestContractByMethod.has(example.method)) {
      throw new Error(`${label}: response method is not in the request registry`);
    }
    if (typeof doc.error.message !== "string") throw new Error(`${label}.error.message: expected string`);
    assertValid(`${label}.error.data`, rpcRegistry.error_data_schema, doc.error.data, example.payloadValid);
    assertSemantic(`${label}.error`, rpcErrorSemanticErrors, doc.error, example.payloadValid);
    return { id: doc.id, method: example.method };
  }
  throw new Error(`${label}: unknown example kind ${example.kind}`);
}

const protocolExampleCases = [
  { name: "valid-extension-initialize.json", kind: "request", method: "extension.initialize", payloadValid: true },
  { name: "valid-extension-initialize-result.json", kind: "success", method: "extension.initialize", request: "valid-extension-initialize.json", payloadValid: true },
  { name: "valid-tool-invoke.json", kind: "request", method: "host.tool.invoke", payloadValid: true },
  { name: "valid-ingress-submit.json", kind: "request", method: "host.ingress.submit", payloadValid: true },
  { name: "valid-module-activate.json", kind: "request", method: "module.activate", payloadValid: true },
  { name: "valid-asset-status.json", kind: "request", method: "host.asset.status", payloadValid: true },
  { name: "valid-error-response.json", kind: "error", method: "host.tool.invoke", request: "valid-tool-invoke.json", payloadValid: true },
  { name: "valid-parse-error-response.json", kind: "error", method: null, payloadValid: true },
  { name: "valid-extension-ping.json", kind: "request", method: "extension.ping", payloadValid: true },
  { name: "valid-extension-ping-result.json", kind: "success", method: "extension.ping", request: "valid-extension-ping.json", payloadValid: true },
  { name: "valid-host-operation-status.json", kind: "request", method: "host.operation.status", payloadValid: true },
  { name: "valid-host-operation-status-result.json", kind: "success", method: "host.operation.status", request: "valid-host-operation-status.json", payloadValid: true },
  { name: "valid-extension-progress.json", kind: "notification", method: "extension.progress", payloadValid: true },
  { name: "invalid-host-operation-status-missing-deadline.json", kind: "request", method: "host.operation.status", payloadValid: false },
];

const jsonRpcExampleNames = fs.readdirSync(path.join(root, "protocol", "examples"))
  .filter((name) => name.endsWith(".json") && name !== "framing-cases.json")
  .sort();
const registeredExampleNames = protocolExampleCases.map((example) => example.name).sort();
if (canonicalJson(jsonRpcExampleNames) !== canonicalJson(registeredExampleNames)) {
  throw new Error("every logical protocol JSON example must have exactly one envelope validation case");
}
const validatedProtocolExamples = new Map();
for (const example of protocolExampleCases) {
  const observation = assertProtocolExample(example);
  validatedProtocolExamples.set(example.name, observation);
  if (example.request) {
    const request = validatedProtocolExamples.get(example.request);
    if (!request || request.id !== observation.id || request.method !== observation.method) {
      throw new Error(`protocol/examples/${example.name}: response id/method does not match ${example.request}`);
    }
  }
}

const validErrorEnvelope = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-error-response.json"), "utf8",
));
assertSemantic("JSON-RPC error code/name/retryable/outcome policy", rpcErrorEnvelopeSemanticErrors, validErrorEnvelope);
for (const [label, mutate] of [
  ["JSON-RPC error_name mismatch", (value) => { value.error.data.details.error_name = "not_ready"; }],
  ["JSON-RPC retryable mismatch", (value) => { value.error.data.retryable = true; }],
  ["JSON-RPC outcome mismatch", (value) => { value.error.data.outcome = "applied"; }],
  ["JSON-RPC null id on non-parse error", (value) => { value.id = null; }],
]) {
  const value = structuredClone(validErrorEnvelope);
  mutate(value);
  assertValid(`${label} ErrorData remains schema-valid`, rpcRegistry.error_data_schema, value.error.data);
  assertSemantic(label, rpcErrorEnvelopeSemanticErrors, value, false);
}
const validParseErrorEnvelope = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-parse-error-response.json"), "utf8",
));
assertSemantic("JSON-RPC parse error permits null id", rpcErrorEnvelopeSemanticErrors, validParseErrorEnvelope);

for (const name of [
  "extension-lifecycle-rpc.schema.json",
  "host-resource-rpc.schema.json",
  "host-control-rpc.schema.json",
  "host-operation-status.schema.json",
  "extension-notification-rpc.schema.json",
]) {
  assertValid(`${name} root is fail-closed`, `${schemaBase}${name}`, {}, false);
}

const invalidUnknownOperationStatus = {
  target_operation_id: "0198ab31-6c44-7e8a-b2bb-000000000208",
  target_method: "host.block.pin",
  state: "unknown",
  terminal: true,
  operation_digest: `sha256:${"1".repeat(64)}`,
  result_digest: null,
  result: null,
  error: null,
  updated_at: "2026-08-10T22:10:03.000000Z",
};
assertValid(
  "unknown generic Host operation without unknown error",
  `${schemaBase}host-operation-status.schema.json#/$defs/OperationStatusResult`,
  invalidUnknownOperationStatus,
  false,
);

const mismatchedTypedOperationResult = {
  target_operation_id: "0198ab31-6c44-7e8a-b2bb-000000000209",
  target_method: "host.block.pin",
  state: "succeeded",
  terminal: true,
  operation_digest: `sha256:${"2".repeat(64)}`,
  result_digest: `sha256:${"3".repeat(64)}`,
  result: {
    operation_id: "0198ab31-6c44-7e8a-b2bb-000000000209",
    wakeup_id: "0198ab31-6c44-7e8a-b2bb-000000000210",
    state: "scheduled",
    not_before: "2026-08-10T22:12:00.000000Z",
    expires_at: "2026-08-10T22:13:00.000000Z",
  },
  error: null,
  updated_at: "2026-08-10T22:10:04.000000Z",
};
assertValid(
  "generic Host status target/result mismatch",
  `${schemaBase}host-operation-status.schema.json#/$defs/OperationStatusResult`,
  mismatchedTypedOperationResult,
  false,
);

const absentAssetStatus = {
  import_id: "0198ab31-6c44-7e8a-b2bb-000000000211",
  state: "absent",
  terminal: false,
  asset: null,
  error: null,
};
assertValid("Asset status may be absent", `${schemaBase}asset-status.schema.json#/$defs/StatusResult`, absentAssetStatus);
assertValid("Asset import may not return absent", `${schemaBase}asset-status.schema.json#/$defs/ImportResult`, absentAssetStatus, false);

const absentToolStatus = {
  operation_id: "0198ab31-6c44-7e8a-b2bb-000000000212",
  status: "absent",
  output: null,
  error: null,
  server_request_id: null,
};
assertValid("Tool status may be absent", `${schemaBase}tool-result.schema.json#/$defs/StatusResult`, absentToolStatus);
assertValid("Tool invoke may not return absent", `${schemaBase}tool-result.schema.json#/$defs/InvokeResult`, absentToolStatus, false);

const toolErrorPolicies = new Map([
  ["TOOL_SERVER_UNAVAILABLE", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_SERVER_QUARANTINED", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_UNKNOWN", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_CAPABILITY_DENIED", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_STALE_LEASE", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_STALE_CONFIG_REVISION", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_CONFIRMATION_REQUIRED", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_CONFIRMATION_EXPIRED", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_INPUT_INVALID", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_REQUEST_LIMIT", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_IDEMPOTENCY_CONFLICT", { status: "denied", retryable: false, outcome: "not_applied" }],
  ["TOOL_DISPATCH_NOT_APPLIED", { status: "failed", retryable: false, outcome: "not_applied" }],
  ["TOOL_UPSTREAM_NOT_APPLIED", { status: "failed", retryable: false, outcome: "not_applied" }],
  ["TOOL_UPSTREAM_FAILED", { status: "failed", retryable: false, outcome: "not_applied" }],
  ["TOOL_OUTPUT_INVALID", { status: "failed", retryable: false, outcome: "applied" }],
  ["TOOL_RESPONSE_LIMIT", { status: "failed", retryable: false, outcome: "applied" }],
  ["TOOL_EXTERNAL_OUTCOME_UNKNOWN", { status: "unknown", retryable: false, outcome: "unknown" }],
]);
const toolResultSchemaDocument = schemas.find(([file]) =>
  path.basename(file) === "tool-result.schema.json")?.[1];
const schemaToolErrorCodes = new Set(
  toolResultSchemaDocument?.$defs?.ToolError?.allOf?.[1]?.properties?.code?.enum ?? [],
);
if (schemaToolErrorCodes.size !== toolErrorPolicies.size ||
    [...schemaToolErrorCodes].some((code) => !toolErrorPolicies.has(code))) {
  throw new Error("ToolResult error enum and semantic error-policy table must be identical closed sets");
}
if ([...toolErrorPolicies.values()].some((policy) => policy.retryable !== false)) {
  throw new Error("every durable error-bearing ToolResult policy must set retryable=false");
}

function toolResultSemanticErrors(result) {
  const errors = [];
  if (!["denied", "failed", "unknown"].includes(result.status)) return errors;
  const policy = toolErrorPolicies.get(result.error?.code);
  if (policy === undefined) return [`unregistered Tool error code ${result.error?.code}`];
  for (const field of ["status", "retryable", "outcome"]) {
    const actual = field === "status" ? result.status : result.error?.[field];
    if (actual !== policy[field]) errors.push(`${result.error.code} requires ${field}=${policy[field]}`);
  }
  return errors;
}

const deniedToolResult = {
  operation_id: testUuid(268),
  status: "denied",
  output: null,
  error: {
    code: "TOOL_CAPABILITY_DENIED",
    retryable: false,
    outcome: "not_applied",
    message: "The retained grant does not authorize this tool.",
    details: {},
  },
  server_request_id: null,
};
assertValid("closed denied Tool result", `${schemaBase}tool-result.schema.json`, deniedToolResult);
assertSemantic("closed denied Tool result", toolResultSemanticErrors, deniedToolResult);
const wrongToolErrorMapping = structuredClone(deniedToolResult);
wrongToolErrorMapping.status = "failed";
assertValid("wrong Tool error mapping", `${schemaBase}tool-result.schema.json`, wrongToolErrorMapping, false);
assertSemantic("wrong Tool error mapping", toolResultSemanticErrors, wrongToolErrorMapping, false);
const retryableTerminalToolResult = structuredClone(deniedToolResult);
retryableTerminalToolResult.error.retryable = true;
assertValid(
  "retryable terminal Tool result",
  `${schemaBase}tool-result.schema.json`,
  retryableTerminalToolResult,
  false,
);
assertSemantic(
  "retryable terminal Tool result",
  toolResultSemanticErrors,
  retryableTerminalToolResult,
  false,
);
const unknownToolResult = {
  operation_id: testUuid(269),
  status: "unknown",
  output: null,
  error: {
    code: "TOOL_EXTERNAL_OUTCOME_UNKNOWN",
    retryable: false,
    outcome: "unknown",
    message: "The server may have applied the operation.",
    details: {},
  },
  server_request_id: "mcp-request-unknown",
};
assertValid("closed unknown Tool result", `${schemaBase}tool-result.schema.json`, unknownToolResult);
assertSemantic("closed unknown Tool result", toolResultSemanticErrors, unknownToolResult);

function jsonPointerLookup(document, pointer) {
  let value = document;
  for (const token of pointer.slice(1).split("/").map((part) =>
    part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, token)) {
      return { found: false, value: undefined };
    }
    value = value[token];
  }
  return { found: true, value };
}

function toolInvokePairErrors(pair, context = {}) {
  const { request, result } = pair;
  const errors = [];
  errors.push(...toolResultSemanticErrors(result));
  if (result.operation_id !== request.operation_id) errors.push("Tool result operation_id does not echo the request");
  const activation = context.activation;
  if (activation !== undefined) {
    for (const [field, expected] of [
      ["module_id", activation.moduleId],
      ["activation_id", activation.activationId],
      ["config_revision", activation.configRevision],
      ["lease_token", activation.leaseToken],
    ]) {
      if (request[field] !== expected) errors.push(`Tool request ${field} does not match the retained Activation`);
    }
  }
  const server = context.registry?.servers?.[request.tool_server_id];
  if (server === undefined || !server.enabled) {
    errors.push("Tool request does not resolve to an enabled retained server alias");
    return errors;
  }
  if (!server.allowed_modules.includes(request.module_id)) {
    errors.push("requesting Module is not allowed by the retained tool server");
  }
  const tool = server.tools[request.tool_name];
  if (tool === undefined || !tool.enabled) {
    errors.push("Tool request does not resolve to an enabled retained tool alias");
    return errors;
  }
  if (request.tool_schema_digest !== tool.input_schema_digest) {
    errors.push("tool_schema_digest does not equal the retained input schema digest");
  }
  if (request.side_effect_class !== tool.side_effect_class) {
    errors.push("side_effect_class does not equal the retained tool contract");
  }
  if (tool.side_effect_class === "idempotent_write") {
    if (tool.idempotency.kind !== "argument_key") {
      errors.push("idempotent_write lacks the v1 argument_key policy");
    } else {
      const boundKey = jsonPointerLookup(request.arguments, tool.idempotency.argument_pointer);
      if (!boundKey.found || typeof boundKey.value !== "string" ||
          boundKey.value !== request.idempotency_key) {
        errors.push("configured argument_key does not equal the Tool request idempotency_key");
      }
    }
  } else if (tool.idempotency.kind !== "none" || request.idempotency_key !== null) {
    errors.push("non-idempotent-write tool must use kind=none and a null idempotency_key");
  }
  if (tool.requires_confirmation && request.confirmation_id === null) {
    errors.push("retained tool contract requires confirmation");
  }
  try {
    const validateInput = ajv.compile(tool.input_schema);
    if (!validateInput(request.arguments)) {
      errors.push(`Tool arguments fail the retained input schema: ${ajv.errorsText(validateInput.errors)}`);
    }
    if (result.status === "succeeded") {
      const validateOutput = ajv.compile(tool.output_schema);
      if (!validateOutput(result.output)) {
        errors.push(`Tool output fails the retained output schema: ${ajv.errorsText(validateOutput.errors)}`);
      }
    }
  } catch (error) {
    errors.push(`retained Tool schema did not compile: ${error.message}`);
  }
  return errors;
}

const toolInvokeRequestForPair = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-tool-invoke.json"), "utf8",
)).params;
const toolInvokeResultForPair = {
  operation_id: toolInvokeRequestForPair.operation_id,
  status: "succeeded",
  output: { text: "example contents" },
  error: null,
  server_request_id: "mcp-request-1",
};
const toolInvokeContext = {
  activation: {
    moduleId: toolInvokeRequestForPair.module_id,
    activationId: toolInvokeRequestForPair.activation_id,
    configRevision: toolInvokeRequestForPair.config_revision,
    leaseToken: toolInvokeRequestForPair.lease_token,
  },
  registry: toolBrokerConfig,
};
assertValid("host.tool.invoke paired result", `${schemaBase}tool-result.schema.json#/$defs/InvokeResult`, toolInvokeResultForPair);
assertSemantic(
  "host.tool.invoke retained Activation/registry binding",
  toolInvokePairErrors,
  { request: toolInvokeRequestForPair, result: toolInvokeResultForPair },
  true,
  toolInvokeContext,
);
for (const [label, mutate] of [
  ["Tool invoke result operation mismatch", (pair) => { pair.result.operation_id = testUuid(270); }],
  ["Tool invoke config revision mismatch", (pair) => { pair.request.config_revision += 1; }],
  ["Tool invoke Module fence mismatch", (pair) => { pair.request.module_id = "other-module"; }],
  ["Tool invoke Activation fence mismatch", (pair) => { pair.request.activation_id = testUuid(271); }],
  ["Tool invoke lease fence mismatch", (pair) => { pair.request.lease_token = `${"B".repeat(42)}A`; }],
  ["Tool invoke server alias mismatch", (pair) => { pair.request.tool_server_id = "other-server"; }],
  ["Tool invoke tool alias mismatch", (pair) => { pair.request.tool_name = "other-tool"; }],
  ["Tool invoke schema digest mismatch", (pair) => { pair.request.tool_schema_digest = testDigest("f"); }],
  ["Tool invoke side-effect class mismatch", (pair) => { pair.request.side_effect_class = "unknown"; }],
  ["Tool invoke arguments violate retained schema", (pair) => { pair.request.arguments = { wrong: true }; }],
  ["Tool invoke output violates retained schema", (pair) => { pair.result.output = { wrong: true }; }],
]) {
  const pair = structuredClone({ request: toolInvokeRequestForPair, result: toolInvokeResultForPair });
  mutate(pair);
  assertValid(`${label} request remains schema-valid`, `${schemaBase}tool-invoke.schema.json`, pair.request);
  assertValid(`${label} result remains schema-valid`, `${schemaBase}tool-result.schema.json#/$defs/InvokeResult`, pair.result);
  assertSemantic(label, toolInvokePairErrors, pair, false, toolInvokeContext);
}

const idempotentToolBroker = structuredClone(toolBrokerConfig);
const idempotentTool = idempotentToolBroker.servers["local-files"].tools["read-file"];
idempotentTool.side_effect_class = "idempotent_write";
idempotentTool.idempotency = { kind: "argument_key", argument_pointer: "/request_id" };
idempotentTool.input_schema.required.push("request_id");
idempotentTool.input_schema.properties.request_id = { type: "string", minLength: 1, maxLength: 128 };
idempotentTool.input_schema_digest = canonicalDigest(idempotentTool.input_schema);
assertValid(
  "idempotent Tool Broker argument-key policy",
  `${schemaBase}tool-broker-config.schema.json`,
  idempotentToolBroker,
);
assertSemantic(
  "idempotent Tool Broker argument-key policy",
  toolBrokerConfigSemanticErrors,
  idempotentToolBroker,
);
const idempotentInvokePair = structuredClone({
  request: toolInvokeRequestForPair,
  result: toolInvokeResultForPair,
});
idempotentInvokePair.request.arguments.request_id = "stable-request-1";
idempotentInvokePair.request.idempotency_key = "stable-request-1";
idempotentInvokePair.request.side_effect_class = "idempotent_write";
idempotentInvokePair.request.tool_schema_digest = idempotentTool.input_schema_digest;
const idempotentInvokeContext = {
  activation: toolInvokeContext.activation,
  registry: idempotentToolBroker,
};
assertValid("idempotent Tool invoke", `${schemaBase}tool-invoke.schema.json`, idempotentInvokePair.request);
assertSemantic(
  "idempotent Tool invoke argument-key binding",
  toolInvokePairErrors,
  idempotentInvokePair,
  true,
  idempotentInvokeContext,
);
const mismatchedArgumentKeyPair = structuredClone(idempotentInvokePair);
mismatchedArgumentKeyPair.request.arguments.request_id = "different-key";
assertValid(
  "schema-valid mismatched Tool argument key",
  `${schemaBase}tool-invoke.schema.json`,
  mismatchedArgumentKeyPair.request,
);
assertSemantic(
  "mismatched Tool argument key",
  toolInvokePairErrors,
  mismatchedArgumentKeyPair,
  false,
  idempotentInvokeContext,
);

function toolRequestDigest(request) {
  const params = structuredClone(request);
  delete params.operation_id;
  delete params.deadline;
  delete params.lease_token;
  return canonicalDigest({ method: "host.tool.invoke", params });
}

function toolOperationBinding(request, serverContract, toolServerGeneration, confirmationDecision) {
  return {
    schema: "dolly.tool-operation-binding/v1",
    request_digest: toolRequestDigest(request),
    tool_server_generation: toolServerGeneration,
    server_contract: structuredClone(serverContract),
    confirmation_decision: confirmationDecision,
  };
}

const preAuthorizationToolErrorCodes = new Set([
  "TOOL_SERVER_UNAVAILABLE", "TOOL_SERVER_QUARANTINED", "TOOL_UNKNOWN",
  "TOOL_CAPABILITY_DENIED", "TOOL_STALE_LEASE", "TOOL_STALE_CONFIG_REVISION",
  "TOOL_CONFIRMATION_REQUIRED", "TOOL_CONFIRMATION_EXPIRED", "TOOL_INPUT_INVALID",
  "TOOL_REQUEST_LIMIT",
]);

function toolLedgerTransitionErrors(value, context = {}) {
  const errors = [];
  const requestDigest = toolRequestDigest(value.request);
  const result = value.result;
  if (result !== null) {
    errors.push(...toolResultSemanticErrors(result));
    if (result.operation_id !== value.request.operation_id) {
      errors.push("Tool ledger transition result operation_id does not equal request identity");
    }
  }

  if (value.phase === "accept") {
    const expectedBinding = toolOperationBinding(
      value.request,
      context.retainedServerContract,
      context.toolServerGeneration,
      context.confirmationDecision,
    );
    if (value.after_row?.module_id !== value.request.module_id ||
        value.after_row?.operation_id !== value.request.operation_id) {
      errors.push("accepted Tool row identity does not equal the authenticated request identity");
    }
    if (value.after_row?.request_digest !== requestDigest) {
      errors.push("accepted Tool row request_digest mismatch");
    }
    if (canonicalJson(value.after_row?.operation_binding) !== canonicalJson(expectedBinding)) {
      errors.push("accepted Tool row does not freeze the exact operation binding");
    }
    if (value.after_row?.operation_digest !== canonicalDigest(expectedBinding)) {
      errors.push("accepted Tool row operation_digest mismatch");
    }
    if (value.after_row?.state !== "AUTHORIZED") errors.push("accepted Tool row must begin AUTHORIZED");
  } else if (value.phase === "pre_authorization_denied") {
    if (result?.status !== "denied") errors.push("pre-authorization rejection must return denied");
    if (!preAuthorizationToolErrorCodes.has(result?.error?.code)) {
      errors.push("pre-authorization no-row phase used an error that requires an existing/accepted row");
    }
    if (value.after_row !== null) errors.push("pre-authorization denial must not create a Tool row");
    if (value.operation_binding !== null || value.operation_digest !== null) {
      errors.push("pre-authorization denial must not invent a resolved operation binding");
    }
  } else if (value.phase === "existing_identity") {
    if (value.before_row?.module_id !== value.request.module_id ||
        value.before_row?.operation_id !== value.request.operation_id) {
      errors.push("existing Tool row identity does not match the request scope");
    }
    if (canonicalJson(value.after_row) !== canonicalJson(value.before_row)) {
      errors.push("existing Tool identity handling mutated the retained row");
    }
    if (value.before_row?.request_digest === requestDigest) {
      if (canonicalJson(result) !== canonicalJson(value.before_row.result)) {
        errors.push("same request_digest must return the recorded Tool result");
      }
    } else if (result?.status !== "denied" ||
               result?.error?.code !== "TOOL_IDEMPOTENCY_CONFLICT") {
      errors.push("different request_digest must return TOOL_IDEMPOTENCY_CONFLICT");
    }
  } else if (value.phase === "authorized_failure") {
    if (value.before_row?.state !== "AUTHORIZED" || value.after_row?.state !== "FAILED") {
      errors.push("proved pre-dispatch failure must transition AUTHORIZED to FAILED");
    }
    for (const field of ["module_id", "operation_id", "request_digest", "operation_digest"]) {
      if (value.after_row?.[field] !== value.before_row?.[field]) {
        errors.push(`authorized failure changed frozen ${field}`);
      }
    }
    if (canonicalJson(value.after_row?.operation_binding) !==
        canonicalJson(value.before_row?.operation_binding)) {
      errors.push("authorized failure changed the frozen operation binding");
    }
    if (value.transport_eligible_bytes !== 0 || value.transport_sent_bytes !== 0) {
      errors.push("TOOL_DISPATCH_NOT_APPLIED requires authoritative zero-byte proof");
    }
    if (result?.status !== "failed" || result?.error?.code !== "TOOL_DISPATCH_NOT_APPLIED") {
      errors.push("proved AUTHORIZED failure must return TOOL_DISPATCH_NOT_APPLIED");
    }
  } else {
    errors.push(`unknown Tool ledger transition phase ${value.phase}`);
  }
  return errors;
}

function toolGenerationCutoverErrors(value) {
  const errors = [];
  if (value.old_revision_call_capable_activations > 0) {
    if (value.old_generation_state !== "Ready") {
      errors.push("call-capable old-revision Activation requires revision-scoped Ready generation");
    }
  } else if (value.old_generation_state === "Ready" && value.cutover_committed) {
    errors.push("old generation must leave Ready after its last call-capable Activation");
  }
  if (value.new_revision_can_select_old_generation) {
    errors.push("new registry revision must not select the retained old generation");
  }
  if (value.old_generation_state === "Draining" && value.new_old_revision_dispatches > 0) {
    errors.push("Draining generation accepted a newly authorized old-revision call");
  }
  return errors;
}

assertSemantic(
  "Tool cutover retains old revision-scoped Ready generation",
  toolGenerationCutoverErrors,
  {
    cutover_committed: true,
    old_revision_call_capable_activations: 1,
    old_generation_state: "Ready",
    new_revision_can_select_old_generation: false,
    new_old_revision_dispatches: 1,
  },
);
assertSemantic(
  "Tool cutover drains generation while old Activation can call",
  toolGenerationCutoverErrors,
  {
    cutover_committed: true,
    old_revision_call_capable_activations: 1,
    old_generation_state: "Draining",
    new_revision_can_select_old_generation: false,
    new_old_revision_dispatches: 0,
  },
  false,
);
assertSemantic(
  "Tool cutover drains after last call-capable old Activation",
  toolGenerationCutoverErrors,
  {
    cutover_committed: true,
    old_revision_call_capable_activations: 0,
    old_generation_state: "Draining",
    new_revision_can_select_old_generation: false,
    new_old_revision_dispatches: 0,
  },
);

const acceptedToolBinding = toolOperationBinding(
  toolInvokeRequestForPair,
  toolBrokerConfig.servers[toolInvokeRequestForPair.tool_server_id],
  7,
  "not_required",
);
const expectedToolRequestDigest = "sha256:cca4fccd25511a562a293bf65e62241e590e95d9b48bd89aebc17cc10810031b";
const expectedToolOperationDigest = "sha256:ce298273fe95a1016c273b631b5fb1fd2b24d8784e2f309e39a4cdfc200ac14a";
if (toolRequestDigest(toolInvokeRequestForPair) !== expectedToolRequestDigest) {
  throw new Error("host.tool.invoke request_digest golden changed");
}
if (canonicalDigest(acceptedToolBinding) !== expectedToolOperationDigest) {
  throw new Error("accepted Tool operation_digest golden changed");
}
for (const field of ["operation_id", "deadline", "lease_token"]) {
  const variant = structuredClone(toolInvokeRequestForPair);
  if (field === "operation_id") variant[field] = testUuid(299);
  if (field === "deadline") variant[field] = "2026-08-10T23:59:59.000000Z";
  if (field === "lease_token") variant[field] = `${"C".repeat(42)}A`;
  if (toolRequestDigest(variant) !== expectedToolRequestDigest) {
    throw new Error(`host.tool.invoke request_digest incorrectly includes excluded ${field}`);
  }
}
for (const [label, mutate] of [
  ["arguments", (value) => { value.arguments.path = "/different"; }],
  ["config_revision", (value) => { value.config_revision += 1; }],
  ["module_id", (value) => { value.module_id = "other-module"; }],
]) {
  const variant = structuredClone(toolInvokeRequestForPair);
  mutate(variant);
  if (toolRequestDigest(variant) === expectedToolRequestDigest) {
    throw new Error(`host.tool.invoke request_digest omitted semantic ${label}`);
  }
}
const authorizedToolResult = {
  operation_id: toolInvokeRequestForPair.operation_id,
  status: "authorized",
  output: null,
  error: null,
  server_request_id: null,
};
const acceptedToolRow = {
  module_id: toolInvokeRequestForPair.module_id,
  operation_id: toolInvokeRequestForPair.operation_id,
  request_digest: toolRequestDigest(toolInvokeRequestForPair),
  operation_binding: acceptedToolBinding,
  operation_digest: canonicalDigest(acceptedToolBinding),
  state: "AUTHORIZED",
  result: authorizedToolResult,
};
const toolAcceptTransition = {
  phase: "accept",
  request: toolInvokeRequestForPair,
  after_row: acceptedToolRow,
  result: authorizedToolResult,
};
const toolAcceptanceContext = {
  retainedServerContract: toolBrokerConfig.servers[toolInvokeRequestForPair.tool_server_id],
  toolServerGeneration: 7,
  confirmationDecision: "not_required",
};
assertSemantic(
  "Tool two-stage digest acceptance",
  toolLedgerTransitionErrors,
  toolAcceptTransition,
  true,
  toolAcceptanceContext,
);
const substitutedAcceptedBinding = structuredClone(toolAcceptTransition);
substitutedAcceptedBinding.after_row.operation_binding.tool_server_generation = 8;
assertSemantic(
  "Tool accepted binding generation substitution",
  toolLedgerTransitionErrors,
  substitutedAcceptedBinding,
  false,
  toolAcceptanceContext,
);
const synchronizedAcceptedSubstitution = structuredClone(toolAcceptTransition);
synchronizedAcceptedSubstitution.after_row.operation_binding.server_contract
  .tools[toolInvokeRequestForPair.tool_name].description = "substituted retained contract";
synchronizedAcceptedSubstitution.after_row.operation_digest = canonicalDigest(
  synchronizedAcceptedSubstitution.after_row.operation_binding,
);
assertSemantic(
  "Tool accepted binding synchronized contract substitution",
  toolLedgerTransitionErrors,
  synchronizedAcceptedSubstitution,
  false,
  toolAcceptanceContext,
);

const preAuthorizationDeniedResult = {
  operation_id: toolInvokeRequestForPair.operation_id,
  status: "denied",
  output: null,
  error: {
    code: "TOOL_UNKNOWN",
    retryable: false,
    outcome: "not_applied",
    message: "The retained registry has no enabled alias.",
    details: {},
  },
  server_request_id: null,
};
const preAuthorizationDenial = {
  phase: "pre_authorization_denied",
  request: { ...toolInvokeRequestForPair, tool_name: "missing-tool" },
  after_row: null,
  operation_binding: null,
  operation_digest: null,
  result: preAuthorizationDeniedResult,
};
assertSemantic("Tool pre-authorization denial creates no row", toolLedgerTransitionErrors, preAuthorizationDenial);
const denialWithInventedRow = structuredClone(preAuthorizationDenial);
denialWithInventedRow.after_row = structuredClone(acceptedToolRow);
assertSemantic(
  "Tool pre-authorization denial with invented row",
  toolLedgerTransitionErrors,
  denialWithInventedRow,
  false,
);
const conflictWithoutExistingRow = structuredClone(preAuthorizationDenial);
conflictWithoutExistingRow.result.error.code = "TOOL_IDEMPOTENCY_CONFLICT";
assertSemantic(
  "Tool idempotency conflict without existing row",
  toolLedgerTransitionErrors,
  conflictWithoutExistingRow,
  false,
);

const sameDigestExistingIdentity = {
  phase: "existing_identity",
  request: toolInvokeRequestForPair,
  before_row: acceptedToolRow,
  after_row: structuredClone(acceptedToolRow),
  result: authorizedToolResult,
};
assertSemantic("Tool same request digest returns recorded row", toolLedgerTransitionErrors, sameDigestExistingIdentity);
const conflictingRequest = structuredClone(toolInvokeRequestForPair);
conflictingRequest.arguments = { path: "/different" };
const conflictingToolResult = {
  operation_id: toolInvokeRequestForPair.operation_id,
  status: "denied",
  output: null,
  error: {
    code: "TOOL_IDEMPOTENCY_CONFLICT",
    retryable: false,
    outcome: "not_applied",
    message: "The scoped operation identity already has different semantic bytes.",
    details: {},
  },
  server_request_id: null,
};
const conflictingExistingIdentity = {
  phase: "existing_identity",
  request: conflictingRequest,
  before_row: acceptedToolRow,
  after_row: structuredClone(acceptedToolRow),
  result: conflictingToolResult,
};
assertSemantic("Tool request-digest conflict preserves row", toolLedgerTransitionErrors, conflictingExistingIdentity);
const conflictMutatesOriginalRow = structuredClone(conflictingExistingIdentity);
conflictMutatesOriginalRow.after_row.state = "FAILED";
assertSemantic(
  "Tool request-digest conflict mutates original row",
  toolLedgerTransitionErrors,
  conflictMutatesOriginalRow,
  false,
);

const dispatchNotAppliedResult = {
  operation_id: toolInvokeRequestForPair.operation_id,
  status: "failed",
  output: null,
  error: {
    code: "TOOL_DISPATCH_NOT_APPLIED",
    retryable: false,
    outcome: "not_applied",
    message: "The frozen generation failed before the dispatch boundary.",
    details: {},
  },
  server_request_id: null,
};
const authorizedFailureTransition = {
  phase: "authorized_failure",
  request: toolInvokeRequestForPair,
  before_row: acceptedToolRow,
  after_row: { ...structuredClone(acceptedToolRow), state: "FAILED", result: dispatchNotAppliedResult },
  transport_eligible_bytes: 0,
  transport_sent_bytes: 0,
  result: dispatchNotAppliedResult,
};
assertSemantic("Tool AUTHORIZED zero-byte failure", toolLedgerTransitionErrors, authorizedFailureTransition);
const ambiguousAuthorizedFailure = structuredClone(authorizedFailureTransition);
ambiguousAuthorizedFailure.transport_eligible_bytes = 1;
assertSemantic(
  "Tool AUTHORIZED failure without zero-byte proof",
  toolLedgerTransitionErrors,
  ambiguousAuthorizedFailure,
  false,
);

function toolStatusPairErrors(pair, context = {}) {
  const errors = toolResultSemanticErrors(pair.result);
  if (pair.result.operation_id !== pair.request.target_operation_id) {
    errors.push("Tool status result operation_id does not equal target_operation_id");
  }
  if (context.authenticatedModuleId !== undefined &&
      pair.request.module_id !== context.authenticatedModuleId) {
    errors.push("Tool status request module_id does not equal the authenticated Module");
  }
  if (context.ledgerRows !== undefined) {
    const retainedRow = context.ledgerRows[pair.request.module_id]?.[pair.request.target_operation_id];
    if (retainedRow === undefined && pair.result.status !== "absent") {
      errors.push("missing Module-scoped Tool ledger row must return absent");
    }
    if (retainedRow !== undefined && pair.result.status === "absent") {
      errors.push("present Module-scoped Tool ledger row must not return absent");
    }
    if (retainedRow !== undefined && pair.result.status !== "absent" &&
        canonicalJson(pair.result) !== canonicalJson(retainedRow)) {
      errors.push("Tool status result does not equal the retained Module-scoped ledger result");
    }
  }
  return errors;
}

const toolStatusPair = {
  request: {
    operation_id: testUuid(272),
    module_id: toolInvokeRequestForPair.module_id,
    target_operation_id: toolInvokeRequestForPair.operation_id,
    deadline: "2026-08-10T22:17:30.000000Z",
  },
  result: structuredClone(toolInvokeResultForPair),
};
const toolStatusContext = {
  authenticatedModuleId: toolInvokeRequestForPair.module_id,
  ledgerRows: {
    [toolInvokeRequestForPair.module_id]: {
      [toolInvokeRequestForPair.operation_id]: structuredClone(toolInvokeResultForPair),
    },
  },
};
assertValid("host.tool.status request", `${schemaBase}tool-status-request.schema.json`, toolStatusPair.request);
assertValid("host.tool.status result", `${schemaBase}tool-result.schema.json#/$defs/StatusResult`, toolStatusPair.result);
assertSemantic("host.tool.status target binding", toolStatusPairErrors, toolStatusPair, true, toolStatusContext);
const substitutedToolStatusPair = structuredClone(toolStatusPair);
substitutedToolStatusPair.result.output.text = "substituted status output";
assertValid(
  "shape-valid substituted Tool status output",
  `${schemaBase}tool-result.schema.json#/$defs/StatusResult`,
  substitutedToolStatusPair.result,
);
assertSemantic(
  "substituted Tool status output",
  toolStatusPairErrors,
  substitutedToolStatusPair,
  false,
  toolStatusContext,
);
for (const [label, mutate] of [
  ["Tool status returned fresh read ID", (pair) => { pair.result.operation_id = pair.request.operation_id; }],
  ["Tool status target mismatch", (pair) => { pair.request.target_operation_id = testUuid(273); }],
  ["Tool status Module ownership mismatch", (pair) => { pair.request.module_id = "other-module"; }],
]) {
  const pair = structuredClone(toolStatusPair);
  mutate(pair);
  assertValid(`${label} request remains schema-valid`, `${schemaBase}tool-status-request.schema.json`, pair.request);
  assertValid(`${label} result remains schema-valid`, `${schemaBase}tool-result.schema.json#/$defs/StatusResult`, pair.result);
  assertSemantic(label, toolStatusPairErrors, pair, false, toolStatusContext);
}

const crossModuleStatusContext = {
  authenticatedModuleId: toolInvokeRequestForPair.module_id,
  ledgerRows: {
    "other-module": {
      [toolInvokeRequestForPair.operation_id]: structuredClone(toolInvokeResultForPair),
    },
  },
};
const scopedAbsentToolStatusPair = {
  request: structuredClone(toolStatusPair.request),
  result: {
    operation_id: toolInvokeRequestForPair.operation_id,
    status: "absent",
    output: null,
    error: null,
    server_request_id: null,
  },
};
assertValid(
  "cross-Module Tool status returns scoped absent",
  `${schemaBase}tool-result.schema.json#/$defs/StatusResult`,
  scopedAbsentToolStatusPair.result,
);
assertSemantic(
  "cross-Module Tool status non-disclosure",
  toolStatusPairErrors,
  scopedAbsentToolStatusPair,
  true,
  crossModuleStatusContext,
);
const leakedCrossModuleStatusPair = structuredClone(scopedAbsentToolStatusPair);
leakedCrossModuleStatusPair.result = structuredClone(toolInvokeResultForPair);
assertSemantic(
  "cross-Module Tool status existence leak",
  toolStatusPairErrors,
  leakedCrossModuleStatusPair,
  false,
  crossModuleStatusContext,
);
assertValid(
  "host.tool.status cannot return invoke-only denied",
  `${schemaBase}tool-result.schema.json#/$defs/StatusResult`,
  deniedToolResult,
  false,
);

function lifecyclePairErrors(pair, context = {}) {
  const { request, result } = pair;
  const errors = [];
  if (result.operation_id !== request.operation_id) errors.push("operation_id does not echo the request");
  if (request.module_id !== undefined && result.module_id !== undefined &&
      result.module_id !== request.module_id) {
    errors.push("module_id does not echo the request");
  }
  switch (context.method) {
    case "extension.ping":
      if (result.worker_epoch !== request.worker_epoch) errors.push("worker_epoch does not echo the ping fence");
      if (result.extension_generation !== request.extension_generation) {
        errors.push("extension_generation does not echo the ping fence");
      }
      break;
    case "module.instantiate":
      if (request.effective_config_digest !== canonicalDigest(request.effective_config)) {
        errors.push("effective_config_digest does not equal sha256(JCS(effective_config))");
      }
      if (result.state_schema_version !== request.state_schema_version) {
        errors.push("state_schema_version does not match the instantiate request");
      }
      for (const [requestField, resultField] of [
        ["config_revision", "config_revision"],
        ["effective_config_digest", "effective_config_digest"],
        ["effective_config_schema_digest", "effective_config_schema_digest"],
        ["storage_scope_id", "storage_scope_id"],
        ["storage_access_mode", "storage_access_mode"],
        ["storage_writer_generation", "storage_writer_generation"],
      ]) {
        if (request[requestField] !== result[resultField]) {
          errors.push(`${resultField} does not echo the instantiate request`);
        }
      }
      if (context.effectiveConfigSchemaDigest !== undefined &&
          request.effective_config_schema_digest !== context.effectiveConfigSchemaDigest) {
        errors.push("instantiate config schema digest does not match the Host-frozen bundle");
      }
      if (context.effectiveConfigBundle !== undefined) {
        errors.push(...configSchemaBundleErrors(
          request.effective_config,
          request.effective_config_schema_digest,
          context.effectiveConfigBundle,
          context.effectiveConfigSchemaUri,
          "instantiate effective_config",
        ));
      }
      if (result.descriptor?.module_id !== request.module_id) errors.push("descriptor is for a different Module");
      if (result.descriptor?.descriptor_revision !== request.descriptor_revision) {
        errors.push("descriptor_revision does not match the instantiate request");
      }
      break;
    case "module.prepare_config":
      {
        const paramsWithoutDigest = structuredClone(request);
        delete paramsWithoutDigest.input_digest;
        const expectedInputDigest = canonicalDigest({
          method: "module.prepare_config",
          params: paramsWithoutDigest,
        });
        if (request.input_digest !== expectedInputDigest) {
          errors.push("input_digest does not equal the domain-separated prepare params digest");
        }
      }
      if (request.target_effective_config_digest !== canonicalDigest(request.target_effective_config)) {
        errors.push("target_effective_config_digest does not equal sha256(JCS(target_effective_config))");
      }
      if (result.input_digest !== request.input_digest) errors.push("input_digest does not echo the prepared input");
      for (const field of [
        "target_config_revision", "target_effective_config_digest", "target_effective_config_schema_digest",
      ]) {
        if (result[field] !== request[field]) errors.push(`${field} does not echo the prepare request`);
      }
      if (context.effectiveConfigSchemaDigest !== undefined &&
          request.target_effective_config_schema_digest !== context.effectiveConfigSchemaDigest) {
        errors.push("prepare config schema digest does not match the Host-frozen bundle");
      }
      if (context.effectiveConfigBundle !== undefined) {
        errors.push(...configSchemaBundleErrors(
          request.target_effective_config,
          request.target_effective_config_schema_digest,
          context.effectiveConfigBundle,
          context.effectiveConfigSchemaUri,
          "prepare target_effective_config",
        ));
      }
      if (result.compatible_state_schema_min > result.compatible_state_schema_max) {
        errors.push("compatible state-schema range is inverted");
      }
      break;
    case "module.commit_config":
      if (result.config_revision !== request.target_config_revision) {
        errors.push("committed config_revision does not equal target_config_revision");
      }
      break;
    case "module.restore":
      if (request.snapshot?.module_id !== request.module_id) errors.push("restore snapshot is for a different Module");
      if (request.snapshot?.storage_scope_id !== request.target_storage_scope_id) {
        errors.push("ordinary restore snapshot scope does not equal target_storage_scope_id");
      }
      if (result.storage_scope_id !== request.target_storage_scope_id) {
        errors.push("restore result storage_scope_id does not echo the target scope");
      }
      if (context.expectedStateDigest !== undefined && result.state_digest !== context.expectedStateDigest) {
        errors.push("restored state_digest does not match the Host-verified installed state");
      }
      break;
    case "module.shutdown":
      if (result.storage_scope_id !== request.storage_scope_id) {
        errors.push("shutdown storage_scope_id does not echo the request");
      }
      if (result.storage_writer_generation !== request.storage_writer_generation) {
        errors.push("shutdown storage_writer_generation does not echo the request");
      }
      break;
    default:
      break;
  }
  return errors;
}

function assertLifecyclePairNegative(label, schemaFragment, pair, mutate, context) {
  const changed = structuredClone(pair);
  mutate(changed);
  assertValid(
    `${label} request remains schema-valid`,
    `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/${schemaFragment}Params`,
    changed.request,
  );
  assertValid(
    `${label} result remains schema-valid`,
    `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/${schemaFragment}Result`,
    changed.result,
  );
  assertSemantic(label, lifecyclePairErrors, changed, false, context);
}

function operationStatusPairErrors(pair) {
  const { request, result } = pair;
  const errors = [];
  if (result.target_operation_id !== request.target_operation_id) {
    errors.push("target_operation_id does not echo the status request");
  }
  if (result.target_method !== request.target_method) errors.push("target_method does not echo the status request");
  if (result.state === "succeeded") {
    if (result.result?.operation_id !== request.target_operation_id) {
      errors.push("typed success operation_id does not equal target_operation_id");
    }
    if (result.result?.module_id !== undefined && result.result.module_id !== request.module_id) {
      errors.push("typed success module_id does not equal the status request Module");
    }
    if (result.result?.snapshot?.module_id !== undefined &&
        result.result.snapshot.module_id !== request.module_id) {
      errors.push("typed success snapshot is for a different Module");
    }
    if (result.result?.storage_scope_id !== undefined &&
        result.result.storage_scope_id !== request.storage_scope_id) {
      errors.push("typed success storage scope does not equal the status request scope");
    }
    if (result.result?.snapshot?.storage_scope_id !== undefined &&
        result.result.snapshot.storage_scope_id !== request.storage_scope_id) {
      errors.push("typed success snapshot scope does not equal the status request scope");
    }
  }
  return errors;
}

const pingRequestForPair = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-extension-ping.json"), "utf8",
)).params;
const pingResultForPair = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-extension-ping-result.json"), "utf8",
)).result;
assertSemantic(
  "extension.ping request/result fence",
  lifecyclePairErrors,
  { request: pingRequestForPair, result: pingResultForPair },
  true,
  { method: "extension.ping" },
);
for (const [label, field, value] of [
  ["extension.ping operation mismatch", "operation_id", testUuid(290)],
  ["extension.ping Worker epoch mismatch", "worker_epoch", testUuid(291)],
  ["extension.ping generation mismatch", "extension_generation", pingResultForPair.extension_generation + 1],
]) {
  const result = { ...pingResultForPair, [field]: value };
  assertValid(
    `${label} remains schema-valid`,
    `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingResult`,
    result,
  );
  assertSemantic(
    label,
    lifecyclePairErrors,
    { request: pingRequestForPair, result },
    false,
    { method: "extension.ping" },
  );
}

const instantiateEffectiveConfig = { profile: "default" };
const instantiateConfigSchemaRoot = "urn:dolly:example:module-config";
const instantiateConfigSchemaBundle = {
  schema: "dolly.schema-bundle/v1",
  root: instantiateConfigSchemaRoot,
  resources: {
    [instantiateConfigSchemaRoot]: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: instantiateConfigSchemaRoot,
      type: "object",
      additionalProperties: false,
      required: ["profile"],
      properties: {
        profile: { type: "string", minLength: 1 },
        threshold: { type: "integer", minimum: 0 },
      },
    },
  },
};
const instantiateConfigSchemaDigest = canonicalDigest(instantiateConfigSchemaBundle);
const instantiatePair = {
  request: {
    operation_id: testUuid(280),
    module_id: descriptorFixture.module_id,
    module_type: "analyst",
    descriptor_revision: descriptorFixture.descriptor_revision,
    config_revision: 9,
    effective_config: instantiateEffectiveConfig,
    effective_config_digest: canonicalDigest(instantiateEffectiveConfig),
    effective_config_schema_digest: instantiateConfigSchemaDigest,
    state_schema_version: 1,
    storage_scope_id: testUuid(279),
    storage_access_mode: "none",
    storage_writer_generation: null,
    storage_capability: null,
    deadline: "2026-08-10T22:18:00.000000Z",
  },
  result: {
    operation_id: testUuid(280),
    module_id: descriptorFixture.module_id,
    state: "ready",
    state_schema_version: 1,
    storage_scope_id: testUuid(279),
    storage_access_mode: "none",
    storage_writer_generation: null,
    config_revision: 9,
    effective_config_digest: canonicalDigest(instantiateEffectiveConfig),
    effective_config_schema_digest: instantiateConfigSchemaDigest,
    descriptor: structuredClone(descriptorFixture),
  },
};
const instantiateContext = {
  method: "module.instantiate",
  effectiveConfigSchemaDigest: instantiateConfigSchemaDigest,
  effectiveConfigSchemaUri: instantiateConfigSchemaRoot,
  effectiveConfigBundle: instantiateConfigSchemaBundle,
};
assertValid(
  "whole-resource Extension config schema binding",
  `${schemaBase}extension-manifest.schema.json#/$defs/ConfigSchemaBinding`,
  { uri: instantiateConfigSchemaRoot, schema_digest: instantiateConfigSchemaDigest },
);
for (const [label, uri] of [
  ["fragmented Extension config schema binding", `${instantiateConfigSchemaRoot}#/$defs/Config`],
  ["queried Extension config schema binding", `${instantiateConfigSchemaRoot}?variant=strict`],
  ["relative Extension config schema binding", "schemas/module-config.json"],
]) {
  assertValid(
    label,
    `${schemaBase}extension-manifest.schema.json#/$defs/ConfigSchemaBinding`,
    { uri, schema_digest: instantiateConfigSchemaDigest },
    false,
  );
}
assertSemantic(
  "Extension config binding URI does not equal schema-bundle root",
  (value) => configSchemaBundleErrors(
    instantiateEffectiveConfig,
    canonicalDigest(value),
    value,
    "urn:dolly:example:different-config-binding",
    "Extension config",
  ),
  instantiateConfigSchemaBundle,
  false,
);
const configBundleWithDefault = structuredClone(instantiateConfigSchemaBundle);
configBundleWithDefault.resources[instantiateConfigSchemaRoot]
  .properties.threshold.default = 1;
assertSemantic(
  "Extension config schema default annotation",
  (value) => configSchemaBundleErrors(
    { profile: "default" },
    canonicalDigest(value),
    value,
    instantiateConfigSchemaRoot,
    "Extension config",
  ),
  configBundleWithDefault,
  false,
);
assertValid(
  "module.instantiate request",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleInstantiateParams`,
  instantiatePair.request,
);
assertValid(
  "module.instantiate result",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleInstantiateResult`,
  instantiatePair.result,
);
assertSemantic("module.instantiate config/identity binding", lifecyclePairErrors, instantiatePair, true, instantiateContext);
for (const [label, mutate] of [
  ["instantiate config value digest mismatch", (pair) => { pair.request.effective_config_digest = testDigest("f"); }],
  ["instantiate config revision echo mismatch", (pair) => { pair.result.config_revision += 1; }],
  ["instantiate config digest echo mismatch", (pair) => { pair.result.effective_config_digest = testDigest("f"); }],
  ["instantiate config schema echo mismatch", (pair) => { pair.result.effective_config_schema_digest = testDigest("f"); }],
  ["instantiate storage scope echo mismatch", (pair) => { pair.result.storage_scope_id = testUuid(278); }],
  ["instantiate storage access echo mismatch", (pair) => { pair.result.storage_access_mode = "read_only"; }],
  ["instantiate storage writer echo mismatch", (pair) => {
    pair.request.storage_access_mode = "active_read_write";
    pair.request.storage_writer_generation = 1;
    pair.request.storage_capability = "A".repeat(43);
    pair.result.storage_access_mode = "active_read_write";
    pair.result.storage_writer_generation = 2;
  }],
  ["instantiate untrusted config schema substitution", (pair) => {
    pair.request.effective_config_schema_digest = testDigest("f");
    pair.result.effective_config_schema_digest = testDigest("f");
  }],
  ["instantiate value violates frozen config schema", (pair) => {
    pair.request.effective_config = { profile: 7 };
    pair.request.effective_config_digest = canonicalDigest(pair.request.effective_config);
    pair.result.effective_config_digest = pair.request.effective_config_digest;
  }],
  ["instantiate descriptor Module mismatch", (pair) => { pair.result.descriptor.module_id = "other-module"; }],
  ["instantiate descriptor revision mismatch", (pair) => { pair.result.descriptor.descriptor_revision += 1; }],
]) {
  assertLifecyclePairNegative(label, "ModuleInstantiate", instantiatePair, mutate, instantiateContext);
}

const prepareEffectiveConfig = { profile: "next", threshold: 2 };
const preparePair = {
  request: {
    operation_id: testUuid(281),
    module_id: descriptorFixture.module_id,
    base_config_revision: 9,
    target_config_revision: 10,
    extension_generation: 7,
    target_effective_config: prepareEffectiveConfig,
    target_effective_config_digest: canonicalDigest(prepareEffectiveConfig),
    target_effective_config_schema_digest: instantiateConfigSchemaDigest,
    deadline: "2026-08-10T22:19:00.000000Z",
  },
  result: {
    operation_id: testUuid(281),
    module_id: descriptorFixture.module_id,
    prepare_token: "A".repeat(43),
    input_digest: null,
    change_class: "live",
    target_config_revision: 10,
    target_effective_config_digest: canonicalDigest(prepareEffectiveConfig),
    target_effective_config_schema_digest: instantiateConfigSchemaDigest,
    requires_quiescence: false,
    compatible_state_schema_min: 1,
    compatible_state_schema_max: 2,
    estimated_memory_bytes: 0,
    estimated_disk_bytes: 0,
    warnings: [],
  },
};
preparePair.request.input_digest = canonicalDigest({
  method: "module.prepare_config",
  params: structuredClone(preparePair.request),
});
preparePair.result.input_digest = preparePair.request.input_digest;
const prepareContext = {
  method: "module.prepare_config",
  effectiveConfigSchemaDigest: instantiateConfigSchemaDigest,
  effectiveConfigSchemaUri: instantiateConfigSchemaRoot,
  effectiveConfigBundle: instantiateConfigSchemaBundle,
};
assertValid(
  "module.prepare_config request",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModulePrepareConfigParams`,
  preparePair.request,
);
assertValid(
  "module.prepare_config result",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModulePrepareConfigResult`,
  preparePair.result,
);
assertSemantic("module.prepare_config value/schema/echo binding", lifecyclePairErrors, preparePair, true, prepareContext);
for (const [label, mutate] of [
  ["prepare input digest mismatch", (pair) => { pair.request.input_digest = testDigest("f"); pair.result.input_digest = testDigest("f"); }],
  ["prepare config value digest mismatch", (pair) => { pair.request.target_effective_config_digest = testDigest("f"); }],
  ["prepare input digest echo mismatch", (pair) => { pair.result.input_digest = testDigest("f"); }],
  ["prepare config revision echo mismatch", (pair) => { pair.result.target_config_revision += 1; }],
  ["prepare config digest echo mismatch", (pair) => { pair.result.target_effective_config_digest = testDigest("f"); }],
  ["prepare config schema echo mismatch", (pair) => { pair.result.target_effective_config_schema_digest = testDigest("f"); }],
  ["prepare untrusted config schema substitution", (pair) => {
    pair.request.target_effective_config_schema_digest = testDigest("f");
    pair.result.target_effective_config_schema_digest = testDigest("f");
  }],
  ["prepare inverted state-schema range", (pair) => {
    pair.result.compatible_state_schema_min = 3;
    pair.result.compatible_state_schema_max = 2;
  }],
]) {
  assertLifecyclePairNegative(label, "ModulePrepareConfig", preparePair, mutate, prepareContext);
}

const hostStatusRequestForPair = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-host-operation-status.json"), "utf8",
)).params;
const hostStatusResultForPair = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-host-operation-status-result.json"), "utf8",
)).result;
assertSemantic(
  "host.operation.status absent request/result pair",
  operationStatusPairErrors,
  { request: hostStatusRequestForPair, result: hostStatusResultForPair },
);
const mismatchedHostStatusTarget = {
  ...hostStatusResultForPair,
  target_operation_id: testUuid(292),
};
assertValid(
  "schema-valid Host status target mismatch",
  `${schemaBase}host-operation-status.schema.json#/$defs/OperationStatusResult`,
  mismatchedHostStatusTarget,
);
assertSemantic(
  "Host status target mismatch",
  operationStatusPairErrors,
  { request: hostStatusRequestForPair, result: mismatchedHostStatusTarget },
  false,
);
const succeededHostStatusResult = {
  target_operation_id: hostStatusRequestForPair.target_operation_id,
  target_method: hostStatusRequestForPair.target_method,
  state: "succeeded",
  terminal: true,
  operation_digest: testDigest("1"),
  result_digest: testDigest("2"),
  result: {
    operation_id: hostStatusRequestForPair.target_operation_id,
    pin_id: testUuid(293),
    block_id: testUuid(294),
    state: "pinned",
    expires_at: "2026-08-11T00:00:00.000000Z",
    byte_length: 3,
  },
  error: null,
  updated_at: "2026-08-10T22:10:04.000000Z",
};
assertValid(
  "succeeded Host operation status",
  `${schemaBase}host-operation-status.schema.json#/$defs/OperationStatusResult`,
  succeededHostStatusResult,
);
assertSemantic(
  "succeeded Host operation status pair",
  operationStatusPairErrors,
  { request: hostStatusRequestForPair, result: succeededHostStatusResult },
);
const mismatchedInnerHostStatus = structuredClone(succeededHostStatusResult);
mismatchedInnerHostStatus.result.operation_id = testUuid(295);
assertValid(
  "schema-valid Host status inner operation mismatch",
  `${schemaBase}host-operation-status.schema.json#/$defs/OperationStatusResult`,
  mismatchedInnerHostStatus,
);
assertSemantic(
  "Host status inner operation mismatch",
  operationStatusPairErrors,
  { request: hostStatusRequestForPair, result: mismatchedInnerHostStatus },
  false,
);

function snapshotPairErrors(pair, context = {}) {
  const { request, result } = pair;
  const snapshot = result.snapshot;
  const errors = [];
  if (result.operation_id !== request.operation_id) errors.push("snapshot operation_id does not echo the request");
  if (snapshot.module_id !== request.module_id) errors.push("snapshot Module identity does not match the request");
  if (snapshot.storage_scope_id !== request.storage_scope_id) {
    errors.push("snapshot storage_scope_id does not echo the request");
  }
  if (snapshot.config_revision !== request.config_revision) errors.push("snapshot config_revision does not match the request");
  for (const [field, expected] of [
    ["daemon_installation_id", context.daemonInstallationId],
    ["instance_id", context.instanceId],
    ["module_type", context.moduleType],
    ["storage_scope_id", context.storageScopeId],
    ["extension_id", context.extensionId],
    ["source_package_digest", context.sourcePackageDigest],
    ["source_extension_generation", context.sourceExtensionGeneration],
    ["state_schema_version", context.stateSchemaVersion],
    ["payload_digest", context.payloadDigest],
    ["byte_length", context.byteLength],
  ]) {
    if (expected !== undefined && snapshot[field] !== expected) {
      errors.push(`snapshot ${field} does not match Host-authoritative state`);
    }
  }
  if (context.payload !== undefined && canonicalJson(snapshot.payload) !== canonicalJson(context.payload)) {
    errors.push("snapshot payload reference does not match the retained Host object");
  }
  return errors;
}

function migrationPairErrors(pair, context = {}) {
  const { request, result } = pair;
  const source = request.source_snapshot;
  const target = result.snapshot;
  const report = result.report;
  const errors = [];
  if (context.sourceSnapshot !== undefined &&
      canonicalJson(source) !== canonicalJson(context.sourceSnapshot)) {
    errors.push("migration source snapshot is not the exact Host-retained envelope");
  }
  if (result.operation_id !== request.operation_id) errors.push("migration operation_id does not echo the request");
  if (target.snapshot_id === source.snapshot_id) errors.push("migration did not create a new immutable snapshot identity");
  if (target.module_id !== request.module_id) errors.push("target snapshot Module does not equal the target Module");
  if (target.storage_scope_id !== request.target_storage_scope_id) {
    errors.push("target snapshot scope does not equal target_storage_scope_id");
  }
  if (request.migration_kind === "schema_same_scope") {
    if (source.module_id !== request.module_id) errors.push("same-scope source snapshot is for a different Module");
    if (source.storage_scope_id !== request.target_storage_scope_id) {
      errors.push("schema_same_scope changed storage scope");
    }
  } else if (source.storage_scope_id === request.target_storage_scope_id) {
    errors.push("cross-scope migration did not allocate or name a distinct target scope");
  }
  if (request.migration_kind === "clone_to_fresh_scope" &&
      (target.last_activation_id !== null || target.last_operation_ids.length !== 0)) {
    errors.push("clone snapshot retained source-local activation or operation identities");
  }
  for (const field of ["module_type", "extension_id"]) {
    if (target[field] !== source[field]) errors.push(`target snapshot ${field} does not preserve implementation identity`);
  }
  if (target.source_package_digest !== request.target_package_digest) {
    errors.push("target snapshot package digest does not equal target_package_digest");
  }
  if (target.state_schema_version !== request.target_state_schema_version) {
    errors.push("target snapshot state-schema version does not equal the requested target");
  }
  if (report.source_payload_digest !== source.payload_digest) {
    errors.push("migration report source digest does not bind the source snapshot");
  }
  if (report.target_payload_digest !== target.payload_digest) {
    errors.push("migration report target digest does not bind the target snapshot");
  }
  if (report.lossy) {
    if (request.approval_id === null) errors.push("lossy migration has no approval identity");
    if (report.changes.length === 0) errors.push("lossy migration has no declared changes");
    if (request.approval_id !== null && context.migrationApprovals !== undefined) {
      const approval = context.migrationApprovals.get(request.approval_id);
      if (approval === undefined) {
        errors.push("lossy migration approval is not Host-authorized for this operation");
      } else {
        for (const [field, actual] of [
          ["operation_id", request.operation_id],
          ["module_id", request.module_id],
          ["migration_kind", request.migration_kind],
          ["target_storage_scope_id", request.target_storage_scope_id],
          ["source_snapshot_id", source.snapshot_id],
          ["source_payload_digest", source.payload_digest],
          ["target_package_digest", request.target_package_digest],
          ["target_state_schema_version", request.target_state_schema_version],
        ]) {
          if (approval[field] !== actual) errors.push(`lossy migration approval ${field} binding mismatch`);
        }
      }
    }
  }
  for (const [field, expected] of [
    ["daemon_installation_id", context.targetDaemonInstallationId],
    ["instance_id", context.targetInstanceId],
    ["source_extension_generation", context.targetExtensionGeneration],
    ["config_revision", context.targetConfigRevision],
    ["payload_digest", context.targetPayloadDigest],
    ["byte_length", context.targetByteLength],
  ]) {
    if (expected !== undefined && target[field] !== expected) {
      errors.push(`target snapshot ${field} does not match the verified staged result`);
    }
  }
  if (context.targetPayload !== undefined && canonicalJson(target.payload) !== canonicalJson(context.targetPayload)) {
    errors.push("target snapshot payload reference does not match verified staging");
  }
  return errors;
}

function makeSnapshot({
  snapshotId = testUuid(300),
  daemonInstallationId = testUuid(297),
  instanceId = "main",
  storageScopeId = testUuid(299),
  packageDigest = testDigest("1"),
  generation = 7,
  stateSchemaVersion = 1,
  configRevision = 3,
  payload = { kind: "asset", asset_id: testAssetId },
  payloadDigest = testDigest("3"),
  byteLength = 3,
} = {}) {
  return {
    snapshot_id: snapshotId,
    daemon_installation_id: daemonInstallationId,
    instance_id: instanceId,
    module_id: "web-channel",
    module_type: "channel",
    storage_scope_id: storageScopeId,
    extension_id: "org.example.channel",
    source_package_digest: packageDigest,
    source_extension_generation: generation,
    state_schema_version: stateSchemaVersion,
    config_revision: configRevision,
    last_activation_id: testUuid(301),
    last_operation_ids: [testUuid(302)],
    payload,
    payload_digest: payloadDigest,
    byte_length: byteLength,
    created_at: "2026-08-10T22:20:00.000000Z",
  };
}

const snapshotRequestForPair = {
  operation_id: testUuid(303),
  module_id: "web-channel",
  storage_scope_id: testUuid(299),
  config_revision: 3,
  reason: "upgrade",
  deadline: "2026-08-10T22:21:00.000000Z",
};
const snapshotResultForPair = {
  operation_id: snapshotRequestForPair.operation_id,
  state: "snapshotted",
  snapshot: makeSnapshot(),
};
const snapshotContext = {
  daemonInstallationId: testUuid(297),
  instanceId: "main",
  moduleType: "channel",
  storageScopeId: testUuid(299),
  extensionId: "org.example.channel",
  sourcePackageDigest: testDigest("1"),
  sourceExtensionGeneration: 7,
  stateSchemaVersion: 1,
  payload: { kind: "asset", asset_id: testAssetId },
  payloadDigest: testDigest("3"),
  byteLength: 3,
};
assertValid(
  "module.snapshot request",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleSnapshotParams`,
  snapshotRequestForPair,
);
assertValid(
  "module.snapshot result",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleSnapshotResult`,
  snapshotResultForPair,
);
assertSemantic(
  "module.snapshot request/result/Host-state binding",
  snapshotPairErrors,
  { request: snapshotRequestForPair, result: snapshotResultForPair },
  true,
  snapshotContext,
);
for (const [label, mutate] of [
  ["snapshot operation mismatch", (pair) => { pair.result.operation_id = testUuid(304); }],
  ["snapshot Module mismatch", (pair) => { pair.result.snapshot.module_id = "other-module"; }],
  ["snapshot daemon identity mismatch", (pair) => { pair.result.snapshot.daemon_installation_id = testUuid(296); }],
  ["snapshot instance identity mismatch", (pair) => { pair.result.snapshot.instance_id = "other"; }],
  ["snapshot config revision mismatch", (pair) => { pair.result.snapshot.config_revision = 4; }],
  ["snapshot Module type mismatch", (pair) => { pair.result.snapshot.module_type = "writer"; }],
  ["snapshot storage scope mismatch", (pair) => { pair.result.snapshot.storage_scope_id = testUuid(298); }],
  ["snapshot Extension identity mismatch", (pair) => { pair.result.snapshot.extension_id = "org.example.writer"; }],
  ["snapshot package digest mismatch", (pair) => { pair.result.snapshot.source_package_digest = testDigest("2"); }],
  ["snapshot generation mismatch", (pair) => { pair.result.snapshot.source_extension_generation = 8; }],
  ["snapshot state-schema mismatch", (pair) => { pair.result.snapshot.state_schema_version = 2; }],
  ["snapshot payload digest mismatch", (pair) => { pair.result.snapshot.payload_digest = testDigest("4"); }],
  ["snapshot byte length mismatch", (pair) => { pair.result.snapshot.byte_length = 4; }],
]) {
  const pair = structuredClone({ request: snapshotRequestForPair, result: snapshotResultForPair });
  mutate(pair);
  assertValid(
    `${label} remains schema-valid`,
    `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleSnapshotResult`,
    pair.result,
  );
  assertSemantic(label, snapshotPairErrors, pair, false, snapshotContext);
}

const restorePair = {
  request: {
    operation_id: testUuid(339),
    module_id: snapshotResultForPair.snapshot.module_id,
    target_storage_scope_id: snapshotResultForPair.snapshot.storage_scope_id,
    snapshot: structuredClone(snapshotResultForPair.snapshot),
    target_config_revision: 3,
    deadline: "2026-08-10T22:21:30.000000Z",
  },
  result: {
    operation_id: testUuid(339),
    module_id: snapshotResultForPair.snapshot.module_id,
    storage_scope_id: snapshotResultForPair.snapshot.storage_scope_id,
    state: "restored",
    state_digest: testDigest("9"),
    restored_at: "2026-08-10T22:21:00.000000Z",
  },
};
const restoreContext = { method: "module.restore", expectedStateDigest: testDigest("9") };
assertValid(
  "module.restore request",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleRestoreParams`,
  restorePair.request,
);
assertValid(
  "module.restore result",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleRestoreResult`,
  restorePair.result,
);
assertSemantic("module.restore scope/identity binding", lifecyclePairErrors, restorePair, true, restoreContext);
for (const [label, mutate] of [
  ["ordinary restore cross-scope target", (pair) => { pair.request.target_storage_scope_id = testUuid(340); }],
  ["restore result scope mismatch", (pair) => { pair.result.storage_scope_id = testUuid(340); }],
]) {
  assertLifecyclePairNegative(label, "ModuleRestore", restorePair, mutate, restoreContext);
}

const migrationApprovalId = testUuid(305);
const targetAssetId = `ast_b3_${"b".repeat(51)}q`;
const migrationRequestForPair = {
  operation_id: testUuid(306),
  module_id: snapshotResultForPair.snapshot.module_id,
  migration_kind: "schema_same_scope",
  source_snapshot: structuredClone(snapshotResultForPair.snapshot),
  target_storage_scope_id: snapshotResultForPair.snapshot.storage_scope_id,
  target_state_schema_version: 2,
  target_package_digest: testDigest("2"),
  approval_id: migrationApprovalId,
  deadline: "2026-08-10T22:22:00.000000Z",
};
const migrationResultForPair = {
  operation_id: migrationRequestForPair.operation_id,
  state: "migrated",
  snapshot: makeSnapshot({
    snapshotId: testUuid(307),
    packageDigest: migrationRequestForPair.target_package_digest,
    generation: 8,
    stateSchemaVersion: migrationRequestForPair.target_state_schema_version,
    payload: { kind: "asset", asset_id: targetAssetId },
    payloadDigest: testDigest("4"),
    byteLength: 4,
  }),
  report: {
    source_payload_digest: migrationRequestForPair.source_snapshot.payload_digest,
    target_payload_digest: testDigest("4"),
    lossy: true,
    changes: ["Dropped an obsolete cache-only field."],
  },
};
const migrationContext = {
  sourceSnapshot: structuredClone(migrationRequestForPair.source_snapshot),
  migrationApprovals: new Map([[
    migrationApprovalId,
    {
      operation_id: migrationRequestForPair.operation_id,
      module_id: migrationRequestForPair.module_id,
      migration_kind: migrationRequestForPair.migration_kind,
      target_storage_scope_id: migrationRequestForPair.target_storage_scope_id,
      source_snapshot_id: migrationRequestForPair.source_snapshot.snapshot_id,
      source_payload_digest: migrationRequestForPair.source_snapshot.payload_digest,
      target_package_digest: migrationRequestForPair.target_package_digest,
      target_state_schema_version: migrationRequestForPair.target_state_schema_version,
    },
  ]]),
  targetExtensionGeneration: 8,
  targetDaemonInstallationId: testUuid(297),
  targetInstanceId: "main",
  targetConfigRevision: 3,
  targetPayload: { kind: "asset", asset_id: targetAssetId },
  targetPayloadDigest: testDigest("4"),
  targetByteLength: 4,
};
assertValid(
  "module.migrate_state request",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleMigrateStateParams`,
  migrationRequestForPair,
);
assertValid(
  "module.migrate_state result",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleMigrateStateResult`,
  migrationResultForPair,
);
assertSemantic(
  "module.migrate_state approval/identity/digest binding",
  migrationPairErrors,
  { request: migrationRequestForPair, result: migrationResultForPair },
  true,
  migrationContext,
);
for (const [label, mutate] of [
  ["lossy migration without approval", (pair) => { pair.request.approval_id = null; }],
  ["migration with unrecognized approval", (pair) => { pair.request.approval_id = testUuid(308); }],
  ["migration operation mismatch", (pair) => { pair.result.operation_id = testUuid(309); }],
  ["migration source Module mismatch", (pair) => { pair.request.module_id = "other-module"; }],
  ["same-scope migration target scope mismatch", (pair) => { pair.request.target_storage_scope_id = testUuid(298); }],
  ["migration reused source snapshot ID", (pair) => { pair.result.snapshot.snapshot_id = pair.request.source_snapshot.snapshot_id; }],
  ["migration target Module identity mismatch", (pair) => { pair.result.snapshot.module_id = "other-module"; }],
  ["migration target Module type mismatch", (pair) => { pair.result.snapshot.module_type = "writer"; }],
  ["migration target Extension identity mismatch", (pair) => { pair.result.snapshot.extension_id = "org.example.writer"; }],
  ["migration target package mismatch", (pair) => { pair.result.snapshot.source_package_digest = testDigest("5"); }],
  ["migration approval target-package substitution", (pair) => {
    pair.request.target_package_digest = testDigest("5");
    pair.result.snapshot.source_package_digest = testDigest("5");
  }],
  ["migration target state-schema mismatch", (pair) => { pair.result.snapshot.state_schema_version = 3; }],
  ["migration report source digest mismatch", (pair) => { pair.result.report.source_payload_digest = testDigest("5"); }],
  ["migration retained source digest substitution", (pair) => {
    pair.request.source_snapshot.payload_digest = testDigest("5");
    pair.result.report.source_payload_digest = testDigest("5");
  }],
  ["migration report target digest mismatch", (pair) => { pair.result.report.target_payload_digest = testDigest("5"); }],
  ["migration staged payload digest mismatch", (pair) => {
    pair.result.snapshot.payload_digest = testDigest("5");
    pair.result.report.target_payload_digest = testDigest("5");
  }],
  ["migration staged byte length mismatch", (pair) => { pair.result.snapshot.byte_length = 5; }],
  ["lossy migration without change declaration", (pair) => { pair.result.report.changes = []; }],
]) {
  const pair = structuredClone({ request: migrationRequestForPair, result: migrationResultForPair });
  mutate(pair);
  assertValid(
    `${label} request remains schema-valid`,
    `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleMigrateStateParams`,
    pair.request,
  );
  assertValid(
    `${label} result remains schema-valid`,
    `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleMigrateStateResult`,
    pair.result,
  );
  assertSemantic(label, migrationPairErrors, pair, false, migrationContext);
}

const cloneMigrationPair = structuredClone({
  request: migrationRequestForPair,
  result: migrationResultForPair,
});
Object.assign(cloneMigrationPair.request, {
  operation_id: testUuid(341),
  module_id: "web-channel-clone",
  migration_kind: "clone_to_fresh_scope",
  target_storage_scope_id: testUuid(342),
  approval_id: null,
});
Object.assign(cloneMigrationPair.result, {
  operation_id: cloneMigrationPair.request.operation_id,
  snapshot: makeSnapshot({
    snapshotId: testUuid(343),
    daemonInstallationId: testUuid(344),
    instanceId: "fork",
    storageScopeId: cloneMigrationPair.request.target_storage_scope_id,
    packageDigest: cloneMigrationPair.request.target_package_digest,
    generation: 8,
    stateSchemaVersion: cloneMigrationPair.request.target_state_schema_version,
    payload: { kind: "asset", asset_id: targetAssetId },
    payloadDigest: testDigest("4"),
    byteLength: 4,
  }),
  report: {
    source_payload_digest: cloneMigrationPair.request.source_snapshot.payload_digest,
    target_payload_digest: testDigest("4"),
    lossy: false,
    changes: [],
  },
});
cloneMigrationPair.result.snapshot.module_id = cloneMigrationPair.request.module_id;
cloneMigrationPair.result.snapshot.last_activation_id = null;
cloneMigrationPair.result.snapshot.last_operation_ids = [];
const cloneMigrationContext = {
  sourceSnapshot: structuredClone(cloneMigrationPair.request.source_snapshot),
  targetDaemonInstallationId: testUuid(344),
  targetInstanceId: "fork",
  targetExtensionGeneration: 8,
  targetConfigRevision: 3,
  targetPayload: { kind: "asset", asset_id: targetAssetId },
  targetPayloadDigest: testDigest("4"),
  targetByteLength: 4,
};
assertValid(
  "module.migrate_state clone request",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleMigrateStateParams`,
  cloneMigrationPair.request,
);
assertValid(
  "module.migrate_state clone result",
  `${schemaBase}extension-lifecycle-rpc.schema.json#/$defs/ModuleMigrateStateResult`,
  cloneMigrationPair.result,
);
assertSemantic(
  "module.migrate_state clone target identity/scope binding",
  migrationPairErrors,
  cloneMigrationPair,
  true,
  cloneMigrationContext,
);

function backupManifestErrors(manifest) {
  const errors = [];
  for (const moduleId of duplicateKeys(manifest.modules, "module_id")) {
    errors.push(`duplicate backup Module ${moduleId}`);
  }
  for (const scopeId of duplicateKeys(manifest.modules, "storage_scope_id")) {
    errors.push(`duplicate backup storage scope ${scopeId}`);
  }
  for (const logicalPath of duplicateKeys(manifest.objects, "logical_path")) {
    errors.push(`duplicate backup object path ${logicalPath}`);
  }
  return errors;
}

function restorePlanErrors(plan, context) {
  const { manifest } = context;
  const errors = [];
  if (plan.backup_id !== manifest.backup_id) errors.push("restore plan names a different backup");
  if (canonicalJson(plan.source) !== canonicalJson(manifest.source)) {
    errors.push("restore source identity does not equal backup source identity");
  }
  const sourceModules = new Map(manifest.modules.map((entry) => [entry.module_id, entry]));
  const dispositions = new Map();
  const targetScopes = new Set();
  for (const disposition of plan.scope_dispositions) {
    if (dispositions.has(disposition.module_id)) errors.push(`duplicate scope disposition ${disposition.module_id}`);
    dispositions.set(disposition.module_id, disposition);
    const source = sourceModules.get(disposition.module_id);
    if (source === undefined) {
      errors.push(`scope disposition names absent Module ${disposition.module_id}`);
      continue;
    }
    if (disposition.source_storage_scope_id !== source.storage_scope_id) {
      errors.push(`${disposition.module_id} source scope does not equal manifest`);
    }
    if (plan.mode === "replace_same_identity") {
      if (disposition.disposition !== "preserve" ||
          disposition.target_storage_scope_id !== source.storage_scope_id) {
        errors.push(`${disposition.module_id} same-identity restore did not preserve scope`);
      }
    } else if (plan.mode === "isolated_snapshot_clone") {
      if (disposition.disposition !== "isolated_copy" ||
          disposition.target_storage_scope_id !== source.storage_scope_id) {
        errors.push(`${disposition.module_id} isolated clone did not preserve its private copied scope`);
      }
    } else if (disposition.disposition === "remap") {
      if (disposition.target_storage_scope_id === source.storage_scope_id) {
        errors.push(`${disposition.module_id} portable fork reused source scope`);
      }
      if (context.knownStorageScopeIds?.has(disposition.target_storage_scope_id)) {
        errors.push(`${disposition.module_id} portable fork target scope is not fresh`);
      }
      if (targetScopes.has(disposition.target_storage_scope_id)) {
        errors.push(`${disposition.module_id} portable fork target scope collides`);
      }
      targetScopes.add(disposition.target_storage_scope_id);
    }
  }
  for (const moduleId of sourceModules.keys()) {
    if (!dispositions.has(moduleId)) errors.push(`backup Module ${moduleId} has no scope disposition`);
  }
  if (plan.mode === "replace_same_identity") {
    if (canonicalJson(plan.target) !== canonicalJson(plan.source)) {
      errors.push("same-identity restore changed instance identity");
    }
  } else if (canonicalJson(plan.target) === canonicalJson(plan.source)) {
    errors.push("clone or fork reused complete source instance identity");
  }
  return errors;
}

const backupManifestFixture = {
  schema: "dolly.backup-manifest/v1",
  backup_id: testUuid(330),
  format_version: 1,
  dolly_core_version: "0.1.0",
  source: { daemon_installation_id: testUuid(331), instance_id: "main", platform: "linux-x86_64" },
  config_revision: 3,
  config_digest: testDigest("1"),
  graph_revision: 4,
  graph_digest: testDigest("2"),
  storage_schemas: [{ store_id: "core", schema_version: 1 }],
  consistency_class: "quiesced",
  cut_metadata_digest: testDigest("3"),
  modules: [{
    extension_alias: "channel-main",
    extension_id: "org.example.channel",
    package_digest: testDigest("5"),
    source_extension_generation: 7,
    module_id: "web-channel",
    module_type: "channel",
    storage_scope_id: testUuid(332),
    state_schema_version: 1,
    snapshot_id: testUuid(333),
    snapshot_payload_digest: testDigest("6"),
    last_writer_generation: 7,
    external_state_refs: [{
      reference_id: "remote-account",
      kind: "account_session",
      clone_policy: "disabled_until_rebound",
    }],
  }],
  objects: [{
    logical_path: "modules/web-channel/snapshot.bin",
    media_type: "application/octet-stream",
    byte_length: 3,
    digest: testDigest("6"),
  }],
  excluded_components: [],
  compression: "none",
  encryption: { algorithm: "none", key_reference: null },
  creation_tool: { name: "dolly-backup", version: "0.1.0" },
  created_at: "2026-08-10T22:30:00.000000Z",
  verification_result: "pass",
};
assertValid("backup manifest", `${schemaBase}backup-manifest.schema.json`, backupManifestFixture);
assertSemantic("backup manifest unique identities", backupManifestErrors, backupManifestFixture);

const replaceRestorePlan = {
  schema: "dolly.restore-plan/v1",
  operation_id: testUuid(334),
  backup_id: backupManifestFixture.backup_id,
  mode: "replace_same_identity",
  source: structuredClone(backupManifestFixture.source),
  target: structuredClone(backupManifestFixture.source),
  scope_dispositions: [{
    module_id: "web-channel",
    source_storage_scope_id: testUuid(332),
    disposition: "preserve",
    target_storage_scope_id: testUuid(332),
    migration_operation_id: null,
  }],
  source_fence_proof: {
    kind: "source_retired",
    proof_digest: testDigest("7"),
    observed_at: "2026-08-10T22:31:00.000000Z",
  },
  external_effect_policy: "restore_only_after_fence",
  deadline: "2026-08-10T22:40:00.000000Z",
};
assertValid("same-identity restore plan", `${schemaBase}restore-plan.schema.json`, replaceRestorePlan);
assertSemantic(
  "same-identity restore plan bindings",
  restorePlanErrors,
  replaceRestorePlan,
  true,
  { manifest: backupManifestFixture, knownStorageScopeIds: new Set([testUuid(332)]) },
);

const portableForkPlan = {
  ...structuredClone(replaceRestorePlan),
  operation_id: testUuid(335),
  mode: "portable_fork",
  target: { daemon_installation_id: testUuid(336), instance_id: "fork", platform: "linux-x86_64" },
  scope_dispositions: [{
    module_id: "web-channel",
    source_storage_scope_id: testUuid(332),
    disposition: "remap",
    target_storage_scope_id: testUuid(337),
    migration_operation_id: testUuid(338),
  }],
  source_fence_proof: null,
  external_effect_policy: "disabled_until_rebound",
};
assertValid("portable-fork restore plan", `${schemaBase}restore-plan.schema.json`, portableForkPlan);
assertSemantic(
  "portable-fork fresh scope",
  restorePlanErrors,
  portableForkPlan,
  true,
  { manifest: backupManifestFixture, knownStorageScopeIds: new Set([testUuid(332)]) },
);
const reusedScopeForkPlan = structuredClone(portableForkPlan);
reusedScopeForkPlan.scope_dispositions[0].target_storage_scope_id = testUuid(332);
assertValid("schema-valid portable fork with reused scope", `${schemaBase}restore-plan.schema.json`, reusedScopeForkPlan);
assertSemantic(
  "portable fork rejects reused scope",
  restorePlanErrors,
  reusedScopeForkPlan,
  false,
  { manifest: backupManifestFixture, knownStorageScopeIds: new Set([testUuid(332)]) },
);

function blockGetPairErrors(pair, context = {}) {
  const errors = [];
  if (pair.result.id !== pair.request.block_id) errors.push("returned Block id does not equal requested block_id");
  if (context.authoritativeBlock !== undefined &&
      canonicalJson(pair.result) !== canonicalJson(context.authoritativeBlock)) {
    errors.push("returned Block is not the authoritative immutable envelope");
  }
  return errors;
}

function assetGetPairErrors(pair, context = {}) {
  const { request, result } = pair;
  const errors = [];
  if (result.asset_id !== request.asset_id) errors.push("returned Asset id does not equal requested asset_id");
  if (result.delivery.kind !== request.representation) errors.push("Asset delivery kind does not equal requested representation");
  for (const [field, expected] of [
    ["media_type", context.mediaType],
    ["byte_length", context.byteLength],
    ["content_digest", context.contentDigest],
  ]) {
    if (expected !== undefined && result[field] !== expected) {
      errors.push(`Asset ${field} does not match authoritative metadata`);
    }
  }
  if (result.delivery.kind === "inline_base64") {
    const bytes = Buffer.from(result.delivery.base64, "base64");
    if (bytes.length !== result.byte_length) errors.push("decoded inline Asset length does not equal byte_length");
    if (bytes.length > request.max_inline_bytes) errors.push("decoded inline Asset exceeds max_inline_bytes");
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== result.content_digest) errors.push("inline Asset bytes do not match content_digest");
  }
  return errors;
}

const authoritativeBlock = {
  schema: "dolly.block/v1",
  id: testUuid(310),
  created_at: "2026-08-10T22:23:00.000000Z",
  creation_commit_seq: 1,
  producer: { kind: "runtime", instance_id: "instance-main" },
  trace: {
    trace_id: testUuid(311),
    root_trace_ids: [testUuid(311)],
    causal_parents: [],
    hop_count: 0,
  },
  body: { description: "", parts: [], actions: [], metadata: {}, hints: {} },
  body_digest: testDigest("6"),
  envelope_digest: testDigest("7"),
};
const blockGetRequestForPair = {
  operation_id: testUuid(312),
  module_id: "web-channel",
  block_id: authoritativeBlock.id,
  activation_id: null,
  lease_token: null,
  deadline: "2026-08-10T22:24:00.000000Z",
};
assertValid("authoritative Block", `${schemaBase}block.schema.json`, authoritativeBlock);
assertValid(
  "host.block.get request",
  `${schemaBase}host-resource-rpc.schema.json#/$defs/BlockGetParams`,
  blockGetRequestForPair,
);
assertSemantic(
  "host.block.get authoritative envelope binding",
  blockGetPairErrors,
  { request: blockGetRequestForPair, result: authoritativeBlock },
  true,
  { authoritativeBlock },
);
const wrongBlock = { ...authoritativeBlock, id: testUuid(313) };
assertValid("schema-valid wrong Block", `${schemaBase}block.schema.json`, wrongBlock);
assertSemantic(
  "host.block.get wrong Block",
  blockGetPairErrors,
  { request: blockGetRequestForPair, result: wrongBlock },
  false,
  { authoritativeBlock },
);

const inlineAssetBytes = Buffer.from("abc", "utf8");
const inlineAssetDigest = `sha256:${crypto.createHash("sha256").update(inlineAssetBytes).digest("hex")}`;
const assetGetRequestForPair = {
  operation_id: testUuid(314),
  module_id: "web-channel",
  asset_id: testAssetId,
  representation: "inline_base64",
  max_inline_bytes: 3,
  activation_id: null,
  lease_token: null,
  deadline: "2026-08-10T22:25:00.000000Z",
};
const assetGetResultForPair = {
  asset_id: testAssetId,
  media_type: "text/plain",
  byte_length: 3,
  content_digest: inlineAssetDigest,
  delivery: { kind: "inline_base64", base64: inlineAssetBytes.toString("base64") },
};
const assetContext = { mediaType: "text/plain", byteLength: 3, contentDigest: inlineAssetDigest };
assertValid(
  "host.asset.get request",
  `${schemaBase}host-resource-rpc.schema.json#/$defs/AssetGetParams`,
  assetGetRequestForPair,
);
assertValid(
  "host.asset.get result",
  `${schemaBase}host-resource-rpc.schema.json#/$defs/AssetGetResult`,
  assetGetResultForPair,
);
assertSemantic(
  "host.asset.get identity/representation/length binding",
  assetGetPairErrors,
  { request: assetGetRequestForPair, result: assetGetResultForPair },
  true,
  assetContext,
);
for (const [label, mutate] of [
  ["Asset read identity mismatch", (pair) => { pair.result.asset_id = targetAssetId; }],
  ["Asset read representation mismatch", (pair) => { pair.request.representation = "metadata"; }],
  ["Asset read decoded length mismatch", (pair) => { pair.result.byte_length = 4; }],
  ["Asset read exceeds inline limit", (pair) => { pair.request.max_inline_bytes = 2; }],
  ["Asset read content digest mismatch", (pair) => { pair.result.content_digest = testDigest("8"); }],
]) {
  const pair = structuredClone({ request: assetGetRequestForPair, result: assetGetResultForPair });
  mutate(pair);
  assertValid(
    `${label} request remains schema-valid`,
    `${schemaBase}host-resource-rpc.schema.json#/$defs/AssetGetParams`,
    pair.request,
  );
  assertValid(
    `${label} result remains schema-valid`,
    `${schemaBase}host-resource-rpc.schema.json#/$defs/AssetGetResult`,
    pair.result,
  );
  assertSemantic(label, assetGetPairErrors, pair, false, assetContext);
}

function wakeupPairErrors(pair) {
  const { request, result } = pair;
  const errors = [];
  if (request.not_before >= request.expires_at) errors.push("wakeup request expires_at must be after not_before");
  if (result.not_before >= result.expires_at) errors.push("wakeup result expires_at must be after not_before");
  if (result.operation_id !== request.operation_id) errors.push("wakeup operation_id does not echo the request");
  return errors;
}

function progressNotificationErrors(value, context = {}) {
  const errors = [];
  if (value.total !== null && value.completed > value.total) {
    errors.push("progress completed exceeds total");
  }
  const operation = context.operations?.get(value.operation_id);
  if (operation !== undefined) {
    if (operation.moduleId !== value.module_id) errors.push("progress module_id does not match the target operation");
    if (operation.method !== value.target_method) errors.push("progress target_method does not match the target operation");
  }
  return errors;
}

function cancelNotificationErrors(value, context = {}) {
  const errors = [];
  if (Buffer.byteLength(value.id, "utf8") > 128) errors.push("cancellation id exceeds the 128-byte RPC ID bound");
  if (context.receiverOutstandingIds !== undefined && !context.receiverOutstandingIds.has(value.id)) {
    errors.push("cancellation does not target a request originally sent by the receiver");
  }
  return errors;
}

function descriptorChangedNotificationErrors(value) {
  const errors = [];
  if (value.descriptor.module_id !== value.module_id) errors.push("descriptor Module identity does not match notification");
  if (value.descriptor.descriptor_revision !== value.descriptor_revision) {
    errors.push("descriptor revision does not match notification");
  }
  const digest = canonicalDigest(value.descriptor);
  if (value.descriptor_digest !== digest) errors.push("descriptor_digest does not equal sha256(JCS(descriptor))");
  return errors;
}

const wakeupRequestForPair = {
  operation_id: testUuid(330),
  module_id: "web-channel",
  idempotency_key: "refresh-catalog",
  not_before: "2026-08-10T22:30:00.000000Z",
  expires_at: "2026-08-10T22:31:00.000000Z",
  reason: "Refresh the catalog after the debounce interval.",
  replacement_policy: "keep_earliest",
  deadline: "2026-08-10T22:29:30.000000Z",
};
const wakeupResultForPair = {
  operation_id: wakeupRequestForPair.operation_id,
  wakeup_id: testUuid(331),
  state: "scheduled",
  not_before: wakeupRequestForPair.not_before,
  expires_at: wakeupRequestForPair.expires_at,
};
assertValid(
  "host.module.request_wakeup request",
  `${schemaBase}host-control-rpc.schema.json#/$defs/RequestWakeupParams`,
  wakeupRequestForPair,
);
assertValid(
  "host.module.request_wakeup result",
  `${schemaBase}host-control-rpc.schema.json#/$defs/RequestWakeupResult`,
  wakeupResultForPair,
);
assertSemantic(
  "host.module.request_wakeup ordering/identity",
  wakeupPairErrors,
  { request: wakeupRequestForPair, result: wakeupResultForPair },
);
for (const [label, mutate] of [
  ["wakeup request inverted interval", (pair) => { pair.request.expires_at = pair.request.not_before; }],
  ["wakeup result inverted interval", (pair) => { pair.result.expires_at = pair.result.not_before; }],
  ["wakeup operation mismatch", (pair) => { pair.result.operation_id = testUuid(332); }],
]) {
  const pair = structuredClone({ request: wakeupRequestForPair, result: wakeupResultForPair });
  mutate(pair);
  assertValid(
    `${label} request remains schema-valid`,
    `${schemaBase}host-control-rpc.schema.json#/$defs/RequestWakeupParams`,
    pair.request,
  );
  assertValid(
    `${label} result remains schema-valid`,
    `${schemaBase}host-control-rpc.schema.json#/$defs/RequestWakeupResult`,
    pair.result,
  );
  assertSemantic(label, wakeupPairErrors, pair, false);
}

const progressNotification = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-extension-progress.json"), "utf8",
)).params;
const progressContext = {
  operations: new Map([[
    progressNotification.operation_id,
    { moduleId: progressNotification.module_id, method: progressNotification.target_method },
  ]]),
};
assertSemantic("extension.progress operation/range binding", progressNotificationErrors, progressNotification, true, progressContext);
const excessiveProgress = { ...progressNotification, completed: progressNotification.total + 1 };
assertValid(
  "schema-valid excessive progress",
  `${schemaBase}extension-notification-rpc.schema.json#/$defs/ExtensionProgressParams`,
  excessiveProgress,
);
assertSemantic("extension.progress completed exceeds total", progressNotificationErrors, excessiveProgress, false, progressContext);
const wrongOperationProgress = { ...progressNotification, target_method: "module.restore" };
assertValid(
  "schema-valid progress target mismatch",
  `${schemaBase}extension-notification-rpc.schema.json#/$defs/ExtensionProgressParams`,
  wrongOperationProgress,
);
assertSemantic("extension.progress target mismatch", progressNotificationErrors, wrongOperationProgress, false, progressContext);

const validCancelNotification = { id: "rpc-pending-1", reason: "deadline" };
const cancelContext = { receiverOutstandingIds: new Set([validCancelNotification.id]) };
assertValid(
  "$/cancelRequest params",
  `${schemaBase}extension-notification-rpc.schema.json#/$defs/CancelRequestParams`,
  validCancelNotification,
);
assertSemantic("$/cancelRequest identity binding", cancelNotificationErrors, validCancelNotification, true, cancelContext);
const oversizedUtf8CancelId = { ...validCancelNotification, id: "é".repeat(128) };
assertValid(
  "schema-valid byte-oversized cancellation id",
  `${schemaBase}extension-notification-rpc.schema.json#/$defs/CancelRequestParams`,
  oversizedUtf8CancelId,
);
assertSemantic("byte-oversized cancellation id", cancelNotificationErrors, oversizedUtf8CancelId, false);
assertSemantic(
  "cancellation for a request not sent by receiver",
  cancelNotificationErrors,
  validCancelNotification,
  false,
  { receiverOutstandingIds: new Set() },
);

const descriptorChangedNotification = {
  module_id: descriptorFixture.module_id,
  descriptor_revision: descriptorFixture.descriptor_revision,
  descriptor_digest: canonicalDigest(descriptorFixture),
  descriptor: structuredClone(descriptorFixture),
  reason: "configuration",
  observed_at: "2026-08-10T22:32:00.000000Z",
};
assertValid(
  "descriptor.changed params",
  `${schemaBase}extension-notification-rpc.schema.json#/$defs/DescriptorChangedParams`,
  descriptorChangedNotification,
);
assertSemantic("descriptor.changed identity/digest binding", descriptorChangedNotificationErrors, descriptorChangedNotification);
const mismatchedDescriptorDigest = { ...descriptorChangedNotification, descriptor_digest: testDigest("8") };
assertValid(
  "schema-valid descriptor.changed digest mismatch",
  `${schemaBase}extension-notification-rpc.schema.json#/$defs/DescriptorChangedParams`,
  mismatchedDescriptorDigest,
);
assertSemantic("descriptor.changed digest mismatch", descriptorChangedNotificationErrors, mismatchedDescriptorDigest, false);

function duplicateKeys(items, field) {
  const duplicates = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[field])) duplicates.push(item[field]);
    seen.add(item[field]);
  }
  return duplicates;
}

function initializePairErrors(pair, context = {}) {
  const { request, result } = pair;
  const errors = [];
  const extensionConfigDigest = canonicalDigest(request.extension_config);
  if (request.extension_config_digest !== extensionConfigDigest) {
    errors.push("extension_config_digest does not equal sha256(JCS(extension_config))");
  }
  if (context.extensionConfigSchemaDigest !== undefined &&
      request.extension_config_schema_digest !== context.extensionConfigSchemaDigest) {
    errors.push("extension_config_schema_digest does not match the Host-frozen schema bundle");
  }
  if (context.extensionConfigBundle !== undefined) {
    errors.push(...configSchemaBundleErrors(
      request.extension_config,
      request.extension_config_schema_digest,
      context.extensionConfigBundle,
      context.extensionConfigSchemaUri,
      "initialize extension_config",
    ));
  }
  for (const moduleId of duplicateKeys(request.expected_modules, "module_id")) {
    errors.push(`duplicate expected module_id ${moduleId}`);
  }
  for (const handleName of duplicateKeys(request.storage_handles, "handle_name")) {
    errors.push(`duplicate storage handle_name ${handleName}`);
  }
  for (const capability of duplicateKeys(request.storage_handles, "capability")) {
    errors.push(`duplicate storage capability ${capability}`);
  }
  for (const moduleId of duplicateKeys(result.ledger_bindings, "module_id")) {
    errors.push(`duplicate ledger binding module_id ${moduleId}`);
  }

  for (const [requestField, resultField] of [
    ["expected_extension_id", "extension_id"],
    ["expected_extension_version", "extension_version"],
    ["expected_package_digest", "package_digest"],
    ["worker_epoch", "worker_epoch"],
    ["extension_generation", "extension_generation"],
    ["config_revision", "config_revision"],
    ["extension_config_digest", "extension_config_digest"],
    ["extension_config_schema_digest", "extension_config_schema_digest"],
  ]) {
    if (request[requestField] !== result[resultField]) {
      errors.push(`${resultField} does not match ${requestField}`);
    }
  }

  if (!request.offered_protocols.some((version) =>
    canonicalJson(version) === canonicalJson(result.selected_protocol))) {
    errors.push("selected_protocol was not offered");
  }
  for (const [limit, effective] of Object.entries(result.effective_limits)) {
    if (effective > request.offered_limits[limit]) {
      errors.push(`effective ${limit} exceeds offered limit`);
    }
  }

  if (!request.host.supported_sdk_abis.includes(result.sdk_abi)) {
    errors.push(`sdk_abi ${result.sdk_abi} was not offered by the Host`);
  }

  const expectedModulesById = new Map(request.expected_modules
    .map((module) => [module.module_id, module]));
  for (const module of request.expected_modules) {
    if (!result.supported_module_types.includes(module.module_type)) {
      errors.push(`expected module type ${module.module_type} is not supported`);
    }
  }
  const moduleStateHandles = new Map();
  const activeWriterScopes = new Set();
  for (const handle of request.storage_handles) {
    if (handle.scope !== "module_state_directory") continue;
    const expectedModule = expectedModulesById.get(handle.module_id);
    if (expectedModule === undefined) {
      errors.push(`module-state handle ${handle.handle_name} names unexpected Module ${handle.module_id}`);
    } else if (handle.storage_scope_id !== expectedModule.storage_scope_id) {
      errors.push(`module-state handle ${handle.handle_name} scope does not match expected Module`);
    }
    if (handle.access_mode === "active_read_write") {
      if (activeWriterScopes.has(handle.storage_scope_id)) {
        errors.push(`duplicate active writer for scope ${handle.storage_scope_id}`);
      }
      activeWriterScopes.add(handle.storage_scope_id);
      const priorGeneration = context.lastWriterGenerations?.get(handle.storage_scope_id);
      if (priorGeneration !== undefined && handle.writer_generation !== priorGeneration + 1) {
        errors.push(`active writer generation for ${handle.storage_scope_id} is not the next generation`);
      }
    }
    const handles = moduleStateHandles.get(handle.module_id) ?? [];
    handles.push(handle);
    moduleStateHandles.set(handle.module_id, handles);
  }

  const expectedLedgerModules = new Map(request.expected_modules
    .filter((module) => module.activation_replay_contract.evidence === "activation_ledger")
    .map((module) => [module.module_id, module]));
  const bindingsByModule = new Map();
  for (const binding of result.ledger_bindings) {
    const bindings = bindingsByModule.get(binding.module_id) ?? [];
    bindings.push(binding);
    bindingsByModule.set(binding.module_id, bindings);
    const expectedModule = expectedLedgerModules.get(binding.module_id);
    if (!expectedModule) {
      errors.push(`unexpected ledger binding for ${binding.module_id}`);
      continue;
    }
    if (binding.module_type !== expectedModule.module_type) {
      errors.push(`${binding.module_id} ledger binding module_type mismatch`);
    }
    if (canonicalJson(binding.ledger) !==
        canonicalJson(expectedModule.activation_replay_contract.ledger)) {
      errors.push(`${binding.module_id} ledger descriptor mismatch`);
    }
    if (binding.target_extension_generation !== result.extension_generation) {
      errors.push(`${binding.module_id} target_extension_generation mismatch`);
    }
    const stateHandles = moduleStateHandles.get(binding.module_id) ?? [];
    if (stateHandles.length !== 1) {
      errors.push(`${binding.module_id} must have exactly one exclusive module-state handle`);
    }

    const proof = context.ledgerProofs?.get(binding.module_id);
    if (proof === undefined) {
      errors.push(`${binding.module_id} has no Host-verified continuity proof`);
    } else {
      for (const field of [
        "proof_digest", "continuity", "source_extension_generation",
        "target_extension_generation", "source_state_digest", "target_state_digest",
        "migration_operation_id",
      ]) {
        if (binding[field] !== proof[field]) {
          errors.push(`${binding.module_id} ${field} does not match Host continuity proof`);
        }
      }
      if (proof.target_package_digest !== result.package_digest) {
        errors.push(`${binding.module_id} continuity proof targets a different package`);
      }
      if (stateHandles.length === 1 && proof.storage_capability !== stateHandles[0].capability) {
        errors.push(`${binding.module_id} continuity proof is not bound to the exclusive storage grant`);
      }
    }

    const priorLedger = context.priorLedgerModuleIds?.has(binding.module_id) ?? false;
    const liveReplay = context.liveReplayModuleIds?.has(binding.module_id) ?? false;
    if (binding.continuity === "initialized") {
      if (priorLedger || liveReplay) {
        errors.push(`${binding.module_id} cannot initialize over prior ledger or live replay state`);
      }
      if (binding.source_extension_generation !== null ||
          binding.source_state_digest !== null || binding.migration_operation_id !== null) {
        errors.push(`${binding.module_id} initialized continuity has source or migration fields`);
      }
    } else if (binding.continuity === "retained") {
      if (!priorLedger && !liveReplay) errors.push(`${binding.module_id} retained continuity lacks prior state`);
      if (binding.source_extension_generation === null || binding.source_state_digest === null) {
        errors.push(`${binding.module_id} retained continuity lacks source identity`);
      }
      if (binding.migration_operation_id !== null) {
        errors.push(`${binding.module_id} retained continuity has a migration operation`);
      }
      if (binding.source_state_digest !== binding.target_state_digest) {
        errors.push(`${binding.module_id} retained state digest changed`);
      }
    } else if (binding.continuity === "migrated") {
      if (!priorLedger && !liveReplay) errors.push(`${binding.module_id} migrated continuity lacks prior state`);
      if (binding.source_extension_generation === null || binding.source_state_digest === null ||
          binding.migration_operation_id === null) {
        errors.push(`${binding.module_id} migrated continuity lacks source or operation identity`);
      }
    }
  }
  for (const moduleId of expectedLedgerModules.keys()) {
    if ((bindingsByModule.get(moduleId) ?? []).length !== 1) {
      errors.push(`${moduleId} does not have exactly one ledger binding`);
    }
  }
  return errors;
}

const initializeConfigSchemaRoot = "urn:dolly:example:channel-extension-config";
const initializeConfigSchemaBundle = {
  schema: "dolly.schema-bundle/v1",
  root: initializeConfigSchemaRoot,
  resources: {
    [initializeConfigSchemaRoot]: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: initializeConfigSchemaRoot,
      type: "object",
      additionalProperties: false,
    },
  },
};
const initializeRequest = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-extension-initialize.json"), "utf8",
)).params;
const initializeResult = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-extension-initialize-result.json"), "utf8",
)).result;
const initializePair = { request: initializeRequest, result: initializeResult };
function initializeContextForBinding(binding, {
  priorLedgerModuleIds = new Set(),
  liveReplayModuleIds = new Set(),
} = {}) {
  return {
    priorLedgerModuleIds,
    liveReplayModuleIds,
    lastWriterGenerations: new Map([[binding.storage_scope_id, 2]]),
    ledgerProofs: new Map([[
      binding.module_id,
      {
        proof_digest: binding.proof_digest,
        continuity: binding.continuity,
        source_extension_generation: binding.source_extension_generation,
        target_extension_generation: binding.target_extension_generation,
        source_state_digest: binding.source_state_digest,
        target_state_digest: binding.target_state_digest,
        migration_operation_id: binding.migration_operation_id,
        target_package_digest: initializeResult.package_digest,
        storage_capability: initializeRequest.storage_handles.find(
          (handle) => handle.scope === "module_state_directory" && handle.module_id === binding.module_id,
        )?.capability,
      },
    ]]),
  };
}
const retainedInitializeContext = {
  ...initializeContextForBinding(initializeResult.ledger_bindings[0], {
    priorLedgerModuleIds: new Set(["web-channel"]),
  }),
  extensionConfigSchemaDigest: initializeRequest.extension_config_schema_digest,
  extensionConfigSchemaUri: initializeConfigSchemaRoot,
  extensionConfigBundle: initializeConfigSchemaBundle,
};
assertSemantic(
  "extension.initialize request/result pair",
  initializePairErrors,
  initializePair,
  true,
  retainedInitializeContext,
);

function assertInitializePairNegative(label, mutate, context = retainedInitializeContext) {
  const pair = structuredClone(initializePair);
  mutate(pair);
  assertValid(
    `${label} request remains schema-valid`,
    "https://dolly.example/spec/0.1/schemas/extension-initialize-request.schema.json",
    pair.request,
  );
  assertValid(
    `${label} result remains schema-valid`,
    "https://dolly.example/spec/0.1/schemas/extension-initialize-result.schema.json",
    pair.result,
  );
  assertSemantic(label, initializePairErrors, pair, false, context);
}

assertInitializePairNegative("duplicate expected module ID", (pair) => {
  pair.request.expected_modules.push(structuredClone(pair.request.expected_modules[0]));
});
assertInitializePairNegative("duplicate storage handle name", (pair) => {
  pair.request.storage_handles.push(structuredClone(pair.request.storage_handles[0]));
});
assertInitializePairNegative("duplicate ledger binding module ID", (pair) => {
  pair.result.ledger_bindings.push(structuredClone(pair.result.ledger_bindings[0]));
});
for (const [label, field, value] of [
  ["extension identity mismatch", "extension_id", "org.example.channel"],
  ["extension version mismatch", "extension_version", "1.0.1"],
  ["package digest mismatch", "package_digest", `sha256:${"e".repeat(64)}`],
  ["worker epoch mismatch", "worker_epoch", "0198ab31-6c44-7e8a-b2bb-000000000119"],
  ["extension generation mismatch", "extension_generation", 8],
]) {
  assertInitializePairNegative(label, (pair) => { pair.result[field] = value; });
}
assertInitializePairNegative("unoffered selected protocol", (pair) => {
  pair.result.selected_protocol = { major: 1, minor: 1 };
});
assertInitializePairNegative("effective limit exceeds offer", (pair) => {
  pair.result.effective_limits.max_frame_bytes += 1024;
});
assertInitializePairNegative("Extension config value digest mismatch", (pair) => {
  pair.request.extension_config_digest = testDigest("f");
});
assertInitializePairNegative("Extension config violates frozen schema", (pair) => {
  pair.request.extension_config = { unexpected: true };
  pair.request.extension_config_digest = canonicalDigest(pair.request.extension_config);
  pair.result.extension_config_digest = pair.request.extension_config_digest;
});
assertInitializePairNegative("Extension config revision echo mismatch", (pair) => {
  pair.result.config_revision += 1;
});
assertInitializePairNegative("Extension config digest echo mismatch", (pair) => {
  pair.result.extension_config_digest = testDigest("f");
});
assertInitializePairNegative("Extension config schema-digest echo mismatch", (pair) => {
  pair.result.extension_config_schema_digest = testDigest("f");
});
assertInitializePairNegative("unoffered SDK ABI", (pair) => {
  pair.result.sdk_abi = "unoffered-sdk/999";
});
assertInitializePairNegative("unsupported expected Module type", (pair) => {
  pair.result.supported_module_types = ["different-type"];
});
assertInitializePairNegative("missing exclusive ledger storage handle", (pair) => {
  pair.request.storage_handles = [];
});
assertInitializePairNegative("active writer generation skips durable successor", (pair) => {
  pair.request.storage_handles[0].writer_generation = 4;
});
assertInitializePairNegative("ledger continuity proof mismatch", (pair) => {
  pair.result.ledger_bindings[0].proof_digest = `sha256:${"f".repeat(64)}`;
});
assertInitializePairNegative("missing exact ledger binding", (pair) => {
  pair.result.ledger_bindings = [];
});
assertInitializePairNegative("extra ledger binding", (pair) => {
  pair.result.ledger_bindings.push({
    ...structuredClone(pair.result.ledger_bindings[0]),
    module_id: "unexpected-module",
  });
});
assertInitializePairNegative("ledger target generation mismatch", (pair) => {
  pair.result.ledger_bindings[0].target_extension_generation = 8;
});
assertInitializePairNegative("retained state digest mismatch", (pair) => {
  pair.result.ledger_bindings[0].target_state_digest = `sha256:${"c".repeat(64)}`;
});
assertInitializePairNegative(
  "initialized continuity over prior state",
  (pair) => {
    Object.assign(pair.result.ledger_bindings[0], {
      continuity: "initialized",
      source_extension_generation: null,
      source_state_digest: null,
      migration_operation_id: null,
    });
  },
  { priorLedgerModuleIds: new Set(["web-channel"]), liveReplayModuleIds: new Set(["web-channel"]) },
);

const initializedPair = structuredClone(initializePair);
Object.assign(initializedPair.result.ledger_bindings[0], {
  continuity: "initialized",
  source_extension_generation: null,
  source_state_digest: null,
  migration_operation_id: null,
});
assertValid(
  "initialized continuity result",
  "https://dolly.example/spec/0.1/schemas/extension-initialize-result.schema.json",
  initializedPair.result,
);
assertSemantic(
  "initialized continuity without prior state",
  initializePairErrors,
  initializedPair,
  true,
  initializeContextForBinding(initializedPair.result.ledger_bindings[0]),
);

const migratedPair = structuredClone(initializePair);
Object.assign(migratedPair.result.ledger_bindings[0], {
  continuity: "migrated",
  target_state_digest: `sha256:${"c".repeat(64)}`,
  migration_operation_id: "0198ab31-6c44-7e8a-b2bb-000000000118",
});
assertValid(
  "migrated continuity result",
  "https://dolly.example/spec/0.1/schemas/extension-initialize-result.schema.json",
  migratedPair.result,
);
assertSemantic(
  "migrated continuity with prior state",
  initializePairErrors,
  migratedPair,
  true,
  initializeContextForBinding(migratedPair.result.ledger_bindings[0], {
    priorLedgerModuleIds: new Set(["web-channel"]),
  }),
);

function activationResultSemanticErrors(value) {
  const actualDigest = canonicalDigest(value.payload);
  return value.result_digest === actualDigest
    ? []
    : [`result_digest does not equal sha256(JCS(payload)); expected ${actualDigest}`];
}

function activationRequestResultErrors(pair) {
  const { request, result } = pair;
  const errors = [];
  for (const [requestValue, resultValue, label] of [
    [request.worker_epoch, result.worker_epoch, "worker_epoch"],
    [request.extension_generation, result.extension_generation, "extension_generation"],
    [request.manifest.activation_id, result.activation_id, "activation_id"],
    [request.manifest.manifest_digest, result.manifest_digest, "manifest_digest"],
    [request.lease_generation, result.lease_generation, "lease_generation"],
    [request.lease_token, result.lease_token, "lease_token"],
  ]) {
    if (requestValue !== resultValue) errors.push(`${label} does not echo the request fence`);
  }
  errors.push(...activationResultSemanticErrors(result));
  return errors;
}

const baseActivationResult = {
  worker_epoch: "0198ab31-6c44-7e8a-b2bb-000000000110",
  extension_generation: 1,
  activation_id: "0198ab31-6c44-7e8a-b2bb-000000000111",
  manifest_digest: `sha256:${"1".repeat(64)}`,
  lease_generation: 1,
  lease_token: "A".repeat(43),
  payload: {
    status: "retryable_failure",
    output: null,
    scheduling_hint: null,
    error: { code: "RETRY", retryable: true, outcome: "not_applied", message: "retry", details: {} },
  },
  result_digest: null,
};
baseActivationResult.result_digest = canonicalDigest(baseActivationResult.payload);
assertValid("retryable ActivationResult", "https://dolly.example/spec/0.1/schemas/activation-result.schema.json", baseActivationResult);
assertSemantic("retryable ActivationResult digest", activationResultSemanticErrors, baseActivationResult);
assertValid(
  "retryable status with retryable=false",
  "https://dolly.example/spec/0.1/schemas/activation-result.schema.json",
  { ...baseActivationResult, payload: { ...baseActivationResult.payload, error: { ...baseActivationResult.payload.error, retryable: false } } },
  false,
);
assertSemantic(
  "ActivationResult payload digest mismatch",
  activationResultSemanticErrors,
  { ...baseActivationResult, result_digest: `sha256:${"2".repeat(64)}` },
  false,
);

const activationRequestForPair = JSON.parse(fs.readFileSync(
  path.join(root, "protocol", "examples", "valid-module-activate.json"), "utf8",
)).params;
const activationResultForPair = {
  worker_epoch: activationRequestForPair.worker_epoch,
  extension_generation: activationRequestForPair.extension_generation,
  activation_id: activationRequestForPair.manifest.activation_id,
  manifest_digest: activationRequestForPair.manifest.manifest_digest,
  lease_generation: activationRequestForPair.lease_generation,
  lease_token: activationRequestForPair.lease_token,
  payload: { status: "success", output: null, scheduling_hint: null, error: null },
  result_digest: null,
};
activationResultForPair.result_digest = canonicalDigest(activationResultForPair.payload);
assertValid(
  "paired module.activate result",
  "https://dolly.example/spec/0.1/schemas/activation-result.schema.json",
  activationResultForPair,
);
assertSemantic(
  "module.activate request/result fence",
  activationRequestResultErrors,
  { request: activationRequestForPair, result: activationResultForPair },
);
for (const [label, field, value] of [
  ["module.activate worker epoch mismatch", "worker_epoch", "0198ab31-6c44-7e8a-b2bb-000000000191"],
  ["module.activate Extension generation mismatch", "extension_generation", activationResultForPair.extension_generation + 1],
  ["module.activate Activation ID mismatch", "activation_id", "0198ab31-6c44-7e8a-b2bb-000000000192"],
  ["module.activate Manifest digest mismatch", "manifest_digest", `sha256:${"3".repeat(64)}`],
  ["module.activate lease generation mismatch", "lease_generation", activationResultForPair.lease_generation + 1],
  ["module.activate lease token mismatch", "lease_token", `${"B".repeat(42)}A`],
]) {
  const result = { ...activationResultForPair, [field]: value };
  assertValid(
    `${label} remains schema-valid`,
    "https://dolly.example/spec/0.1/schemas/activation-result.schema.json",
    result,
  );
  assertSemantic(label, activationRequestResultErrors, { request: activationRequestForPair, result }, false);
}

const unknownAction = {
  schema: "dolly.action-result/v1",
  action_id: "0198ab31-6c44-7e8a-b2bb-000000000112",
  status: "unknown",
  result: null,
  error: { code: "REMOTE_UNKNOWN", retryable: false, outcome: "unknown", message: "unknown", details: {} },
};
assertValid("unknown ActionResult", "https://dolly.example/spec/0.1/schemas/action-result.schema.json", unknownAction);
assertValid(
  "failed status with unknown outcome",
  "https://dolly.example/spec/0.1/schemas/action-result.schema.json",
  { ...unknownAction, status: "failed" },
  false,
);

const actionResultSchemaUri = "https://dolly.example/spec/0.1/schemas/action-result.schema.json";
function actionResultCollectionErrors(draft, context = {}) {
  const errors = [];
  const inputActions = context.inputActions ?? [];
  const inputIndex = new Map();
  for (let index = 0; index < inputActions.length; index += 1) {
    const actionId = inputActions[index].action_id;
    if (inputIndex.has(actionId)) errors.push(`input Action ${actionId} is not unique`);
    else inputIndex.set(actionId, index);
  }
  const required = new Set(context.requiredActionIds ?? []);
  const seen = new Set();
  let previousIndex = -1;
  const validateActionResult = ajv.getSchema(`${schemaBase}action-result.schema.json`);
  for (const [partIndex, part] of draft.parts.entries()) {
    if (part.kind !== "json" || part.schema_uri !== actionResultSchemaUri) continue;
    const value = part.value;
    if (!validateActionResult(value)) {
      errors.push(`parts[${partIndex}] is not a valid ActionResult: ${ajv.errorsText(validateActionResult.errors)}`);
      continue;
    }
    const index = inputIndex.get(value.action_id);
    if (index === undefined) errors.push(`ActionResult ${value.action_id} does not resolve to an applicable input Action`);
    if (seen.has(value.action_id)) errors.push(`duplicate ActionResult for ${value.action_id}`);
    seen.add(value.action_id);
    if (index !== undefined) {
      if (index <= previousIndex) errors.push(`ActionResult ${value.action_id} is out of input-Action order`);
      previousIndex = index;
    }
  }
  for (const actionId of required) {
    if (!seen.has(actionId)) errors.push(`missing required ActionResult for ${actionId}`);
  }
  return errors;
}

const actionA = { action_id: testUuid(320) };
const actionB = { action_id: testUuid(321) };
function successfulActionResult(actionId) {
  return {
    schema: "dolly.action-result/v1",
    action_id: actionId,
    status: "succeeded",
    result: { accepted: true },
    error: null,
  };
}
function actionResultPart(actionId) {
  return { kind: "json", schema_uri: actionResultSchemaUri, value: successfulActionResult(actionId) };
}
const actionResultDraft = {
  schema: "dolly.block-draft/v1",
  parts: [actionResultPart(actionA.action_id), actionResultPart(actionB.action_id)],
  actions: [],
};
const actionResultContext = {
  inputActions: [actionA, actionB],
  requiredActionIds: [actionA.action_id, actionB.action_id],
};
assertValid("ordered ActionResult draft", `${schemaBase}block-draft.schema.json`, actionResultDraft);
assertSemantic("ordered unique complete ActionResults", actionResultCollectionErrors, actionResultDraft, true, actionResultContext);
for (const [label, parts] of [
  ["duplicate ActionResult collection", [actionResultPart(actionA.action_id), actionResultPart(actionA.action_id)]],
  ["reversed ActionResult collection", [actionResultPart(actionB.action_id), actionResultPart(actionA.action_id)]],
  ["incomplete ActionResult collection", [actionResultPart(actionA.action_id)]],
  ["unknown ActionResult collection", [actionResultPart(actionA.action_id), actionResultPart(testUuid(322))]],
]) {
  const draft = { ...actionResultDraft, parts };
  assertValid(`${label} remains BlockDraft-schema-valid`, `${schemaBase}block-draft.schema.json`, draft);
  assertSemantic(label, actionResultCollectionErrors, draft, false, actionResultContext);
}

function channelSendResultErrors(value) {
  const errors = [];
  const externalIds = new Set();
  for (let index = 0; index < value.messages.length; index += 1) {
    const message = value.messages[index];
    if (message.ordinal !== index) errors.push(`messages[${index}].ordinal is not ${index}`);
    if (externalIds.has(message.external_message_id)) {
      errors.push(`duplicate external_message_id ${message.external_message_id}`);
    }
    externalIds.add(message.external_message_id);
  }
  return errors;
}

function skillsResultErrors(value, context = {}) {
  const errors = [];
  const args = context.arguments;
  if (args?.catalog_revision !== undefined && args.catalog_revision !== null &&
      value.catalog_revision !== args.catalog_revision) {
    errors.push("result catalog_revision does not equal the frozen requested revision");
  }
  if (value.schema === "dolly.skills.list-result/v1") {
    if (args?.limit !== undefined && value.entries.length > args.limit) {
      errors.push("Skills list exceeds requested limit");
    }
    for (let index = 0; index < value.entries.length; index += 1) {
      const entry = value.entries[index];
      if (entry.catalog_revision !== value.catalog_revision) {
        errors.push(`entries[${index}].catalog_revision does not equal the enclosing revision`);
      }
      if (index > 0 && value.entries[index - 1].name >= entry.name) {
        errors.push(`entries[${index - 1}] and entries[${index}] are not strictly ordered by canonical name`);
      }
    }
    return errors;
  }
  if (value.schema === "dolly.skills.resolve-result/v1") {
    if (value.entry.catalog_revision !== value.catalog_revision) {
      errors.push("resolved entry catalog_revision does not equal the enclosing revision");
    }
    if (args?.name !== undefined && value.entry.name !== args.name) {
      errors.push("resolved entry name does not equal the requested Skill name");
    }
    return errors;
  }
  if (value.schema === "dolly.skills.get-manifest-result/v1") {
    if (args?.name !== undefined && value.name !== args.name) {
      errors.push("manifest name does not equal the requested Skill name");
    }
    const bytes = Buffer.from(value.manifest_text, "utf8");
    if (bytes.toString("utf8") !== value.manifest_text) errors.push("manifest_text is not valid UTF-8 scalar text");
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== value.content_hash) errors.push("manifest content_hash does not hash manifest_text UTF-8 bytes");
    if (context.maxBytes !== undefined && bytes.length > context.maxBytes) {
      errors.push("manifest exceeds effective byte limit");
    }
    return errors;
  }
  if (value.schema !== "dolly.skills.get-resource-result/v1") {
    return ["unrecognized Skills result discriminator"];
  }
  if (args?.name !== undefined && value.name !== args.name) {
    errors.push("resource name does not equal the requested Skill name");
  }
  if (args?.relative_path !== undefined && value.relative_path !== args.relative_path) {
    errors.push("resource relative_path does not equal the requested path");
  }
  let decodedBytes;
  let decoded;
  if (value.encoding === "utf8") {
    decoded = Buffer.from(value.data, "utf8");
    if (decoded.toString("utf8") !== value.data) errors.push("utf8 resource data is not valid UTF-8 scalar text");
  } else {
    decoded = Buffer.from(value.data, "base64");
  }
  decodedBytes = decoded.length;
  if (decodedBytes !== value.returned_bytes) errors.push("returned_bytes does not equal decoded data length");
  const end = BigInt(value.offset) + BigInt(value.returned_bytes);
  if (end > BigInt(Number.MAX_SAFE_INTEGER)) errors.push("offset + returned_bytes overflows Core safe integer");
  if (end > BigInt(value.total_bytes)) errors.push("returned range exceeds total_bytes");
  if (value.truncated !== (end < BigInt(value.total_bytes))) errors.push("truncated does not match remaining bytes");
  const requestedRange = context.arguments?.byte_range;
  if (requestedRange === null) {
    if (value.offset !== 0) errors.push("unranged read must start at offset zero");
  } else if (requestedRange !== undefined) {
    if (value.offset !== requestedRange.offset) errors.push("result offset does not equal requested offset");
    if (value.returned_bytes > requestedRange.length) errors.push("result exceeds requested byte-range length");
  }
  if (context.maxBytes !== undefined && value.returned_bytes > context.maxBytes) {
    errors.push("result exceeds effective byte limit");
  }
  if (context.expectedContentHash !== undefined && value.content_hash !== context.expectedContentHash) {
    errors.push("content_hash does not equal the frozen catalog resource hash");
  }
  if (value.offset === 0 && value.returned_bytes === value.total_bytes && !value.truncated) {
    const digest = `sha256:${crypto.createHash("sha256").update(decoded).digest("hex")}`;
    if (digest !== value.content_hash) errors.push("complete resource content_hash does not hash decoded data");
  }
  return errors;
}

function compareAlarmRecordKeys(left, right) {
  if (left.next_occurrence === null && right.next_occurrence !== null) return 1;
  if (left.next_occurrence !== null && right.next_occurrence === null) return -1;
  if (left.next_occurrence !== right.next_occurrence) {
    return left.next_occurrence < right.next_occurrence ? -1 : 1;
  }
  if (left.alarm_id === right.alarm_id) return 0;
  return left.alarm_id < right.alarm_id ? -1 : 1;
}

function alarmResultErrors(value) {
  if (value.schema !== "dolly.alarm.list-result/v1") return [];
  const errors = [];
  for (let index = 1; index < value.records.length; index += 1) {
    if (compareAlarmRecordKeys(value.records[index - 1], value.records[index]) >= 0) {
      errors.push(`records[${index - 1}] and records[${index}] are not strictly ascending`);
    }
  }
  return errors;
}

function memorySearchResultErrors(value) {
  const errors = [];
  const identities = new Set();
  for (const result of value.results ?? []) {
    const identity = `${result.memory_id}@${result.record_revision}`;
    if (identities.has(identity)) {
      errors.push(`duplicate Memory result identity ${identity}`);
    }
    identities.add(identity);
  }
  return errors;
}

function napcatStrictCursorErrors(events, label) {
  const errors = [];
  for (let index = 1; index < (events ?? []).length; index += 1) {
    if (BigInt(events[index - 1].cursor) >= BigInt(events[index].cursor)) {
      errors.push(`${label} event cursors are not strictly ascending at index ${index}`);
    }
  }
  for (const [eventIndex, event] of (events ?? []).entries()) {
    const mediaOrdinals = new Set();
    for (const segment of event.segments ?? []) {
      if (segment.kind !== "media_ref") continue;
      if (mediaOrdinals.has(segment.ordinal)) {
        errors.push(`${label} event ${eventIndex} repeats media ordinal ${segment.ordinal}`);
      }
      mediaOrdinals.add(segment.ordinal);
    }
  }
  return errors;
}

function napcatSanitizedValueErrors(value, pathLabel = "sanitized_value", state = { nodes: 0 }, depth = 0) {
  const errors = [];
  state.nodes += 1;
  if (state.nodes > 4096) errors.push(`${pathLabel} exceeds the sanitized node budget`);
  if (depth > 12) errors.push(`${pathLabel} exceeds the sanitized depth budget`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...napcatSanitizedValueErrors(item, `${pathLabel}/${index}`, state, depth + 1)));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/(?:password|passwd|pwd|authorization|auth|credential|cookie|token|secret|session[_-]?key|access[_-]?key|api[_-]?key|client[_-]?key|ticket|signature|signed[_-]?url|local[_-]?path|file[_-]?path|raw[_-]?packet|process[_-]?control|url|uri|path)/iu.test(key)) {
        errors.push(`${pathLabel}/${key} retains a forbidden sensitive field`);
      }
      errors.push(...napcatSanitizedValueErrors(child, `${pathLabel}/${key}`, state, depth + 1));
    }
  } else if (typeof value === "string") {
    if (/^(?:[a-z][a-z0-9+.-]*:|[a-z]:[\\/]|\\\\|\/)/iu.test(value)) {
      errors.push(`${pathLabel} retains a raw URI or path`);
    }
  }
  if (depth === 0 && Buffer.byteLength(canonicalJson(value), "utf8") > 65536) {
    errors.push(`${pathLabel} exceeds the sanitized canonical-byte budget`);
  }
  return errors;
}

function napcatResultErrors(value, context = {}) {
  const errors = [];
  const args = context.arguments ?? {};
  const resultBytes = Buffer.byteLength(canonicalJson(value), "utf8");
  if (context.maxOutputBlockBytes !== undefined && resultBytes > context.maxOutputBlockBytes) {
    errors.push("single NapCat result exceeds the frozen output byte ceiling");
  }
  for (const gap of value.gaps ?? []) {
    if ((gap.from_cursor === null) !== (gap.to_cursor === null)) {
      errors.push("NapCat gap cursor endpoints must both be null or both be present");
    }
    if (gap.from_cursor !== null && BigInt(gap.from_cursor) > BigInt(gap.to_cursor)) {
      errors.push("NapCat gap cursor range is reversed");
    }
    if (gap.reason === "retention" && gap.certainty !== "definite_eviction") {
      errors.push("NapCat retention gap must declare definite eviction");
    }
  }

  if (value.schema === "dolly.napcatqq-mailbox-result/v1") {
    errors.push(...napcatStrictCursorErrors(value.events, "mailbox"));
    if (value.events.length > 0 && value.next_cursor !== value.events.at(-1).cursor) {
      errors.push("mailbox next_cursor does not equal the last returned event cursor");
    }
    if (args.limit !== undefined && value.events.length > args.limit) {
      errors.push("mailbox result exceeds the requested event limit");
    }
    if (args.max_bytes !== undefined && resultBytes > args.max_bytes) {
      errors.push("mailbox result exceeds the requested canonical byte limit");
    }
    if (args.operation !== undefined && value.operation !== args.operation) {
      errors.push("mailbox result operation differs from the frozen Action");
    }
    return errors;
  }

  if (value.schema === "dolly.napcatqq-conversation-result/v1") {
    errors.push(...napcatStrictCursorErrors(value.events, "conversation"));
    if (args.limit !== undefined && value.events.length > args.limit) {
      errors.push("conversation result exceeds the requested event limit");
    }
    if (args.max_bytes !== undefined && resultBytes > args.max_bytes) {
      errors.push("conversation result exceeds the requested canonical byte limit");
    }
    if (args.operation !== undefined && value.operation !== args.operation) {
      errors.push("conversation result operation differs from the frozen Action");
    }
    if (args.operation === "open" && value.view_id === null) {
      errors.push("conversation.open must return a view identity and epoch");
    }
    return errors;
  }

  if (value.schema === "dolly.napcatqq-send-result/v1") {
    const externalIds = new Set();
    for (const [index, message] of value.messages.entries()) {
      if (message.ordinal !== index) errors.push(`send message ordinal ${message.ordinal} is not ${index}`);
      if (externalIds.has(message.external_message_id)) errors.push("send result repeats an external message ID");
      externalIds.add(message.external_message_id);
    }
    if (args.selector?.view !== undefined) {
      if (value.view_id !== args.selector.view.view_id ||
          value.view_epoch !== args.selector.view.expected_view_epoch) {
        errors.push("QQ view send result does not bind the requested view identity and epoch");
      }
    }
    if (args.selector?.conversation !== undefined) {
      if (canonicalJson(value.conversation) !== canonicalJson(args.selector.conversation) ||
          value.view_id !== null || value.view_epoch !== null) {
        errors.push("explicit QQ conversation send result has an inconsistent target/view binding");
      }
    }
    return errors;
  }

  if (value.schema === "dolly.napcatqq-media-result/v1") {
    if (args.media_handle !== undefined && value.media_handle !== args.media_handle) {
      errors.push("media result handle differs from the frozen Action");
    }
    if (args.max_bytes !== undefined && value.byte_length > args.max_bytes) {
      errors.push("media result exceeds the requested byte limit");
    }
    return errors;
  }

  if (value.schema === "dolly.napcatqq-catalog-result/v1") {
    const keys = new Set();
    for (const entry of value.entries) {
      if (keys.has(entry.operation_key)) errors.push(`catalog repeats operation key ${entry.operation_key}`);
      keys.add(entry.operation_key);
    }
    if (args.registry_digest !== undefined && value.registry_digest !== args.registry_digest) {
      errors.push("catalog result registry digest differs from the frozen Action");
    }
    if (args.operation === "get" && value.selected_operation?.operation_key !== args.operation_key) {
      errors.push("catalog.get returned a different operation key");
    }
    return errors;
  }

  if (value.schema === "dolly.napcatqq-invoke-result/v1") {
    for (const key of ["registry_digest", "family", "operation_key", "sanitizer_digest"]) {
      if (args[key] !== undefined && value[key] !== args[key]) {
        errors.push(`invoke result ${key} differs from the frozen Action`);
      }
    }
    errors.push(...napcatSanitizedValueErrors(value.sanitized_value));
    return errors;
  }

  if (value.schema === "dolly.napcatqq-message-control-result/v1") {
    if (args.operation !== undefined && value.operation !== args.operation) {
      errors.push("message-control result operation differs from the frozen Action");
    }
    return errors;
  }

  return ["unrecognized NapCatQQ result discriminator"];
}

const resultSemanticValidators = new Map([
  ["org.dolly.validator.channel-send-result@1", channelSendResultErrors],
  ["org.dolly.validator.skills-result@1", skillsResultErrors],
  ["org.dolly.validator.alarm-result@1", alarmResultErrors],
  ["org.dolly.validator.memory-search-result@1", memorySearchResultErrors],
  ["org.dolly.validator.napcatqq-action-result@1", napcatResultErrors],
]);
function assertBoundResultSemantic(label, binding, value, expected = true, context = undefined) {
  if (binding.semantic_validator === null) {
    if (!expected) throw new Error(`${label}: null validator cannot exercise a negative semantic case`);
    return;
  }
  const key = `${binding.semantic_validator.id}@${binding.semantic_validator.revision}`;
  const validator = resultSemanticValidators.get(key);
  if (!validator) throw new Error(`${label}: unavailable result semantic validator ${key}`);
  assertSemantic(label, validator, value, expected, context);
}

const channelResultBinding = JSON.parse(fs.readFileSync(
  path.join(root, "examples", "runtime-config.minimal.json"), "utf8",
)).spec.modules["web-channel"].descriptor.actions[0].result_schema;
const validChannelResult = {
  schema: "dolly.channel.send-result/v1",
  session_id: "session-main",
  delivery_outcome: "sent",
  messages: [
    { ordinal: 0, external_message_id: "transport-1" },
    { ordinal: 1, external_message_id: "transport-2" },
  ],
};
assertValid("Channel send result", "https://dolly.example/spec/0.1/schemas/channel-send-result.schema.json", validChannelResult);
assertBoundResultSemantic("Channel send result", channelResultBinding, validChannelResult);
const duplicateChannelOrdinal = {
  ...validChannelResult,
  messages: [
    { ordinal: 0, external_message_id: "transport-1" },
    { ordinal: 0, external_message_id: "transport-2" },
  ],
};
assertValid("schema-valid duplicate Channel ordinal", "https://dolly.example/spec/0.1/schemas/channel-send-result.schema.json", duplicateChannelOrdinal);
assertBoundResultSemantic("duplicate Channel ordinal", channelResultBinding, duplicateChannelOrdinal, false);
const duplicateExternalId = {
  ...validChannelResult,
  messages: [
    { ordinal: 0, external_message_id: "transport-1" },
    { ordinal: 1, external_message_id: "transport-1" },
  ],
};
assertValid("schema-valid duplicate external ID", "https://dolly.example/spec/0.1/schemas/channel-send-result.schema.json", duplicateExternalId);
assertBoundResultSemantic("duplicate external ID", channelResultBinding, duplicateExternalId, false);

const skillsResultBinding = {
  semantic_validator: { id: "org.dolly.validator.skills-result", revision: 1 },
};
function skillsCatalogEntry(name, catalogRevision) {
  return {
    name,
    description: `${name} description`,
    source: { root_id: "skills-root", root_class: "bundled", relative_path: `${name}/SKILL.md` },
    trust: "trusted",
    enabled: true,
    content_hash: testDigest("9"),
    skill_schema_revision: "agentskills-1",
    required_capabilities: [],
    resources: [],
    validation_warnings: [],
    catalog_revision: catalogRevision,
  };
}
const skillsListContext = {
  arguments: { filter: null, catalog_revision: 4, cursor: null, limit: 2 },
};
const validSkillsListResult = {
  schema: "dolly.skills.list-result/v1",
  catalog_revision: 4,
  entries: [skillsCatalogEntry("alpha-skill", 4), skillsCatalogEntry("beta-skill", 4)],
  next_cursor: null,
};
assertValid("Skills list result", `${schemaBase}skills-result.schema.json`, validSkillsListResult);
assertBoundResultSemantic("Skills ordered list result", skillsResultBinding, validSkillsListResult, true, skillsListContext);
const reversedSkillsList = { ...validSkillsListResult, entries: [...validSkillsListResult.entries].reverse() };
assertValid("schema-valid reversed Skills list", `${schemaBase}skills-result.schema.json`, reversedSkillsList);
assertBoundResultSemantic("reversed Skills list", skillsResultBinding, reversedSkillsList, false, skillsListContext);
const wrongRevisionSkillsList = structuredClone(validSkillsListResult);
wrongRevisionSkillsList.entries[0].catalog_revision = 5;
assertValid("schema-valid Skills entry revision mismatch", `${schemaBase}skills-result.schema.json`, wrongRevisionSkillsList);
assertBoundResultSemantic(
  "Skills entry revision mismatch",
  skillsResultBinding,
  wrongRevisionSkillsList,
  false,
  skillsListContext,
);
assertBoundResultSemantic(
  "Skills list requested limit",
  skillsResultBinding,
  validSkillsListResult,
  false,
  { arguments: { ...skillsListContext.arguments, limit: 1 } },
);

const validSkillsResolveResult = {
  schema: "dolly.skills.resolve-result/v1",
  catalog_revision: 4,
  entry: skillsCatalogEntry("alpha-skill", 4),
};
assertValid("Skills resolve result", `${schemaBase}skills-result.schema.json`, validSkillsResolveResult);
assertBoundResultSemantic(
  "Skills resolve name/revision binding",
  skillsResultBinding,
  validSkillsResolveResult,
  true,
  { arguments: { name: "alpha-skill", catalog_revision: 4 } },
);

const skillsManifestText = "# Alpha Skill\n";
const skillsManifestHash = `sha256:${crypto.createHash("sha256").update(Buffer.from(skillsManifestText, "utf8")).digest("hex")}`;
const validSkillsManifestResult = {
  schema: "dolly.skills.get-manifest-result/v1",
  catalog_revision: 4,
  name: "alpha-skill",
  content_hash: skillsManifestHash,
  manifest_text: skillsManifestText,
};
assertValid("Skills manifest result", `${schemaBase}skills-result.schema.json`, validSkillsManifestResult);
assertBoundResultSemantic(
  "Skills manifest name/revision/hash binding",
  skillsResultBinding,
  validSkillsManifestResult,
  true,
  { arguments: { name: "alpha-skill", catalog_revision: 4 }, maxBytes: 64 },
);
const wrongSkillsManifestHash = { ...validSkillsManifestResult, content_hash: testDigest("8") };
assertValid("schema-valid Skills manifest hash mismatch", `${schemaBase}skills-result.schema.json`, wrongSkillsManifestHash);
assertBoundResultSemantic(
  "Skills manifest hash mismatch",
  skillsResultBinding,
  wrongSkillsManifestHash,
  false,
  { arguments: { name: "alpha-skill", catalog_revision: 4 }, maxBytes: 64 },
);

const skillsAbcHash = `sha256:${crypto.createHash("sha256").update(Buffer.from("abc", "utf8")).digest("hex")}`;
const validSkillsResourceResult = {
  schema: "dolly.skills.get-resource-result/v1",
  catalog_revision: 1,
  name: "example-skill",
  relative_path: "references/example.txt",
  media_type: "text/plain",
  content_hash: skillsAbcHash,
  encoding: "utf8",
  data: "abc",
  offset: 0,
  returned_bytes: 3,
  total_bytes: 3,
  truncated: false,
};
const skillsContext = {
  arguments: {
    name: "example-skill",
    relative_path: "references/example.txt",
    catalog_revision: 1,
    byte_range: { offset: 0, length: 3 },
  },
  maxBytes: 8,
  expectedContentHash: skillsAbcHash,
};
assertValid("Skills resource result", "https://dolly.example/spec/0.1/schemas/skills-result.schema.json", validSkillsResourceResult);
assertBoundResultSemantic("Skills resource result", skillsResultBinding, validSkillsResourceResult, true, skillsContext);
for (const [label, mutation] of [
  ["Skills decoded-length mismatch", { returned_bytes: 2, total_bytes: 3, truncated: true }],
  ["Skills range exceeds total", { offset: 2, returned_bytes: 3, total_bytes: 4, truncated: false }],
  ["Skills false truncation", { returned_bytes: 3, total_bytes: 4, truncated: false }],
]) {
  const value = { ...validSkillsResourceResult, ...mutation };
  assertValid(`schema-valid ${label}`, "https://dolly.example/spec/0.1/schemas/skills-result.schema.json", value);
  assertBoundResultSemantic(label, skillsResultBinding, value, false, skillsContext);
}
for (const [label, mutation] of [
  ["Skills resource name mismatch", { name: "different-skill" }],
  ["Skills resource path mismatch", { relative_path: "references/different.txt" }],
  ["Skills resource catalog revision mismatch", { catalog_revision: 2 }],
  ["Skills resource safe-integer range overflow", {
    offset: Number.MAX_SAFE_INTEGER,
    returned_bytes: 3,
    total_bytes: Number.MAX_SAFE_INTEGER,
    truncated: false,
  }],
]) {
  const value = { ...validSkillsResourceResult, ...mutation };
  assertValid(`schema-valid ${label}`, `${schemaBase}skills-result.schema.json`, value);
  assertBoundResultSemantic(label, skillsResultBinding, value, false, skillsContext);
}
assertBoundResultSemantic(
  "Skills resource effective byte limit",
  skillsResultBinding,
  validSkillsResourceResult,
  false,
  { ...skillsContext, maxBytes: 2 },
);

const alarmResultBinding = {
  semantic_validator: { id: "org.dolly.validator.alarm-result", revision: 1 },
};
function alarmRecord(alarmId, nextOccurrence) {
  return {
    alarm_id: alarmId,
    revision: 1,
    title: "Example",
    schedule: { kind: "once", at: "2026-08-11T00:00:00.000000Z" },
    delivery: { mode: "once" },
    misfire_policy: "fire_once",
    dst_gap_policy: "shift_by_gap",
    dst_fold_policy: "earlier",
    enabled: true,
    created_at: "2026-08-10T00:00:00.000000Z",
    next_occurrence: nextOccurrence,
    tzdb_revision: "2026b",
  };
}
const validAlarmList = {
  schema: "dolly.alarm.list-result/v1",
  records: [
    alarmRecord("0198ab31-6c44-7e8a-b2bb-000000000131", "2026-08-11T00:00:00.000000Z"),
    alarmRecord("0198ab31-6c44-7e8a-b2bb-000000000132", null),
  ],
  next_cursor: null,
};
assertValid("Alarm list result", "https://dolly.example/spec/0.1/schemas/alarm-result.schema.json", validAlarmList);
assertBoundResultSemantic("Alarm list result", alarmResultBinding, validAlarmList);
const reversedAlarmList = { ...validAlarmList, records: [...validAlarmList.records].reverse() };
assertValid("schema-valid reversed Alarm list", "https://dolly.example/spec/0.1/schemas/alarm-result.schema.json", reversedAlarmList);
assertBoundResultSemantic("reversed Alarm list", alarmResultBinding, reversedAlarmList, false);

function activationStatusSemanticErrors(value) {
  const errors = [];
  const authorization = value.next_attempt_authorization;
  if (authorization === null) return errors;
  if (authorization.authorized_attempt !== authorization.source_attempt + 1) {
    errors.push("authorized_attempt is not exactly source_attempt + 1");
  }
  if (value.last_dispatch === null || authorization.source_attempt !== value.last_dispatch.attempt) {
    errors.push("source_attempt does not equal last_dispatch.attempt");
  }
  if (["safe_before_dispatch", "pure_compute"].includes(authorization.reason) &&
      authorization.evidence_digest !== value.last_dispatch?.fence_evidence_digest) {
    errors.push("authorization does not bind the retained fence evidence");
  }
  return errors;
}

function assertActivationStatusSemantic(label, value, expected = true) {
  const actual = activationStatusSemanticErrors(value).length === 0;
  if (actual !== expected) {
    throw new Error(`${label}: expected semantic validity=${expected}; ${activationStatusSemanticErrors(value).join("; ")}`);
  }
}

const retryWaitStatus = {
  module_id: "timer",
  activation_id: "0198ab31-6c44-7e8a-b2bb-000000000113",
  manifest_digest: `sha256:${"4".repeat(64)}`,
  state: "retry_wait",
  terminal: false,
  result_digest: null,
  frozen_replay_contract: {
    descriptor_revision: 1,
    config_revision: 1,
    contract: { mode: "fenced_replay", evidence: "pure_compute", ledger: null },
  },
  last_dispatch: {
    attempt: 1,
    state: "fenced",
    transport_started: true,
    frame_digest: `sha256:${"5".repeat(64)}`,
    fence_evidence_digest: `sha256:${"6".repeat(64)}`,
  },
  next_attempt_authorization: {
    authorized_attempt: 2,
    source_attempt: 1,
    reason: "pure_compute",
    evidence_digest: `sha256:${"6".repeat(64)}`,
  },
};
assertValid("retry-wait Activation status", "https://dolly.example/spec/0.1/schemas/activation-status.schema.json", retryWaitStatus);
assertActivationStatusSemantic("retry-wait Activation status", retryWaitStatus);
assertActivationStatusSemantic(
  "non-consecutive retry authorization",
  { ...retryWaitStatus, next_attempt_authorization: { ...retryWaitStatus.next_attempt_authorization, authorized_attempt: 3 } },
  false,
);
assertValid(
  "leased status without prepared dispatch",
  "https://dolly.example/spec/0.1/schemas/activation-status.schema.json",
  { ...retryWaitStatus, state: "leased", last_dispatch: null, next_attempt_authorization: null },
  false,
);
assertValid(
  "committed status with prepared dispatch",
  "https://dolly.example/spec/0.1/schemas/activation-status.schema.json",
  {
    ...retryWaitStatus,
    state: "committed",
    terminal: true,
    result_digest: `sha256:${"7".repeat(64)}`,
    last_dispatch: { attempt: 1, state: "prepared", transport_started: false, frame_digest: null, fence_evidence_digest: null },
    next_attempt_authorization: null,
  },
  false,
);
assertValid(
  "retry-wait status with operator-review authorization",
  "https://dolly.example/spec/0.1/schemas/activation-status.schema.json",
  {
    ...retryWaitStatus,
    last_dispatch: { attempt: 1, state: "prepared", transport_started: false, frame_digest: null, fence_evidence_digest: null },
    next_attempt_authorization: { authorized_attempt: 2, source_attempt: 1, reason: "operator_review", evidence_digest: `sha256:${"8".repeat(64)}` },
  },
  false,
);

const memorySearchResult = {
  schema: "dolly.memory-search-result/v1",
  retrieval_id: "0198ab31-6c44-7e8a-b2bb-000000000120",
  trust_class: "untrusted_user_derived",
  query_digest: testDigest("a"),
  query_basis_digest: testDigest("b"),
  query_basis_count: 2,
  index_revision: 1,
  results: [{
    memory_id: "0198ab31-6c44-7e8a-b2bb-000000000121",
    record_revision: 3,
    source_block_ids: ["0198ab31-6c44-7e8a-b2bb-000000000122"],
    record_type: "fact",
    status: "current",
    validation_state: "validated",
    supersedes_memory_id: null,
    conflict_set_id: null,
    evidence_span: { text: "The retained evidence.", truncated: false },
    component_scores: { lexical: 0.8, dense: null, rerank: null },
    final_score: 0.8,
    retrieval_reason: "lexical",
    derived_summary: false,
    derived_from_memory_ids: [],
  }],
  abstention_reason: null,
  truncated: false,
};
assertValid("Memory search result", "https://dolly.example/spec/0.1/schemas/memory-search-result.schema.json", memorySearchResult);
const memoryResultBinding = {
  semantic_validator: { id: "org.dolly.validator.memory-search-result", revision: 1 },
};
assertBoundResultSemantic("Memory search result", memoryResultBinding, memorySearchResult);
const duplicateMemoryIdentityResult = structuredClone(memorySearchResult);
duplicateMemoryIdentityResult.results.push({
  ...structuredClone(memorySearchResult.results[0]),
  final_score: 0.7,
});
assertValid(
  "schema-valid duplicate Memory result identity",
  "https://dolly.example/spec/0.1/schemas/memory-search-result.schema.json",
  duplicateMemoryIdentityResult,
);
assertBoundResultSemantic(
  "duplicate Memory result identity",
  memoryResultBinding,
  duplicateMemoryIdentityResult,
  false,
);
assertValid(
  "current rejected Memory search result",
  "https://dolly.example/spec/0.1/schemas/memory-search-result.schema.json",
  { ...memorySearchResult, results: [{ ...memorySearchResult.results[0], validation_state: "rejected" }] },
  false,
);
assertValid(
  "unlinked disputed Memory search result",
  "https://dolly.example/spec/0.1/schemas/memory-search-result.schema.json",
  { ...memorySearchResult, results: [{ ...memorySearchResult.results[0], status: "disputed" }] },
  false,
);

const memoryDecision = {
  schema: "dolly.memory-injection-decision/v1",
  decision_id: testUuid(123),
  target_model_request_id: testUuid(124),
  target_activation_id: testUuid(125),
  target_module_id: "main-brain",
  retrieval_id: memorySearchResult.retrieval_id,
  memory_id: memorySearchResult.results[0].memory_id,
  record_revision: memorySearchResult.results[0].record_revision,
  search_result_digest: canonicalDigest(memorySearchResult),
  query_digest: memorySearchResult.query_digest,
  query_basis_digest: memorySearchResult.query_basis_digest,
  policy_id: "memory-context-selection",
  policy_revision: 1,
  prior_model_request_count: 0,
  last_model_request_at: null,
  decision: "include",
  reason: "first_relevant_delivery",
  created_at: "2026-08-12T10:00:00.000000Z",
};
assertValid(
  "first Memory context decision",
  "https://dolly.example/spec/0.1/schemas/memory-injection-decision.schema.json",
  memoryDecision,
);
const repeatedMemoryDecision = {
  ...memoryDecision,
  decision_id: testUuid(126),
  target_model_request_id: testUuid(127),
  prior_model_request_count: 1,
  last_model_request_at: "2026-08-12T10:00:00.000000Z",
  reason: "repeat_relevant_to_current_context",
  created_at: "2026-08-12T10:07:00.000000Z",
};
assertValid(
  "same-day repeated Memory context decision",
  "https://dolly.example/spec/0.1/schemas/memory-injection-decision.schema.json",
  repeatedMemoryDecision,
);
assertValid(
  "repeat using first-delivery reason",
  "https://dolly.example/spec/0.1/schemas/memory-injection-decision.schema.json",
  { ...repeatedMemoryDecision, reason: "first_relevant_delivery" },
  false,
);

function memoryEvidenceRequestErrors(value, retainedSearchResult) {
  const errors = [];
  const identities = new Set();
  const retainedByIdentity = new Map(
    retainedSearchResult.results.map((record) => [
      `${record.memory_id}@${record.record_revision}`,
      record,
    ]),
  );
  for (const message of value.messages ?? []) {
    for (const part of message.parts ?? []) {
      if (part.kind !== "memory_evidence") continue;
      const decision = part.decision;
      const record = part.record;
      const identity = `${record.memory_id}@${record.record_revision}`;
      if (message.role_class !== "external") errors.push("Memory evidence is not external");
      if (identities.has(identity)) errors.push(`duplicate Memory evidence identity ${identity}`);
      identities.add(identity);
      if (decision.target_model_request_id !== value.request_id ||
          decision.target_activation_id !== value.activation_id ||
          decision.target_module_id !== value.module_id) {
        errors.push("Memory decision target does not match canonical request");
      }
      if (decision.retrieval_id !== retainedSearchResult.retrieval_id ||
          decision.memory_id !== record.memory_id ||
          decision.record_revision !== record.record_revision ||
          decision.query_digest !== retainedSearchResult.query_digest ||
          decision.query_basis_digest !== retainedSearchResult.query_basis_digest ||
          decision.search_result_digest !== canonicalDigest(retainedSearchResult)) {
        errors.push("Memory decision does not match retained search result");
      }
      if (canonicalJson(retainedByIdentity.get(identity)) !== canonicalJson(record)) {
        errors.push("Memory evidence record is absent from or differs from retained search result");
      }
    }
  }
  return errors;
}

function modalityForModelOutputPart(part, assetMetadataById, errors) {
  if (part.kind === "text" || part.kind === "json") return "text";
  if (part.kind !== "asset") {
    errors.push(`forbidden model output Part ${part.kind}`);
    return null;
  }
  const metadata = assetMetadataById?.[part.asset_id];
  if (metadata === undefined) {
    errors.push(`missing Asset metadata for ${part.asset_id}`);
    return null;
  }
  if (metadata.state !== "available") {
    errors.push(`model output Asset ${part.asset_id} is not available`);
  }
  if (metadata.media_type !== part.media_type) {
    errors.push(`model output Asset ${part.asset_id} MIME differs from authoritative metadata`);
  }
  const mediaType = metadata.media_type;
  if (typeof mediaType !== "string") {
    errors.push(`model output Asset ${part.asset_id} lacks detected MIME`);
    return null;
  }
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

function modelExchangeSemanticErrors(exchange) {
  const errors = [];
  const { request, response, profile, granted_output_modalities: granted,
    asset_metadata_by_id: assetMetadataById } = exchange;
  if (request.profile.profile_id !== profile.profile_id ||
      request.profile.revision !== profile.revision) {
    errors.push("model request does not bind the supplied pinned profile");
  }
  const profileModalities = new Set(profile.output_modalities ?? []);
  const grantedModalities = new Set(granted ?? []);
  for (const modality of request.requested_output_modalities ?? []) {
    if (!profileModalities.has(modality)) errors.push(`profile does not support ${modality}`);
    if (!grantedModalities.has(modality)) errors.push(`Host grant does not permit ${modality}`);
  }
  if (response.request_id !== request.request_id) errors.push("response request_id mismatch");
  if (response.profile.profile_id !== request.profile.profile_id ||
      response.profile.revision !== request.profile.revision) {
    errors.push("response profile mismatch");
  }
  const requested = new Set(request.requested_output_modalities ?? []);
  let aggregateAssetBytes = 0;
  for (const part of response.output_parts ?? []) {
    const modality = modalityForModelOutputPart(part, assetMetadataById, errors);
    if (modality !== null && !requested.has(modality)) {
      errors.push(`response modality ${modality} was not requested`);
    }
    if (part.kind === "asset") {
      const byteLength = assetMetadataById?.[part.asset_id]?.byte_length;
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        errors.push(`model output Asset ${part.asset_id} has invalid byte length`);
      } else {
        aggregateAssetBytes += byteLength;
      }
    }
  }
  if (aggregateAssetBytes > request.budget.max_output_asset_bytes) {
    errors.push("model output aggregate Asset byte budget exceeded");
  }
  return errors;
}

const memoryModelRequest = {
  request_id: memoryDecision.target_model_request_id,
  module_id: memoryDecision.target_module_id,
  activation_id: memoryDecision.target_activation_id,
  lease_token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  profile: { profile_id: "model-main", revision: 1 },
  operation: "generate",
  requested_output_modalities: ["text"],
  messages: [
    {
      entry_id: testUuid(128),
      role_class: "system",
      parts: [{ kind: "text", text: "Follow the runtime contract.", format: "plain" }],
      transaction_id: null,
    },
    {
      entry_id: testUuid(129),
      role_class: "external",
      parts: [{
        kind: "memory_evidence",
        trust_class: "untrusted_user_derived",
        decision: memoryDecision,
        record: memorySearchResult.results[0],
      }],
      transaction_id: null,
    },
    {
      entry_id: testUuid(130),
      role_class: "external",
      parts: [{ kind: "text", text: "Continue the current task.", format: "plain" }],
      transaction_id: null,
    },
  ],
  tools: [],
  output_contract: { kind: "text" },
  sampling: { temperature: 0.2, seed: 1 },
  budget: { max_output_tokens: 512, max_output_asset_bytes: 0, max_cost_microunits: null },
  deadline: "2026-08-12T10:01:00.000000Z",
  metadata: { trace_id: testUuid(131) },
  adapter_options: {},
};
assertValid(
  "model request with typed Memory evidence",
  "https://dolly.example/spec/0.1/schemas/model-request.schema.json",
  memoryModelRequest,
);
assertSemantic(
  "model request Memory evidence bindings",
  memoryEvidenceRequestErrors,
  memoryModelRequest,
  true,
  memorySearchResult,
);
const systemMemoryRequest = structuredClone(memoryModelRequest);
systemMemoryRequest.messages[1].role_class = "system";
assertValid(
  "Memory evidence in system role",
  "https://dolly.example/spec/0.1/schemas/model-request.schema.json",
  systemMemoryRequest,
  false,
);
const duplicateMemoryRequest = structuredClone(memoryModelRequest);
duplicateMemoryRequest.messages[1].parts.push(structuredClone(duplicateMemoryRequest.messages[1].parts[0]));
assertValid(
  "schema-valid duplicate Memory evidence in one request",
  "https://dolly.example/spec/0.1/schemas/model-request.schema.json",
  duplicateMemoryRequest,
);
assertSemantic(
  "duplicate Memory evidence in one request",
  memoryEvidenceRequestErrors,
  duplicateMemoryRequest,
  false,
  memorySearchResult,
);
const mismatchedMemoryDecisionRequest = structuredClone(memoryModelRequest);
mismatchedMemoryDecisionRequest.messages[1].parts[0].decision.query_digest = testDigest("c");
assertValid(
  "schema-valid mismatched Memory decision digest",
  "https://dolly.example/spec/0.1/schemas/model-request.schema.json",
  mismatchedMemoryDecisionRequest,
);
assertSemantic(
  "mismatched Memory decision digest",
  memoryEvidenceRequestErrors,
  mismatchedMemoryDecisionRequest,
  false,
  memorySearchResult,
);

const laterMemoryModelRequest = structuredClone(memoryModelRequest);
laterMemoryModelRequest.request_id = repeatedMemoryDecision.target_model_request_id;
laterMemoryModelRequest.messages[1].parts[0].decision = repeatedMemoryDecision;
laterMemoryModelRequest.messages[1].entry_id = testUuid(132);
laterMemoryModelRequest.messages[2].entry_id = testUuid(133);
laterMemoryModelRequest.metadata.trace_id = testUuid(134);
assertValid(
  "later model request repeats the same Memory revision",
  "https://dolly.example/spec/0.1/schemas/model-request.schema.json",
  laterMemoryModelRequest,
);
assertSemantic(
  "later request may repeat Memory evidence",
  memoryEvidenceRequestErrors,
  laterMemoryModelRequest,
  true,
  memorySearchResult,
);

const modelRequestSchema = `${schemaBase}model-request.schema.json`;
const modelResponseSchema = `${schemaBase}model-response.schema.json`;
const multimodalModelRequest = structuredClone(memoryModelRequest);
multimodalModelRequest.requested_output_modalities = ["text", "image"];
multimodalModelRequest.budget.max_output_asset_bytes = 4096;
assertValid("multimodal model request", modelRequestSchema, multimodalModelRequest);

const pureMediaModelRequest = structuredClone(memoryModelRequest);
pureMediaModelRequest.requested_output_modalities = ["image"];
pureMediaModelRequest.output_contract = { kind: "none" };
pureMediaModelRequest.budget.max_output_asset_bytes = 4096;
assertValid("pure-media model request", modelRequestSchema, pureMediaModelRequest);

const pureMediaWithTextContract = structuredClone(pureMediaModelRequest);
pureMediaWithTextContract.output_contract = { kind: "text" };
assertValid("pure-media request with text contract", modelRequestSchema, pureMediaWithTextContract, false);

const textRequestWithAssetBudget = structuredClone(memoryModelRequest);
textRequestWithAssetBudget.budget.max_output_asset_bytes = 1;
assertValid("text-only request with Asset budget", modelRequestSchema, textRequestWithAssetBudget, false);

const multimodalRequestWithoutAssetBudget = structuredClone(multimodalModelRequest);
multimodalRequestWithoutAssetBudget.budget.max_output_asset_bytes = 0;
assertValid("multimodal request without Asset budget", modelRequestSchema, multimodalRequestWithoutAssetBudget, false);

const requestWithoutOutputModalities = structuredClone(memoryModelRequest);
delete requestWithoutOutputModalities.requested_output_modalities;
assertValid("model request without requested modalities", modelRequestSchema, requestWithoutOutputModalities, false);

const unknownUsageMeasure = { value: null, provenance: "unknown" };
const multimodalModelResponse = {
  request_id: multimodalModelRequest.request_id,
  profile: structuredClone(multimodalModelRequest.profile),
  provider_request_id: "provider-request-1",
  output_parts: [
    { kind: "text", text: "rendered", format: "plain" },
    { kind: "asset", asset_id: testAssetId, media_type: "image/png" },
  ],
  tool_call_proposals: [],
  finish_reason: "stop",
  structured_output_mode: "none",
  usage: {
    input_tokens: { value: 32, provenance: "provider_reported" },
    output_tokens: { value: 4, provenance: "provider_reported" },
    reasoning_tokens: structuredClone(unknownUsageMeasure),
    cached_tokens: structuredClone(unknownUsageMeasure),
    image_units: { value: 1, provenance: "provider_reported" },
    audio_units: structuredClone(unknownUsageMeasure),
    tool_units: structuredClone(unknownUsageMeasure),
  },
  cost: {
    microunits: 123,
    currency: "USD",
    pricing_revision: "2026-08-01",
    provenance: "actual",
  },
  retry_history: [{ attempt: 1, provider_phase_outcome: "complete", code: null }],
};
assertValid("multimodal model response", modelResponseSchema, multimodalModelResponse);

const validModelExchange = {
  request: multimodalModelRequest,
  response: multimodalModelResponse,
  profile: {
    profile_id: "model-main",
    revision: 1,
    output_modalities: ["text", "image"],
  },
  granted_output_modalities: ["text", "image"],
  asset_metadata_by_id: {
    [testAssetId]: {
      state: "available",
      media_type: "image/png",
      byte_length: 2048,
    },
  },
};
assertSemantic("multimodal model exchange", modelExchangeSemanticErrors, validModelExchange);

const smallerRequestedSubsetExchange = structuredClone(validModelExchange);
smallerRequestedSubsetExchange.response.output_parts = [
  structuredClone(multimodalModelResponse.output_parts[0]),
];
smallerRequestedSubsetExchange.asset_metadata_by_id = {};
assertSemantic(
  "model response may contain a strict subset of requested modalities",
  modelExchangeSemanticErrors,
  smallerRequestedSubsetExchange,
);

const pureMediaModelResponse = structuredClone(multimodalModelResponse);
pureMediaModelResponse.output_parts = [structuredClone(multimodalModelResponse.output_parts[1])];
const validPureMediaExchange = structuredClone(validModelExchange);
validPureMediaExchange.request = pureMediaModelRequest;
validPureMediaExchange.response = pureMediaModelResponse;
assertValid("pure-media model response", modelResponseSchema, pureMediaModelResponse);
assertSemantic("pure-media model exchange", modelExchangeSemanticErrors, validPureMediaExchange);

const profileDeniedExchange = structuredClone(validModelExchange);
profileDeniedExchange.profile.output_modalities = ["text"];
assertSemantic("profile denies requested image output", modelExchangeSemanticErrors, profileDeniedExchange, false);

const grantDeniedExchange = structuredClone(validModelExchange);
grantDeniedExchange.granted_output_modalities = ["text"];
assertSemantic("Host grant denies requested image output", modelExchangeSemanticErrors, grantDeniedExchange, false);

const unrequestedAudioExchange = structuredClone(validModelExchange);
unrequestedAudioExchange.response.output_parts[1].media_type = "audio/ogg";
unrequestedAudioExchange.asset_metadata_by_id[testAssetId].media_type = "audio/ogg";
assertValid("schema-valid unrequested audio response", modelResponseSchema, unrequestedAudioExchange.response);
assertSemantic("unrequested audio response", modelExchangeSemanticErrors, unrequestedAudioExchange, false);

const unavailableAssetExchange = structuredClone(validModelExchange);
unavailableAssetExchange.asset_metadata_by_id[testAssetId].state = "accepted";
assertSemantic("non-available model output Asset", modelExchangeSemanticErrors, unavailableAssetExchange, false);

const mismatchedAssetMimeExchange = structuredClone(validModelExchange);
mismatchedAssetMimeExchange.asset_metadata_by_id[testAssetId].media_type = "image/jpeg";
assertSemantic("model output Asset MIME mismatch", modelExchangeSemanticErrors, mismatchedAssetMimeExchange, false);

const oversizedAssetExchange = structuredClone(validModelExchange);
oversizedAssetExchange.asset_metadata_by_id[testAssetId].byte_length = 4097;
assertSemantic("model output aggregate Asset budget", modelExchangeSemanticErrors, oversizedAssetExchange, false);

const forgedBlockRefResponse = structuredClone(multimodalModelResponse);
forgedBlockRefResponse.output_parts = [{
  kind: "block_ref",
  block_id: testUuid(135),
  relation: "evidence",
}];
assertValid("Provider-forged BlockRef response", modelResponseSchema, forgedBlockRefResponse, false);

const rawProviderUrlResponse = structuredClone(multimodalModelResponse);
rawProviderUrlResponse.output_parts = [{
  kind: "asset",
  asset_id: testAssetId,
  media_type: "image/png",
  temporary_url: "https://media.example.invalid/private-token",
}];
assertValid("raw Provider URL in model response", modelResponseSchema, rawProviderUrlResponse, false);

const boundedRemoteAssetImport = {
  import_id: testUuid(136),
  instance_id: "instance-a",
  module_id: "main-brain",
  activation_id: multimodalModelRequest.activation_id,
  lease_token: multimodalModelRequest.lease_token,
  media_kind: "image",
  source: {
    kind: "remote_url",
    url: "https://media.example.invalid/private-token",
    max_bytes: 4096,
  },
  declared_media_type: "image/png",
  remote_required: false,
  expected_byte_length: null,
  deadline: multimodalModelRequest.deadline,
};
assertValid("bounded remote Asset import", `${schemaBase}asset-import.schema.json`, boundedRemoteAssetImport);
const unboundedRemoteAssetImport = structuredClone(boundedRemoteAssetImport);
delete unboundedRemoteAssetImport.source.max_bytes;
assertValid("unbounded remote Asset import", `${schemaBase}asset-import.schema.json`, unboundedRemoteAssetImport, false);

function napcatEndpointErrors(raw, expectedProtocols, allowNonLoopback) {
  const errors = [];
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    return ["NapCat endpoint is not a parseable absolute URI"];
  }
  if (!expectedProtocols.includes(endpoint.protocol)) errors.push("NapCat endpoint uses an unsupported scheme");
  if (endpoint.username !== "" || endpoint.password !== "") errors.push("NapCat endpoint contains userinfo");
  if (endpoint.search !== "" || endpoint.hash !== "") errors.push("NapCat endpoint contains a query or fragment");
  if (endpoint.port === "") errors.push("NapCat endpoint must use an explicit port");
  if (/[\u0000-\u001f\u007f]/u.test(raw)) errors.push("NapCat endpoint contains a control character");
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  const exactLoopbackAuthority = /^wss?:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+(?:\/[^?#\\]*)?$/u.test(raw) ||
    /^https?:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+(?:\/[^?#\\]*)?$/u.test(raw);
  if (!allowNonLoopback && !exactLoopbackAuthority) {
    errors.push("NapCat endpoint must spell a canonical literal loopback authority");
  }
  if (!allowNonLoopback && !loopback) errors.push("NapCat endpoint must use a literal loopback host");
  if (allowNonLoopback && !loopback && !["wss:", "https:"].includes(endpoint.protocol)) {
    errors.push("remote NapCat endpoint must use TLS");
  }
  return errors;
}

function napcatConfigErrors(value, context = {}) {
  const errors = [];
  if (value.module_role === "shared_hub") {
    errors.push(...napcatEndpointErrors(
      value.connection.websocket_endpoint,
      ["ws:", "wss:"],
      value.connection.allow_non_loopback,
    ));
    if (value.connection.http_endpoint !== null) {
      errors.push(...napcatEndpointErrors(
        value.connection.http_endpoint,
        ["http:", "https:"],
        value.connection.allow_non_loopback,
      ));
    }
    const principals = new Set();
    for (const rule of value.consumer_rules) {
      const key = `${rule.consumer_principal.instance_id}/${rule.consumer_principal.module_id}`;
      if (principals.has(key)) errors.push(`duplicate NapCat consumer rule ${key}`);
      principals.add(key);
    }
    const actualSelfId = context.actualSelfId ?? value.expected_self_id;
    const ownerKey = `${value.host_account_principal}/${actualSelfId}`;
    if (context.activeOwnerKeys?.includes(ownerKey)) errors.push(`duplicate daemon-wide NapCat owner ${ownerKey}`);
    if (context.activeOwnerPrincipals?.includes(value.host_account_principal)) {
      errors.push(`duplicate daemon-wide NapCat principal owner ${value.host_account_principal}`);
    }
    if (context.activeActualSelfIds?.includes(actualSelfId)) {
      errors.push(`duplicate daemon-wide NapCat actual-self owner ${actualSelfId}`);
    }
  } else if (value.module_role === "consumer_facade") {
    if (value.private_result_page_id === value.private_notification_page_id) {
      errors.push("NapCat result and notification Pages must be distinct");
    }
    const limits = value.output_limits;
    if (limits.max_attached_assets === 0 && limits.max_attached_asset_bytes !== 0) {
      errors.push("zero attached Assets requires a zero attached-Asset byte budget");
    }
    if (limits.max_attached_assets > 0 && limits.max_attached_asset_bytes === 0) {
      errors.push("a positive attached-Asset count requires a positive byte budget");
    }
    if (limits.max_top_level_parts < limits.max_actions_per_activation + limits.max_attached_assets) {
      errors.push("top-level Part budget cannot hold reserved ActionResults and Assets");
    }
    if (limits.max_read_bytes + 2048 > limits.max_output_block_bytes) {
      errors.push("read byte budget leaves no bounded envelope reserve in the aggregate output budget");
    }
    if (context.coreMaxBlocks !== undefined && context.coreMaxBlocks !== 1) {
      errors.push("NapCat facade Core batching must freeze max_blocks=1");
    }
    const expected = canonicalJson([value.consumer_principal]);
    if (context.resultPageSubscribers !== undefined && canonicalJson(context.resultPageSubscribers) !== expected) {
      errors.push("NapCat result Page subscriber cohort is not the trusted consumer principal");
    }
    if (context.notificationPageSubscribers !== undefined &&
        canonicalJson(context.notificationPageSubscribers) !== expected) {
      errors.push("NapCat notification Page subscriber cohort is not the trusted consumer principal");
    }
  }
  return errors;
}

const napcatProfileAdmissionValidator = "org.dolly.validator.napcatqq-profile-admission@1";
function napcatProfileConfigErrors(value, context = {}) {
  const errors = napcatConfigErrors(value, context);
  if (context.profileAdmissionValidator !== napcatProfileAdmissionValidator) {
    errors.push("NapCat profile-admission validator is unavailable or has the wrong revision");
  }
  if (context.hosting !== "per_extension") errors.push("NapCat profile requires per_extension hosting");
  if (value.module_role === "shared_hub") {
    if (context.moduleType !== "napcat-onebot-v11-hub") errors.push("hub config is bound to the wrong Module type");
    if (context.configSchemaUri !== "schemas/napcatqq-hub-config.schema.json") errors.push("hub Module type must bind the role-specific whole-root config schema");
    if (canonicalJson(context.outputPageIds ?? null) !== canonicalJson([])) errors.push("NapCat hub must have no ordinary output Page");
  } else if (value.module_role === "consumer_facade") {
    if (context.moduleType !== "napcat-onebot-v11-facade") errors.push("facade config is bound to the wrong Module type");
    if (context.configSchemaUri !== "schemas/napcatqq-facade-config.schema.json") errors.push("facade Module type must bind the role-specific whole-root config schema");
    if (canonicalJson(context.outputPageIds ?? null) !== canonicalJson([value.private_result_page_id])) {
      errors.push("NapCat facade output set is not the exact singleton private result Page");
    }
    const expectedIngress = [value.private_notification_page_id, value.private_result_page_id].sort();
    if (canonicalJson([...(context.hubIngressPageIds ?? [])].sort()) !== canonicalJson(expectedIngress)) {
      errors.push("NapCat hub ingress grant is not the exact result/notification Page set");
    }
    if (context.hubModuleType !== "napcat-onebot-v11-hub") errors.push("facade hub_module_id does not resolve to the hub Module type");
    if (context.extensionAlias === undefined || context.extensionAlias !== context.hubExtensionAlias) errors.push("hub/facade Extension aliases differ");
    if (context.processCohort === undefined || context.processCohort !== context.hubProcessCohort) errors.push("hub/facade placement cohorts differ");
    if (context.hubAccountRef !== value.account_ref || context.hubAccountPrincipal !== value.host_account_principal) {
      errors.push("hub/facade account binding differs");
    }
    if (context.storageScopeId === undefined || context.hubStorageScopeId === undefined ||
        context.storageScopeId === context.hubStorageScopeId) {
      errors.push("hub/facade storage scopes are absent or aliased");
    }
  }
  return errors;
}

function napcatProfileBlockErrors(kind, draft, context = {}) {
  const errors = [];
  const exactKeys = (value, keys) => canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
  if (context.profileAdmissionValidator !== napcatProfileAdmissionValidator) {
    errors.push("NapCat profile-admission validator is unavailable or has the wrong revision");
  }
  if (kind === "input_action_set") {
    const actions = draft.actions ?? [];
    const limits = context.outputLimits ?? {};
    if (actions.length > limits.max_actions_per_activation) errors.push("NapCat input Action set exceeds the activation Action limit");
    const declaredBytes = actions.reduce((sum, action) => sum + (action.arguments?.max_bytes ?? 0), 0);
    const reservedBytes = declaredBytes + actions.length * (context.errorEnvelopeReserveBytes ?? 2048);
    if (reservedBytes > limits.max_output_block_bytes) errors.push("NapCat input Action set exceeds the worst-case output reservation");
    if (actions.length > limits.max_top_level_parts) errors.push("NapCat input Action set exceeds the result Part reservation");
    const mediaCount = actions.filter((action) => action.name === "org.dolly.channel.qq.media").length;
    if (mediaCount > limits.max_attached_assets) errors.push("NapCat input Action set exceeds the media-delivery count reservation");
    return errors;
  }
  if (context.maxOutputBlockBytes !== undefined && Buffer.byteLength(canonicalJson(draft), "utf8") > context.maxOutputBlockBytes) {
    errors.push("complete NapCat candidate BlockDraft exceeds the frozen byte budget");
  }
  if (kind === "content_free_hint") {
    if (!exactKeys(draft, ["schema", "parts", "actions"])) errors.push("NapCat hint BlockDraft contains an extra top-level field");
    if (draft.schema !== "dolly.block-draft/v1" || draft.actions?.length !== 0 || draft.parts?.length !== 1) errors.push("NapCat hint BlockDraft does not have the exact one-Part/no-Action shape");
    const part = draft.parts?.[0];
    if (part?.kind !== "json" || part.schema_uri !== `${schemaBase}napcatqq-mailbox-changed.schema.json` ||
        canonicalJson(part.value) !== canonicalJson({ schema: "dolly.napcatqq-mailbox-changed/v1", kind: "qq_mailbox_changed" })) {
      errors.push("NapCat hint Part is not the exact content-free value");
    }
  } else if (kind === "facade_output") {
    if (!exactKeys(draft, ["schema", "parts", "actions"])) errors.push("NapCat facade output contains an unbudgeted top-level field");
    if (draft.actions?.length !== 0) errors.push("NapCat facade output must not emit Actions");
    const actionIds = context.orderedActionIds ?? [];
    if (draft.parts?.length !== actionIds.length) errors.push("NapCat facade output is not one result Part per Action");
    for (const [index, part] of (draft.parts ?? []).entries()) {
      if (part.kind !== "json" || part.schema_uri !== `${schemaBase}action-result.schema.json` || part.value?.action_id !== actionIds[index]) {
        errors.push(`NapCat facade output Part ${index} is not the ordered ActionResult`);
      }
    }
  } else if (kind === "media_ingress") {
    if (!exactKeys(draft, ["schema", "parts", "actions"])) errors.push("NapCat media ingress contains an extra top-level field");
    if (context.authenticatedModuleId !== context.hubModuleId) errors.push("NapCat media ingress is not produced by the authenticated hub");
    if (context.targetPageId !== context.privateResultPageId) errors.push("NapCat media ingress targets a non-private result Page");
    if (draft.actions?.length !== 0 || draft.parts?.length !== 2) errors.push("NapCat media ingress does not have the exact envelope/Asset shape");
    const envelopePart = draft.parts?.[0];
    const assetPart = draft.parts?.[1];
    const envelope = envelopePart?.value;
    const asset = context.authoritativeAsset;
    if (envelopePart?.kind !== "json" || envelopePart.schema_uri !== `${schemaBase}napcatqq-result.schema.json#/$defs/MediaDeliveryEnvelope`) errors.push("NapCat media ingress lacks the typed delivery envelope");
    if (assetPart?.kind !== "asset" || asset === undefined || envelope === undefined ||
        envelope.delivery_ingress_id !== context.deliveryIngressId || envelope.action_id !== context.actionId ||
        envelope.asset_id !== asset.asset_id || assetPart.asset_id !== asset.asset_id ||
        envelope.media_type !== asset.detected_media_type || assetPart.media_type !== asset.detected_media_type ||
        envelope.byte_length !== asset.byte_length || canonicalJson(envelope.content_hash) !== canonicalJson(asset.content_hash)) {
      errors.push("NapCat media ingress differs from its operation ledger or authoritative Asset record");
    }
  }
  return errors;
}

function napcatActionErrors(value, context = {}) {
  const errors = [];
  if (value.max_bytes !== undefined) {
    if (context.maxReadBytes !== undefined && value.max_bytes > context.maxReadBytes) {
      errors.push("NapCat Action exceeds the frozen read-byte limit");
    }
    if (context.maxOutputBlockBytes !== undefined && value.max_bytes + 2048 > context.maxOutputBlockBytes) {
      errors.push("NapCat Action exceeds the aggregate output reservation");
    }
  }
  if (value.family !== undefined && value.operation_key !== undefined) {
    if (value.registry_digest !== context.registryDigest) errors.push("NapCat invoke registry digest is not frozen/current");
    const entry = context.registry?.find((candidate) => candidate.operation_key === value.operation_key);
    if (entry === undefined) {
      errors.push("NapCat invoke operation key is absent from the pinned registry");
    } else {
      if (entry.family !== value.family) errors.push("NapCat invoke family differs from the pinned operation family");
      if (entry.sanitizer_digest !== value.sanitizer_digest) errors.push("NapCat invoke sanitizer digest differs from the pinned entry");
    }
  }
  return errors;
}

const allowAllNapcatPolicy = {
  read: true,
  notify: "direct_and_mention",
  send: true,
  upload: true,
  message_control: true,
  moderate: false,
  manage: false,
  catalog_invoke: true,
};
const validNapcatHubConfig = {
  schema: "dolly.napcatqq-config/v1",
  module_role: "shared_hub",
  runtime_mode: "active",
  account_ref: "qq-main",
  host_account_principal: "qq-principal-main",
  expected_self_id: "123456789",
  connection: {
    mode: "forward_websocket",
    websocket_endpoint: "ws://127.0.0.1:3001/onebot",
    http_endpoint: "http://127.0.0.1:3000/api",
    credential_ref: "secret://napcat/qq-main",
    allow_non_loopback: false,
  },
  ownership: { mode: "daemon_wide_exclusive", cross_daemon_active_write: "unsupported_v1" },
  compatibility: {
    profile: "napcat-onebot-v11",
    registry_digest: testDigest("4"),
    minimum_napcat_version: "4.8.0",
  },
  account_policy: allowAllNapcatPolicy,
  consumer_rules: [{
    consumer_principal: { instance_id: "main", module_id: "agent-a" },
    policy: allowAllNapcatPolicy,
  }],
  conversation_rules: [],
  denied_operation_keys: ["restart-account-process"],
  notifications: { debounce_ms: 200, max_hints_per_minute: 120, critical_page_durable: true },
  media: {
    capture_mode: "lazy",
    convert_silk: true,
    max_asset_bytes: 1048576,
    max_forward_depth: 3,
    max_forward_messages: 100,
  },
  limits: {
    max_journal_events: 100000,
    max_journal_bytes: 1073741824,
    max_normalized_event_bytes: 1048576,
    send_per_minute: 60,
    management_per_minute: 10,
  },
};
assertValid("NapCat shared hub config", `${schemaBase}napcatqq-hub-config.schema.json`, validNapcatHubConfig);
assertSemantic("NapCat shared hub config semantics", napcatConfigErrors, validNapcatHubConfig);
const validNapcatHubProfileContext = {
  profileAdmissionValidator: napcatProfileAdmissionValidator,
  hosting: "per_extension",
  moduleType: "napcat-onebot-v11-hub",
  configSchemaUri: "schemas/napcatqq-hub-config.schema.json",
  outputPageIds: [],
};
assertSemantic("NapCat hub control/profile admission", napcatProfileConfigErrors, validNapcatHubConfig, true, validNapcatHubProfileContext);
assertSemantic(
  "duplicate daemon-wide NapCat owner",
  napcatConfigErrors,
  validNapcatHubConfig,
  false,
  { activeOwnerKeys: ["qq-principal-main/123456789"] },
);
assertSemantic(
  "duplicate NapCat actual self under another principal alias",
  napcatConfigErrors,
  { ...validNapcatHubConfig, host_account_principal: "qq-principal-alias-record" },
  false,
  { actualSelfId: "123456789", activeActualSelfIds: ["123456789"] },
);
const hostnameNapcatHubConfig = structuredClone(validNapcatHubConfig);
hostnameNapcatHubConfig.connection.websocket_endpoint = "ws://localhost:3001/onebot";
assertValid("schema-valid NapCat hostname endpoint", `${schemaBase}napcatqq-hub-config.schema.json`, hostnameNapcatHubConfig);
assertSemantic("NapCat literal-loopback endpoint", napcatConfigErrors, hostnameNapcatHubConfig, false);
const alternateLoopbackNapcatHubConfig = structuredClone(validNapcatHubConfig);
alternateLoopbackNapcatHubConfig.connection.websocket_endpoint = "ws://127.1:3001/onebot";
assertSemantic("NapCat alternate loopback spelling", napcatConfigErrors, alternateLoopbackNapcatHubConfig, false);
for (const endpoint of [
  "ws://user:secret@127.0.0.1:3001/onebot",
  "ws://127.0.0.1:3001/onebot?token=secret",
  "ws://127.0.0.1:3001/onebot#fragment",
]) {
  const invalid = structuredClone(validNapcatHubConfig);
  invalid.connection.websocket_endpoint = endpoint;
  assertValid(`NapCat forbidden endpoint ${endpoint}`, `${schemaBase}napcatqq-hub-config.schema.json`, invalid, false);
}
const remoteCleartextHubConfig = structuredClone(validNapcatHubConfig);
remoteCleartextHubConfig.connection.allow_non_loopback = true;
remoteCleartextHubConfig.connection.websocket_endpoint = "ws://192.0.2.10:3001/onebot";
remoteCleartextHubConfig.connection.http_endpoint = "http://192.0.2.10:3000/api";
assertValid("schema-valid remote cleartext NapCat endpoint", `${schemaBase}napcatqq-hub-config.schema.json`, remoteCleartextHubConfig);
assertSemantic("remote cleartext NapCat endpoint", napcatConfigErrors, remoteCleartextHubConfig, false);

const validNapcatFacadeConfig = {
  schema: "dolly.napcatqq-config/v1",
  module_role: "consumer_facade",
  runtime_mode: "active",
  account_ref: "qq-main",
  host_account_principal: "qq-principal-main",
  hub_module_id: "qq-hub-main",
  consumer_principal: { instance_id: "main", module_id: "agent-a" },
  private_result_page_id: "qq-a-results",
  private_notification_page_id: "qq-a-hints",
  output_limits: {
    max_actions_per_activation: 16,
    max_output_block_bytes: 65536,
    max_read_events: 100,
    max_read_bytes: 32768,
    max_top_level_parts: 32,
    max_attached_assets: 8,
    max_attached_asset_bytes: 1048576,
  },
};
const napcatPrincipalCohort = [{ instance_id: "main", module_id: "agent-a" }];
const validNapcatFacadeContext = {
  coreMaxBlocks: 1,
  resultPageSubscribers: napcatPrincipalCohort,
  notificationPageSubscribers: napcatPrincipalCohort,
};
assertValid("NapCat consumer facade config", `${schemaBase}napcatqq-facade-config.schema.json`, validNapcatFacadeConfig);
assertSemantic("NapCat private facade graph", napcatConfigErrors, validNapcatFacadeConfig, true, validNapcatFacadeContext);
const validNapcatFacadeProfileContext = {
  ...validNapcatFacadeContext,
  profileAdmissionValidator: napcatProfileAdmissionValidator,
  hosting: "per_extension",
  moduleType: "napcat-onebot-v11-facade",
  configSchemaUri: "schemas/napcatqq-facade-config.schema.json",
  outputPageIds: ["qq-a-results"],
  hubIngressPageIds: ["qq-a-results", "qq-a-hints"],
  hubModuleType: "napcat-onebot-v11-hub",
  extensionAlias: "channel-main",
  hubExtensionAlias: "channel-main",
  processCohort: "channel-main-generation-7",
  hubProcessCohort: "channel-main-generation-7",
  hubAccountRef: "qq-main",
  hubAccountPrincipal: "qq-principal-main",
  storageScopeId: "scope-facade-a",
  hubStorageScopeId: "scope-hub-main",
};
assertSemantic("NapCat facade control/profile admission", napcatProfileConfigErrors, validNapcatFacadeConfig, true, validNapcatFacadeProfileContext);
assertSemantic(
  "NapCat facade extra public output",
  napcatProfileConfigErrors,
  validNapcatFacadeConfig,
  false,
  { ...validNapcatFacadeProfileContext, outputPageIds: ["qq-a-results", "public-debug"] },
);
assertSemantic(
  "NapCat per_module placement",
  napcatProfileConfigErrors,
  validNapcatFacadeConfig,
  false,
  { ...validNapcatFacadeProfileContext, hosting: "per_module", processCohort: "facade-process" },
);
assertSemantic(
  "NapCat aliased hub/facade storage scope",
  napcatProfileConfigErrors,
  validNapcatFacadeConfig,
  false,
  { ...validNapcatFacadeProfileContext, storageScopeId: "scope-hub-main" },
);
assertSemantic(
  "NapCat shared result Page",
  napcatConfigErrors,
  validNapcatFacadeConfig,
  false,
  {
    ...validNapcatFacadeContext,
    resultPageSubscribers: [
      ...napcatPrincipalCohort,
      { instance_id: "main", module_id: "agent-b" },
    ],
  },
);
const invalidCrossDaemonLeaseConfig = structuredClone(validNapcatHubConfig);
invalidCrossDaemonLeaseConfig.ownership.external_lease_ref = "lease-7";
assertValid(
  "NapCat v1 external lease field",
  `${schemaBase}napcatqq-hub-config.schema.json`,
  invalidCrossDaemonLeaseConfig,
  false,
);

const mailboxChangedHint = { schema: "dolly.napcatqq-mailbox-changed/v1", kind: "qq_mailbox_changed" };
assertValid("content-free NapCat mailbox hint", `${schemaBase}napcatqq-mailbox-changed.schema.json`, mailboxChangedHint);
assertValid(
  "contentful NapCat mailbox hint",
  `${schemaBase}napcatqq-mailbox-changed.schema.json`,
  { ...mailboxChangedHint, message_count: 1 },
  false,
);

const napcatMailboxArgs = {
  operation: "read",
  after_cursor: "1041",
  filters: { conversations: [], event_kinds: ["message"], mentions_only: false, requests_only: false },
  limit: 20,
  max_bytes: 32768,
  include_segments: true,
  media_mode: "references_only",
};
assertValid("NapCat mailbox arguments", `${schemaBase}napcatqq-action.schema.json#/$defs/MailboxArgs`, napcatMailboxArgs);
assertSemantic(
  "NapCat mailbox Action reservation",
  napcatActionErrors,
  napcatMailboxArgs,
  true,
  { maxReadBytes: 32768, maxOutputBlockBytes: 65536 },
);
assertSemantic(
  "NapCat mailbox Action exceeds reservation",
  napcatActionErrors,
  napcatMailboxArgs,
  false,
  { maxReadBytes: 16384, maxOutputBlockBytes: 20000 },
);
const napcatViewSendArgs = {
  selector: { view: { view_id: testUuid(422), expected_view_epoch: 7 } },
  segments: [{ kind: "text", text: "hello", format: "plain" }],
  reply_to_message_id: null,
};
assertValid("NapCat QQ view send", `${schemaBase}napcatqq-action.schema.json#/$defs/QqSendArgs`, napcatViewSendArgs);
assertValid(
  "NapCat QQ view send without epoch",
  `${schemaBase}napcatqq-action.schema.json#/$defs/QqSendArgs`,
  { ...napcatViewSendArgs, selector: { view: { view_id: testUuid(422) } } },
  false,
);

const weirdNapcatRegistry = [{
  operation_key: "send-group-message-async-v2",
  upstream_name: "Send.Group_Message_Async.v2/测试",
  family: "mutate",
  sanitizer_digest: testDigest("6"),
}];
const napcatInvokeArgs = {
  family: "mutate",
  registry_digest: testDigest("5"),
  operation_key: "send-group-message-async-v2",
  sanitizer_digest: testDigest("6"),
  arguments: { group_id: "123456789", message: "hello" },
  selector: { conversation: { kind: "group", id: "123456789" } },
};
assertValid("NapCat canonical operation-key invoke", `${schemaBase}napcatqq-action.schema.json#/$defs/MutateInvokeArgs`, napcatInvokeArgs);
assertSemantic(
  "NapCat pinned canonical operation-key invoke",
  napcatActionErrors,
  napcatInvokeArgs,
  true,
  { registryDigest: testDigest("5"), registry: weirdNapcatRegistry },
);
if (weirdNapcatRegistry[0].upstream_name !== "Send.Group_Message_Async.v2/测试") {
  throw new Error("NapCat canonical operation key did not retain the exact strange upstream name");
}
assertValid(
  "NapCat invoke raw upstream name",
  `${schemaBase}napcatqq-action.schema.json#/$defs/MutateInvokeArgs`,
  { ...napcatInvokeArgs, operation_name: "Send.Group_Message_Async.v2/测试" },
  false,
);

const napcatResultBinding = { semantic_validator: napcatResultValidator };
const validNapcatMailboxResult = {
  schema: "dolly.napcatqq-mailbox-result/v1",
  operation: "read",
  events: [{
    cursor: "1042",
    event_kind: "message",
    conversation: { kind: "group", id: "123456789" },
    sender_id: "987654321",
    received_at: "2026-08-12T10:00:00.000000Z",
    message_id: "message-1042",
    segments: [
      { kind: "text", text: "untrusted text", truncated: false },
      { kind: "media_ref", ordinal: 0, media_handle: "qq-media-1042-0", media_kind: "image", state: "available", media_type: "image/png", byte_length: 12, expires_at: null },
    ],
    normalized_payload_digest: testDigest("7"),
  }],
  next_cursor: "1042",
  has_more: false,
  oldest_available_cursor: "1040",
  ack_cursor: "1041",
  gaps: [],
};
assertValid("NapCat restricted mailbox segments", `${schemaBase}napcatqq-result.schema.json#/$defs/MailboxResult`, validNapcatMailboxResult);
assertBoundResultSemantic(
  "NapCat ordered bounded mailbox result",
  napcatResultBinding,
  validNapcatMailboxResult,
  true,
  { arguments: napcatMailboxArgs, maxOutputBlockBytes: 65536 },
);
const nestedAssetMailbox = structuredClone(validNapcatMailboxResult);
nestedAssetMailbox.events[0].segments[1] = { kind: "asset", asset_id: testAssetId, media_type: "image/png" };
assertValid(
  "NapCat mailbox embeds common Asset Part",
  `${schemaBase}napcatqq-result.schema.json#/$defs/MailboxResult`,
  nestedAssetMailbox,
  false,
);

const napcatMediaResult = {
  schema: "dolly.napcatqq-media-result/v1",
  media_handle: "qq-media-1042-0",
  delivery_ingress_id: "0198ab31-6c44-7e8a-b2bb-000000000451",
  asset_id: testAssetId,
  media_type: "image/png",
  byte_length: 12,
  content_hash: { algorithm: "blake3-256", digest: "8".repeat(64) },
};
const napcatMediaContext = {
  arguments: { operation: "acquire", media_handle: "qq-media-1042-0", max_bytes: 1024 },
  maxOutputBlockBytes: 65536,
};
assertValid("NapCat independent media result", `${schemaBase}napcatqq-result.schema.json#/$defs/MediaResult`, napcatMediaResult);
assertBoundResultSemantic("NapCat media per-Action result", napcatResultBinding, napcatMediaResult, true, napcatMediaContext);

const napcatHintDraft = {
  schema: "dolly.block-draft/v1",
  parts: [{
    kind: "json",
    schema_uri: `${schemaBase}napcatqq-mailbox-changed.schema.json`,
    value: { schema: "dolly.napcatqq-mailbox-changed/v1", kind: "qq_mailbox_changed" },
  }],
  actions: [],
};
const napcatAdmissionContext = { profileAdmissionValidator: napcatProfileAdmissionValidator };
assertSemantic("NapCat exact content-free hint BlockDraft", (value, context) => napcatProfileBlockErrors("content_free_hint", value, context), napcatHintDraft, true, napcatAdmissionContext);
assertSemantic(
  "NapCat hint with smuggled metadata",
  (value, context) => napcatProfileBlockErrors("content_free_hint", value, context),
  { ...napcatHintDraft, metadata: { covert: "message" } },
  false,
  napcatAdmissionContext,
);

const napcatInputActionSet = {
  actions: Array.from({ length: 17 }, (_, index) => ({
    name: "org.dolly.channel.qq.mailbox",
    arguments: { operation: "read", max_bytes: 1024, ordinal: index },
  })),
};
assertSemantic(
  "NapCat aggregate Action-set admission",
  (value, context) => napcatProfileBlockErrors("input_action_set", value, context),
  napcatInputActionSet,
  false,
  {
    ...napcatAdmissionContext,
    outputLimits: validNapcatFacadeConfig.output_limits,
    errorEnvelopeReserveBytes: 2048,
  },
);

const napcatFacadeActionIds = [
  "0198ab31-6c44-7e8a-b2bb-000000000461",
  "0198ab31-6c44-7e8a-b2bb-000000000462",
];
const napcatFacadeOutputDraft = {
  schema: "dolly.block-draft/v1",
  parts: napcatFacadeActionIds.map((actionId) => ({
    kind: "json",
    schema_uri: `${schemaBase}action-result.schema.json`,
    value: { action_id: actionId },
  })),
  actions: [],
};
const napcatFacadeOutputContext = {
  ...napcatAdmissionContext,
  orderedActionIds: napcatFacadeActionIds,
  maxOutputBlockBytes: 65536,
};
assertSemantic("NapCat complete facade output admission", (value, context) => napcatProfileBlockErrors("facade_output", value, context), napcatFacadeOutputDraft, true, napcatFacadeOutputContext);
assertSemantic(
  "NapCat facade output with sibling Asset",
  (value, context) => napcatProfileBlockErrors("facade_output", value, context),
  { ...napcatFacadeOutputDraft, parts: [...napcatFacadeOutputDraft.parts, { kind: "asset", asset_id: testAssetId, media_type: "image/png" }] },
  false,
  napcatFacadeOutputContext,
);

const napcatAuthoritativeAsset = {
  asset_id: testAssetId,
  detected_media_type: "image/png",
  byte_length: 12,
  content_hash: { algorithm: "blake3-256", digest: "8".repeat(64) },
};
const napcatMediaDeliveryEnvelope = {
  schema: "dolly.napcatqq-media-delivery/v1",
  action_id: "0198ab31-6c44-7e8a-b2bb-000000000471",
  delivery_ingress_id: napcatMediaResult.delivery_ingress_id,
  media_handle: napcatMediaResult.media_handle,
  asset_id: testAssetId,
  media_type: "image/png",
  byte_length: 12,
  content_hash: napcatAuthoritativeAsset.content_hash,
};
assertValid("NapCat media delivery envelope", `${schemaBase}napcatqq-result.schema.json#/$defs/MediaDeliveryEnvelope`, napcatMediaDeliveryEnvelope);
const napcatMediaIngressDraft = {
  schema: "dolly.block-draft/v1",
  parts: [
    { kind: "json", schema_uri: `${schemaBase}napcatqq-result.schema.json#/$defs/MediaDeliveryEnvelope`, value: napcatMediaDeliveryEnvelope },
    { kind: "asset", asset_id: testAssetId, media_type: "image/png" },
  ],
  actions: [],
};
const napcatMediaIngressContext = {
  ...napcatAdmissionContext,
  authenticatedModuleId: "qq-hub-main",
  hubModuleId: "qq-hub-main",
  targetPageId: "qq-a-results",
  privateResultPageId: "qq-a-results",
  deliveryIngressId: napcatMediaResult.delivery_ingress_id,
  actionId: napcatMediaDeliveryEnvelope.action_id,
  authoritativeAsset: napcatAuthoritativeAsset,
  maxOutputBlockBytes: 65536,
};
assertSemantic("NapCat hub-owned media ingress", (value, context) => napcatProfileBlockErrors("media_ingress", value, context), napcatMediaIngressDraft, true, napcatMediaIngressContext);
const forgedNapcatMediaIngress = structuredClone(napcatMediaIngressDraft);
forgedNapcatMediaIngress.parts[0].value.byte_length = 1;
assertSemantic("NapCat forged media metadata", (value, context) => napcatProfileBlockErrors("media_ingress", value, context), forgedNapcatMediaIngress, false, napcatMediaIngressContext);

const napcatInvokeResult = {
  schema: "dolly.napcatqq-invoke-result/v1",
  registry_digest: napcatInvokeArgs.registry_digest,
  family: "mutate",
  operation_key: napcatInvokeArgs.operation_key,
  sanitizer_digest: napcatInvokeArgs.sanitizer_digest,
  upstream_request_id: "request-1",
  sanitized_value: { accepted: true },
};
assertValid("NapCat sanitized invoke result", `${schemaBase}napcatqq-result.schema.json#/$defs/InvokeResult`, napcatInvokeResult);
assertBoundResultSemantic(
  "NapCat invoke frozen bindings",
  napcatResultBinding,
  napcatInvokeResult,
  true,
  { arguments: napcatInvokeArgs, maxOutputBlockBytes: 65536 },
);
assertBoundResultSemantic(
  "NapCat invoke sanitizer mismatch",
  napcatResultBinding,
  { ...napcatInvokeResult, sanitizer_digest: testDigest("9") },
  false,
  { arguments: napcatInvokeArgs, maxOutputBlockBytes: 65536 },
);
assertBoundResultSemantic(
  "NapCat invoke retains signed URI",
  napcatResultBinding,
  { ...napcatInvokeResult, sanitized_value: { url: "https://u:p@example.invalid/a?token=x" } },
  false,
  { arguments: napcatInvokeArgs, maxOutputBlockBytes: 65536 },
);
for (const forbiddenField of ["password", "authorization", "client_key"]) {
  assertValid(
    `NapCat closed sanitizer rejects ${forbiddenField}`,
    `${schemaBase}napcatqq-result.schema.json#/$defs/InvokeResult`,
    { ...napcatInvokeResult, sanitized_value: { [forbiddenField]: "x" } },
    false,
  );
}

console.log(`OK: compiled ${schemas.length} Draft 2020-12 schemas, ${methodContracts.length} request and ${notificationContracts.length} notification contracts, and validated ${cases.length + protocolExampleCases.length} repository instances plus negative smoke cases`);
