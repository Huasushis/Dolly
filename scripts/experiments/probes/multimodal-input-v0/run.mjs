#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  BASE_CLOCK_SECONDS,
  EXPERIMENT_ID,
  PROFILES,
  ProbeError,
  buildChatRequest,
  byteLengthJson,
  canonicalJson,
  createBoundedImageFileTool,
  createModelMock,
  createPrivateObjectServer,
  dataUrl,
  decodeModelEvidence,
  enforceRequestLimit,
  generateFixtures,
  inspectImage,
  postCanonicalJson,
  preflightLocalImage,
  reconstructChunks,
  sha256,
} from "./common.mjs";
import {
  AETHER_MODEL_ID,
  FOLLOWUP_PROMPT,
  IMAGE_TASK_PROMPT,
  buildAetherChatRequest,
  callAetherChat,
  evaluateFollowupAnswer,
  evaluateImageAnswer,
  loadAetherConfiguration,
  probeAetherModels,
} from "./aether-client.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const runIdIndex = process.argv.indexOf("--run-id");
const runId = runIdIndex < 0 ? undefined : process.argv[runIdIndex + 1];
if (
  process.argv.length !== 4 ||
  runIdIndex !== 2 ||
  !/^v1-[a-z0-9][a-z0-9-]{0,63}$/u.test(runId ?? "")
) {
  throw new Error("usage: run.mjs --run-id v1-<unique-suffix>");
}
const artifactRoot = resolve(
  repositoryRoot,
  "artifacts/experiments/probes/multimodal-input-v0/runs",
  runId,
);
const expectedArtifactRoot = join(
  repositoryRoot,
  "artifacts/experiments/probes/multimodal-input-v0/runs",
  runId,
);
const preregistrationPath = join(
  repositoryRoot,
  "docs/experiments/preregistrations/multimodal-input-v0.json",
);

if (artifactRoot !== expectedArtifactRoot) {
  throw new Error("Resolved artifact root does not match the probe-owned path");
}
if (existsSync(artifactRoot)) {
  throw new Error(`Artifact directory already exists: ${artifactRoot}`);
}

mkdirSync(join(artifactRoot, "fixtures"), { recursive: true, mode: 0o700 });
mkdirSync(join(artifactRoot, "requests"), { recursive: true, mode: 0o700 });

function writeJson(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertProbe(condition, message, details = {}) {
  if (!condition) throw new ProbeError("PROBE_ASSERTION_FAILED", message, details);
}

function errorObservation(error) {
  return {
    code: error instanceof ProbeError ? error.code : "UNEXPECTED_EXCEPTION",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof ProbeError && Object.keys(error.details).length > 0
      ? { details: error.details }
      : {}),
  };
}

const rawCases = [];
async function runCase(definition, repetition, operation) {
  const started = process.hrtime.bigint();
  let observed;
  try {
    observed = await operation();
    if (!observed || typeof observed.code !== "string") {
      throw new ProbeError("PROBE_ASSERTION_FAILED", "Case returned no observed code");
    }
  } catch (error) {
    observed = errorObservation(error);
  }
  const durationNs = Number(process.hrtime.bigint() - started);
  const passed = observed.code === definition.expectedCode;
  rawCases.push({
    schemaVersion: "dolly.multimodal-input-probe-case/1",
    experimentId: EXPERIMENT_ID,
    runId,
    caseId: definition.id,
    family: definition.family,
    repetition,
    expectedCode: definition.expectedCode,
    observed,
    passed,
    durationNs,
  });
}

function saveRequest(caseId, repetition, request) {
  const name = `${caseId}-r${repetition}.json`;
  const path = join(artifactRoot, "requests", name);
  const bytes = Buffer.from(`${canonicalJson(request)}\n`, "utf8");
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    path: `requests/${name}`,
    digest: sha256(bytes),
    storedBytes: bytes.byteLength,
    canonicalBodyBytes: byteLengthJson(request),
  };
}

async function dispatch(caseId, repetition, modelOrigin, request) {
  const requestArtifact = saveRequest(caseId, repetition, request);
  const response = await postCanonicalJson(`${modelOrigin}/v1/chat/completions`, request);
  return { requestArtifact, response };
}

async function dispatchAether(caseId, repetition, request, configuration) {
  const requestArtifact = saveRequest(caseId, repetition, request);
  const result = await callAetherChat(configuration, request);
  return { requestArtifact, ...result };
}

function responseCode(response) {
  return response.body?.error?.code ?? (response.status === 200 ? "MODEL_OK" : "MODEL_ERROR_UNCLASSIFIED");
}

async function expectImageResponse(
  caseId,
  repetition,
  modelOrigin,
  request,
  expectedEvidence,
) {
  const { requestArtifact, response } = await dispatch(
    caseId,
    repetition,
    modelOrigin,
    request,
  );
  if (response.status !== 200) {
    return {
      code: responseCode(response),
      requestArtifact,
      responseStatus: response.status,
      responseBody: response.body,
    };
  }
  const evidence = decodeModelEvidence(response.body);
  for (const [key, value] of Object.entries(expectedEvidence)) {
    assertProbe(evidence[key] === value, `Model evidence ${key} differs`, {
      expected: value,
      observed: evidence[key],
    });
  }
  return {
    code: "MODEL_IMAGE_OK",
    requestArtifact,
    responseStatus: response.status,
    evidence,
  };
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

const preregistrationBytes = readFileSync(preregistrationPath);
const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
const aetherConfiguration = loadAetherConfiguration();
const fixtures = await generateFixtures();
const fixturePaths = {
  pngV1: join(artifactRoot, "fixtures/png-v1.png"),
  pngV2: join(artifactRoot, "fixtures/png-v2.png"),
  webpV1: join(artifactRoot, "fixtures/webp-v1.webp"),
  largePng: join(artifactRoot, "fixtures/large.png"),
  truncatedPng: join(artifactRoot, "fixtures/truncated.png"),
  croppedV1: join(artifactRoot, "fixtures/cropped-v1.png"),
  mutablePng: join(artifactRoot, "fixtures/tool-mutable.png"),
  agentTaskPng: join(artifactRoot, "fixtures/agent-task.png"),
};
for (const [key, path] of Object.entries(fixturePaths)) {
  if (key === "mutablePng") continue;
  writeFileSync(path, fixtures[key], { mode: 0o600 });
}
copyFileSync(fixturePaths.pngV1, fixturePaths.mutablePng);

const fixtureEvidence = {
  pngV1: await inspectImage(fixtures.pngV1),
  pngV2: await inspectImage(fixtures.pngV2),
  webpV1: await inspectImage(fixtures.webpV1),
  largePng: await inspectImage(fixtures.largePng),
  croppedV1: await inspectImage(fixtures.croppedV1),
  agentTaskPng: await inspectImage(fixtures.agentTaskPng),
  truncatedPng: {
    digest: sha256(fixtures.truncatedPng),
    byteLength: fixtures.truncatedPng.byteLength,
    expectedDecode: "failure",
  },
};
assertProbe(
  fixtureEvidence.largePng.byteLength > PROFILES["inline-vision-v0"].media.maxBytesPerItem,
  "Large fixture did not exceed the preregistered per-image limit",
);

const sourceConsumers = [
  "src/core/media-store.ts",
  "src/core/model-provider-chat.ts",
  "src/core/model-provider-broker.ts",
  "src/core/model-provider-descriptor.ts",
  "src/core/runtime-bootstrap.ts",
  "scripts/experiments/probes/multimodal-input-v0/common.mjs",
  "scripts/experiments/probes/multimodal-input-v0/aether-client.mjs",
  "scripts/experiments/probes/multimodal-input-v0/run.mjs",
  "scripts/experiments/probes/multimodal-input-v0/verify.mjs",
  "scripts/experiments/probes/memory-association-task-switch-v0/strict-chat-sse.mjs",
].map((path) => {
  const bytes = readFileSync(join(repositoryRoot, path));
  return { path, digest: sha256(bytes), byteLength: bytes.byteLength };
});

writeJson(join(artifactRoot, "manifest.json"), {
  schemaVersion: "dolly.multimodal-input-probe-manifest/1",
  experimentId: EXPERIMENT_ID,
  runId,
  preregistration: {
    path: relative(repositoryRoot, preregistrationPath),
    digest: sha256(preregistrationBytes),
    status: preregistration.status,
  },
  sourceRevision: preregistration.sourceRevision,
  dirtyWorktreeExpected: true,
  environment: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    sharp: sharpVersion(),
    processTempVariablesUsed: false,
    networkScope: "127.0.0.1 plus the configured Aether origin only",
    aether: aetherConfiguration.publicSummary,
    childProcessesStarted: 0,
    modulesStarted: 0,
  },
  sourceConsumers,
  capabilityProfiles: PROFILES,
  fixtureEvidence,
});

function sharpVersion() {
  try {
    const packagePath = fileURLToPath(new URL("../../../../../node_modules/sharp/package.json", import.meta.url));
    return JSON.parse(readFileSync(packagePath, "utf8")).version;
  } catch {
    return "installed-version-unavailable";
  }
}

const definitions = new Map(preregistration.cases.map((entry) => [entry.id, entry]));
function definition(caseId) {
  const result = definitions.get(caseId);
  if (!result) throw new Error(`Preregistration omits case ${caseId}`);
  return result;
}

const rawModelProbe = await probeAetherModels(aetherConfiguration);
const modelProbe = {
  status: rawModelProbe.status,
  responseBytes: rawModelProbe.responseBytes,
  targetModelPresent: rawModelProbe.targetModelPresent,
  modelCount: rawModelProbe.modelCount,
};
writeJson(join(artifactRoot, "aether-model-probe.json"), {
  schemaVersion: "dolly.multimodal-aether-model-probe/1",
  ...modelProbe,
});

const objectServer = await createPrivateObjectServer();
const modelServer = await createModelMock({ allowedPrivateOrigin: objectServer.origin });

objectServer.put("image", "v1", fixtures.pngV1, true);
objectServer.put("image", "v2", fixtures.pngV2, true);

try {
  await runCase(definition("text-only-control"), 1, async () => {
    const request = buildChatRequest("text-only-v0", undefined, "transport control");
    enforceRequestLimit(PROFILES["text-only-v0"], request);
    const { requestArtifact, response } = await dispatch(
      "text-only-control",
      1,
      modelServer.origin,
      request,
    );
    return {
      code: responseCode(response),
      requestArtifact,
      responseStatus: response.status,
    };
  });

  for (let repetition = 1; repetition <= 3; repetition += 1) {
    await runCase(definition("inline-valid"), repetition, async () => {
      const profile = PROFILES["inline-vision-v0"];
      const inspected = await preflightLocalImage(profile, fixtures.pngV1, "image/png");
      const request = buildChatRequest(profile.modelId, dataUrl("image/png", fixtures.pngV1));
      const requestBytes = enforceRequestLimit(profile, request);
      const result = await expectImageResponse(
        "inline-valid",
        repetition,
        modelServer.origin,
        request,
        inspected,
      );
      return {
        ...result,
        deliveryDecision: "inline-data-url",
        metrics: {
          requestBytes,
          sourceBytes: fixtures.pngV1.byteLength,
          requestToSourceRatio: requestBytes / fixtures.pngV1.byteLength,
        },
      };
    });
  }

  await runCase(definition("inline-text-only-profile"), 1, async () => {
    await preflightLocalImage(PROFILES["text-only-v0"], fixtures.pngV1, "image/png");
    return { code: "PROBE_ASSERTION_FAILED" };
  });

  await runCase(definition("inline-unsupported-mime-preflight"), 1, async () => {
    await preflightLocalImage(PROFILES["inline-vision-v0"], fixtures.webpV1, "image/webp");
    return { code: "PROBE_ASSERTION_FAILED" };
  });

  await runCase(definition("inline-unsupported-mime-provider"), 1, async () => {
    const request = buildChatRequest(
      "inline-vision-v0",
      dataUrl("image/jpeg", fixtures.pngV1),
    );
    const { requestArtifact, response } = await dispatch(
      "inline-unsupported-mime-provider",
      1,
      modelServer.origin,
      request,
    );
    return { code: responseCode(response), requestArtifact, responseStatus: response.status };
  });

  await runCase(definition("inline-mime-mismatch-provider"), 1, async () => {
    const request = buildChatRequest(
      "inline-vision-v0",
      dataUrl("image/png", fixtures.webpV1),
    );
    const { requestArtifact, response } = await dispatch(
      "inline-mime-mismatch-provider",
      1,
      modelServer.origin,
      request,
    );
    return { code: responseCode(response), requestArtifact, responseStatus: response.status };
  });

  await runCase(definition("inline-item-over-limit"), 1, async () => {
    await preflightLocalImage(PROFILES["inline-vision-v0"], fixtures.largePng, "image/png");
    return { code: "PROBE_ASSERTION_FAILED" };
  });

  await runCase(definition("inline-request-over-limit"), 1, async () => {
    const profile = PROFILES["inline-vision-v0"];
    await preflightLocalImage(profile, fixtures.pngV1, "image/png");
    const request = buildChatRequest(
      profile.modelId,
      dataUrl("image/png", fixtures.pngV1),
      "x".repeat(17_000),
    );
    const requestArtifact = saveRequest("inline-request-over-limit", 1, request);
    try {
      enforceRequestLimit(profile, request);
    } catch (error) {
      if (error instanceof ProbeError) error.details = { ...error.details, requestArtifact };
      throw error;
    }
    return { code: "PROBE_ASSERTION_FAILED", requestArtifact };
  });

  await runCase(definition("inline-truncated-preflight"), 1, async () => {
    await preflightLocalImage(PROFILES["inline-vision-v0"], fixtures.truncatedPng, "image/png");
    return { code: "PROBE_ASSERTION_FAILED" };
  });

  await runCase(definition("inline-truncated-provider"), 1, async () => {
    const request = buildChatRequest(
      "inline-vision-v0",
      dataUrl("image/png", fixtures.truncatedPng),
    );
    const { requestArtifact, response } = await dispatch(
      "inline-truncated-provider",
      1,
      modelServer.origin,
      request,
    );
    return { code: responseCode(response), requestArtifact, responseStatus: response.status };
  });

  const imageTool = createBoundedImageFileTool(join(artifactRoot, "fixtures"));
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    await runCase(definition("tool-chunk-reconstruct"), repetition, async () => {
      const token = await imageTool.inspect(fixturePaths.pngV1);
      const chunks = [];
      for (let offset = 0; offset < token.byteLength; offset += token.maximumChunkBytes) {
        chunks.push(imageTool.readChunk(token, offset, token.maximumChunkBytes));
      }
      const reconstructed = reconstructChunks(chunks, token.byteLength, token.digest);
      assertProbe(sha256(reconstructed) === fixtureEvidence.pngV1.digest, "Tool reconstruction digest differs");
      return {
        code: "TOOL_RECONSTRUCTION_OK",
        token,
        chunks,
        metrics: {
          chunkCount: chunks.length,
          totalEncodedChunkBytes: chunks.reduce((sum, chunk) => sum + chunk.data.length, 0),
        },
      };
    });
  }

  await runCase(definition("tool-chunk-over-limit"), 1, async () => {
    const token = await imageTool.inspect(fixturePaths.pngV1);
    imageTool.readChunk(token, 0, token.maximumChunkBytes + 1);
    return { code: "PROBE_ASSERTION_FAILED" };
  });

  await runCase(definition("tool-file-changed"), 1, async () => {
    copyFileSync(fixturePaths.pngV1, fixturePaths.mutablePng);
    const token = await imageTool.inspect(fixturePaths.mutablePng);
    writeFileSync(fixturePaths.mutablePng, fixtures.truncatedPng, { mode: 0o600 });
    imageTool.readChunk(token, 0, token.maximumChunkBytes);
    return { code: "PROBE_ASSERTION_FAILED" };
  });

  for (let repetition = 1; repetition <= 3; repetition += 1) {
    await runCase(definition("url-valid-full"), repetition, async () => {
      const profile = PROFILES["url-only-vision-v0"];
      const inspected = await preflightLocalImage(profile, fixtures.pngV1, "image/png");
      const grant = objectServer.sign({
        objectId: "image",
        version: "v1",
        requestedLifetimeSeconds: 60,
      });
      const request = buildChatRequest(profile.modelId, grant.url);
      enforceRequestLimit(profile, request);
      const result = await expectImageResponse(
        "url-valid-full",
        repetition,
        modelServer.origin,
        request,
        { ...inspected, fetchStatus: 200, objectVersion: "v1" },
      );
      return { ...result, deliveryDecision: "private-signed-url", grant };
    });
  }

  for (let repetition = 1; repetition <= 3; repetition += 1) {
    await runCase(definition("url-valid-signed-crop"), repetition, async () => {
      const profile = PROFILES["url-only-vision-v0"];
      const grant = objectServer.sign({
        objectId: "image",
        version: "v1",
        crop: fixtures.crop,
        requestedLifetimeSeconds: 60,
      });
      const request = buildChatRequest(profile.modelId, grant.url);
      enforceRequestLimit(profile, request);
      const result = await expectImageResponse(
        "url-valid-signed-crop",
        repetition,
        modelServer.origin,
        request,
        { ...fixtureEvidence.croppedV1, fetchStatus: 200, objectVersion: "v1" },
      );
      return { ...result, deliveryDecision: "private-signed-url", grant };
    });
  }

  await runCase(definition("url-crop-tampered"), 1, async () => {
    const grant = objectServer.sign({
      objectId: "image",
      version: "v1",
      crop: fixtures.crop,
      requestedLifetimeSeconds: 60,
    });
    const tampered = new URL(grant.url);
    tampered.searchParams.set("crop", "1,1,3,2");
    const request = buildChatRequest("url-only-vision-v0", tampered.toString());
    const { requestArtifact, response } = await dispatch(
      "url-crop-tampered",
      1,
      modelServer.origin,
      request,
    );
    return {
      code: responseCode(response),
      requestArtifact,
      responseStatus: response.status,
      signedCrop: fixtures.crop,
      tamperedCrop: { left: 1, top: 1, width: 3, height: 2 },
    };
  });

  await runCase(definition("url-expired"), 1, async () => {
    objectServer.setClock(BASE_CLOCK_SECONDS);
    const grant = objectServer.sign({
      objectId: "image",
      version: "v1",
      requestedLifetimeSeconds: 60,
    });
    objectServer.setClock(grant.expiresAt + 1);
    try {
      const request = buildChatRequest("url-only-vision-v0", grant.url);
      const { requestArtifact, response } = await dispatch(
        "url-expired",
        1,
        modelServer.origin,
        request,
      );
      return {
        code: responseCode(response),
        requestArtifact,
        responseStatus: response.status,
        grant,
        fetchAt: objectServer.getClock(),
      };
    } finally {
      objectServer.setClock(BASE_CLOCK_SECONDS);
    }
  });

  await runCase(definition("url-version-required"), 1, async () => {
    objectServer.sign({
      objectId: "image",
      version: undefined,
      requestedLifetimeSeconds: 60,
    });
    return { code: "PROBE_ASSERTION_FAILED" };
  });

  await runCase(definition("url-version-pinned-after-update"), 1, async () => {
    assertProbe(objectServer.currentVersion("image") === "v2", "Object current version is not v2");
    const grant = objectServer.sign({
      objectId: "image",
      version: "v1",
      requestedLifetimeSeconds: 60,
    });
    const request = buildChatRequest("url-only-vision-v0", grant.url);
    const result = await expectImageResponse(
      "url-version-pinned-after-update",
      1,
      modelServer.origin,
      request,
      { ...fixtureEvidence.pngV1, fetchStatus: 200, objectVersion: "v1" },
    );
    return {
      ...result,
      grant,
      currentVersionAtFetch: objectServer.currentVersion("image"),
      expectedPinnedDigest: fixtureEvidence.pngV1.digest,
      currentVersionDigest: fixtureEvidence.pngV2.digest,
    };
  });

  await runCase(definition("url-lifetime-clamped"), 1, async () => {
    const grant = objectServer.sign({
      objectId: "image",
      version: "v1",
      requestedLifetimeSeconds: 7200,
    });
    assertProbe(grant.clamped && grant.lifetimeSeconds === 60, "Signed lifetime was not clamped to 60 seconds");
    return { code: "SIGNED_URL_LIFETIME_CLAMPED", requestedLifetimeSeconds: 7200, grant };
  });

  await runCase(definition("url-delete-recovery"), 1, async () => {
    objectServer.put("delete-image", "v1", fixtures.pngV1, true);
    const grant = objectServer.sign({
      objectId: "delete-image",
      version: "v1",
      requestedLifetimeSeconds: 60,
    });
    objectServer.failNextDeletes("delete-image", "v1", 1);
    let journal = {
      objectId: "delete-image",
      version: "v1",
      state: "available",
      deleteAttempts: 0,
      lastErrorCode: null,
    };
    const transitions = [{ ...journal }];
    try {
      journal.deleteAttempts += 1;
      objectServer.deleteVersion(journal.objectId, journal.version);
      journal.state = "deleted";
    } catch (error) {
      journal.state = "delete-failed";
      journal.lastErrorCode = error.code ?? "UNKNOWN_DELETE_ERROR";
    }
    transitions.push({ ...journal });
    const restoredJournal = JSON.parse(canonicalJson(journal));
    assertProbe(restoredJournal.state === "delete-failed", "Deletion journal did not persist failure");
    restoredJournal.deleteAttempts += 1;
    const deletionResult = objectServer.deleteVersion(
      restoredJournal.objectId,
      restoredJournal.version,
    );
    restoredJournal.state = "deleted";
    restoredJournal.lastErrorCode = null;
    transitions.push({ ...restoredJournal });
    assertProbe(!objectServer.hasVersion("delete-image", "v1"), "Recovered delete left object version present");
    const request = buildChatRequest("url-only-vision-v0", grant.url);
    const { requestArtifact, response } = await dispatch(
      "url-delete-recovery",
      1,
      modelServer.origin,
      request,
    );
    assertProbe(responseCode(response) === "MODEL_FETCH_NOT_FOUND", "Deleted version did not return model fetch not-found");
    return {
      code: "MODEL_FETCH_NOT_FOUND_AFTER_RECOVERY",
      requestArtifact,
      responseStatus: response.status,
      grant,
      deletionResult,
      transitions,
    };
  });
} finally {
  await modelServer.close();
  await objectServer.close();
}

function strictAetherSuccess(result) {
  return result.response?.status === 200 &&
    result.response?.finishReason === "stop" &&
    typeof result.response?.message?.content === "string" &&
    result.response.message.content.length > 0 &&
    result.response.message.reasoningObserved === false &&
    result.streamEvidence?.usageEventCount === 1 &&
    result.streamEvidence?.doneCount === 1;
}

const visualUserMessage = {
  role: "user",
  content: [
    { type: "text", text: IMAGE_TASK_PROMPT },
    { type: "image_url", image_url: { url: dataUrl("image/png", fixtures.agentTaskPng) } },
  ],
};

await runCase(definition("aether-text-only-control"), 1, async () => {
  const request = buildAetherChatRequest([
    { role: "user", content: IMAGE_TASK_PROMPT },
  ]);
  const result = await dispatchAether(
    "aether-text-only-control",
    1,
    request,
    aetherConfiguration,
  );
  const evaluation = evaluateImageAnswer(result.response?.message?.content);
  return {
    code: strictAetherSuccess(result) && !evaluation.exact
      ? "AETHER_TEXT_CONTROL_NO_EXACT_VISUAL_ANSWER"
      : "AETHER_TEXT_CONTROL_INVALID",
    requestArtifact: result.requestArtifact,
    response: result.response,
    streamEvidence: result.streamEvidence,
    exactVisualAnswer: evaluation.exact,
  };
});

let firstImageContent = "";
for (let repetition = 1; repetition <= 3; repetition += 1) {
  await runCase(definition("aether-inline-image-understanding"), repetition, async () => {
    const request = buildAetherChatRequest([visualUserMessage]);
    const result = await dispatchAether(
      "aether-inline-image-understanding",
      repetition,
      request,
      aetherConfiguration,
    );
    const content = result.response?.message?.content;
    if (repetition === 1 && typeof content === "string") firstImageContent = content;
    const evaluation = evaluateImageAnswer(content);
    return {
      code: strictAetherSuccess(result) && evaluation.exact
        ? "AETHER_IMAGE_TASK_PASS"
        : "AETHER_IMAGE_TASK_FAIL",
      requestArtifact: result.requestArtifact,
      response: result.response,
      streamEvidence: result.streamEvidence,
      exactAnswer: evaluation.exact,
      parsedAnswer: evaluation.parsed,
      imageDigest: fixtureEvidence.agentTaskPng.digest,
    };
  });
}

await runCase(definition("aether-followup-image-use"), 1, async () => {
  const request = buildAetherChatRequest([
    visualUserMessage,
    { role: "assistant", content: firstImageContent },
    { role: "user", content: FOLLOWUP_PROMPT },
  ], 800);
  const result = await dispatchAether(
    "aether-followup-image-use",
    1,
    request,
    aetherConfiguration,
  );
  const evaluation = evaluateFollowupAnswer(result.response?.message?.content);
  return {
    code: strictAetherSuccess(result) && evaluation.exact
      ? "AETHER_FOLLOWUP_TASK_PASS"
      : "AETHER_FOLLOWUP_TASK_FAIL",
    requestArtifact: result.requestArtifact,
    response: result.response,
    streamEvidence: result.streamEvidence,
    exactAnswer: evaluation.exact,
    parsedAnswer: evaluation.parsed,
    imageDigest: fixtureEvidence.agentTaskPng.digest,
  };
});

const registeredExecutions = preregistration.cases.reduce(
  (sum, entry) => sum + entry.repetitions,
  0,
);
assertProbe(rawCases.length === registeredExecutions, "Executed case count differs from preregistration", {
  expected: registeredExecutions,
  observed: rawCases.length,
});

writeFileSync(
  join(artifactRoot, "raw-cases.jsonl"),
  `${rawCases.map(canonicalJson).join("\n")}\n`,
  { encoding: "utf8", mode: 0o600 },
);
writeJson(join(artifactRoot, "server-events.json"), {
  schemaVersion: "dolly.multimodal-input-server-events/1",
  objectFetches: objectServer.fetchEvents,
  modelRequests: modelServer.requestEvents,
});

const passed = rawCases.filter((entry) => entry.passed).length;
const failed = rawCases.length - passed;
const aetherCases = rawCases.filter((entry) => entry.family === "real-model");
const aetherPassed = aetherCases.filter((entry) => entry.passed).length;
const familyCounts = Object.fromEntries(
  [...new Set(rawCases.map((entry) => entry.family))]
    .sort()
    .map((family) => {
      const selected = rawCases.filter((entry) => entry.family === family);
      return [family, {
        executions: selected.length,
        passed: selected.filter((entry) => entry.passed).length,
        failed: selected.filter((entry) => !entry.passed).length,
      }];
    }),
);
writeJson(join(artifactRoot, "summary.json"), {
  schemaVersion: "dolly.multimodal-input-probe-summary/1",
  experimentId: EXPERIMENT_ID,
  runId,
  registeredCases: preregistration.cases.length,
  executions: rawCases.length,
  passed,
  failed,
  allRegisteredChecksPassed: failed === 0,
  familyCounts,
  conclusionScope: "local-transport-lifecycle-plus-optional-owner-aether-fixture",
  semanticVisionEvidence: aetherPassed === 5
    ? "fixed-endpoint-model-fixture-passed"
    : "fixed-endpoint-model-fixture-failed",
  aether: {
    model: AETHER_MODEL_ID,
    modelProbe,
    executions: aetherCases.length,
    passed: aetherPassed,
    exactImageRepetitions: aetherCases.filter((entry) =>
      entry.caseId === "aether-inline-image-understanding" && entry.passed
    ).length,
    textControlPassed: aetherCases.some((entry) =>
      entry.caseId === "aether-text-only-control" && entry.passed
    ),
    followupPassed: aetherCases.some((entry) =>
      entry.caseId === "aether-followup-image-use" && entry.passed
    ),
  },
  dollyProductSupport: "not-proven",
});

const digestEntries = {};
for (const path of listFiles(artifactRoot)) {
  const rel = relative(artifactRoot, path);
  if (rel === "sha256sums.json" || rel === "verification.json") continue;
  const bytes = readFileSync(path);
  digestEntries[rel] = { digest: sha256(bytes), byteLength: statSync(path).size };
}
writeJson(join(artifactRoot, "sha256sums.json"), {
  schemaVersion: "dolly.multimodal-input-probe-digests/1",
  algorithm: "sha256",
  files: digestEntries,
});

process.stdout.write(
  `${canonicalJson({ experimentId: EXPERIMENT_ID, runId, executions: rawCases.length, passed, failed, artifactRoot })}\n`,
);
if (failed > 0) process.exitCode = 1;
