import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_MCP_NAME,
  EXPECTED_PACKAGE_NAME,
  EXPECTED_REPO_URL,
  runReleaseValidation,
  validateReleaseMetadataInvariants,
  validateSemVerFormat,
  validateTagCommitEquality,
  verifyGitTagForRelease,
} from "../scripts/release/validate-release-version.js";
import {
  decideReleaseAction,
  determineReleasePlan,
} from "../scripts/release/verify-release-state.js";

test("Release Automation — Strict SemVer format validation", () => {
  // Valid SemVer formats
  assert.equal(validateSemVerFormat("0.1.0").valid, true);
  assert.equal(validateSemVerFormat("0.2.0").valid, true);
  assert.equal(validateSemVerFormat("1.0.0").valid, true);
  assert.equal(validateSemVerFormat("12.34.56").valid, true);

  // Reject leading 'v' or 'V'
  const vCheck = validateSemVerFormat("v0.2.0");
  assert.equal(vCheck.valid, false);
  assert.match(vCheck.error || "", /must not have a leading 'v'/i);

  const vUpperCheck = validateSemVerFormat("V1.0.0");
  assert.equal(vUpperCheck.valid, false);
  assert.match(vUpperCheck.error || "", /must not have a leading 'v'/i);

  // Reject leading zeros
  assert.equal(validateSemVerFormat("01.2.3").valid, false);
  assert.equal(validateSemVerFormat("1.02.3").valid, false);
  assert.equal(validateSemVerFormat("1.2.03").valid, false);

  // Reject non-numeric and suffixes
  assert.equal(validateSemVerFormat("0.2.0-beta").valid, false);
  assert.equal(validateSemVerFormat("0.2.0foo").valid, false);
  assert.equal(validateSemVerFormat("latest").valid, false);
  assert.equal(validateSemVerFormat("main").valid, false);
  assert.equal(validateSemVerFormat("../../x").valid, false);
  assert.equal(validateSemVerFormat("0.2").valid, false);
  assert.equal(validateSemVerFormat("").valid, false);
});

test("Release Automation — Release metadata invariant validation passes for valid structures", () => {
  const validPkg = {
    name: EXPECTED_PACKAGE_NAME,
    version: "0.2.0",
    mcpName: EXPECTED_MCP_NAME,
  };

  const validSrv = {
    name: EXPECTED_MCP_NAME,
    version: "0.2.0",
    repository: {
      url: EXPECTED_REPO_URL,
    },
    packages: [
      {
        registryType: "npm",
        identifier: EXPECTED_PACKAGE_NAME,
        version: "0.2.0",
        transport: {
          type: "stdio",
        },
      },
    ],
  };

  const errors = validateReleaseMetadataInvariants(validPkg, validSrv, "0.2.0");
  assert.deepEqual(errors, []);
});

test("Release Automation — Release metadata invariant validation detects mismatches", () => {
  const badPkg = {
    name: "wrong-name",
    version: "0.1.0",
    mcpName: "wrong-mcp-name",
  };

  const badSrv = {
    name: "wrong-srv-mcp-name",
    version: "0.1.0",
    repository: {
      url: "https://github.com/wrong/repo",
    },
    packages: [
      {
        registryType: "npm",
        identifier: "wrong-pkg",
        version: "0.1.0",
        transport: {
          type: "sse",
        },
      },
    ],
  };

  const errors = validateReleaseMetadataInvariants(badPkg, badSrv, "0.2.0");
  assert.ok(errors.length >= 7);
  assert.ok(errors.some((e) => e.includes("package.json name mismatch")));
  assert.ok(errors.some((e) => e.includes("package.json version mismatch")));
  assert.ok(errors.some((e) => e.includes("package.json mcpName mismatch")));
  assert.ok(errors.some((e) => e.includes("server.json name mismatch")));
  assert.ok(errors.some((e) => e.includes("server.json version mismatch")));
  assert.ok(errors.some((e) => e.includes("packages[0].identifier mismatch")));
  assert.ok(errors.some((e) => e.includes("packages[0].transport.type mismatch")));
});

test("Release Automation — Dry-Run vs Real Release Tag Validation semantics", () => {
  // Case D: Dry-run does NOT require Git tag (requireTag: false)
  const dryRunRes = runReleaseValidation({ version: "0.2.0", requireTag: false });
  assert.equal(dryRunRes.valid, true);
  assert.equal(dryRunRes.errors.length, 0);

  // Dry-run still validates version matching
  const dryRunMismatch = runReleaseValidation({ version: "0.3.0", requireTag: false });
  assert.equal(dryRunMismatch.valid, false);
  assert.ok(dryRunMismatch.errors.some((e) => e.includes("package.json version mismatch")));

  // Case E & F: Pure tag commit matching logic
  const matchResult = validateTagCommitEquality("0d39e7a", "0d39e7a", "v0.1.0");
  assert.equal(matchResult.valid, true);

  const mismatchResult = validateTagCommitEquality("959d9cb", "0d39e7a", "v0.1.0");
  assert.equal(mismatchResult.valid, false);
  assert.match(mismatchResult.error || "", /Tag must match HEAD commit exactly/i);

  const emptyTagResult = validateTagCommitEquality("959d9cb", "", "v0.2.0");
  assert.equal(emptyTagResult.valid, false);

  // Case G: Non-existent tag in real release mode fails gracefully
  const missingTagRes = runReleaseValidation({ version: "0.99.99", requireTag: true });
  assert.equal(missingTagRes.valid, false);
  assert.ok(missingTagRes.errors.some((e) => e.includes("Failed to resolve git tag") || e.includes("mismatch")));
});

test("Release Automation — Idempotency state machine decision logic", () => {
  // Case A: dryRun=true, all remote states false -> dry_run_validation
  const dryRunClean = decideReleaseAction({
    dryRun: true,
    npmPublished: false,
    mcpRegistryPublished: false,
    githubReleasePublished: false,
  });
  assert.equal(dryRunClean.status, "dry_run_validation");
  assert.equal(dryRunClean.shouldPublishNpm, false);
  assert.equal(dryRunClean.shouldPublishMcpRegistry, false);
  assert.equal(dryRunClean.shouldCreateGitHubRelease, false);

  // Case B: dryRun=true, all remote states true -> dry_run_validation (does not short-circuit dry run)
  const dryRunAllPublished = decideReleaseAction({
    dryRun: true,
    npmPublished: true,
    mcpRegistryPublished: true,
    githubReleasePublished: true,
  });
  assert.equal(dryRunAllPublished.status, "dry_run_validation");
  assert.equal(dryRunAllPublished.shouldPublishNpm, false);
  assert.equal(dryRunAllPublished.shouldPublishMcpRegistry, false);
  assert.equal(dryRunAllPublished.shouldCreateGitHubRelease, false);

  // Case C: dryRun=true, npm only exists -> dry_run_validation
  const dryRunNpmOnly = decideReleaseAction({
    dryRun: true,
    npmPublished: true,
    mcpRegistryPublished: false,
    githubReleasePublished: false,
  });
  assert.equal(dryRunNpmOnly.status, "dry_run_validation");
  assert.equal(dryRunNpmOnly.shouldPublishNpm, false);

  // Case H: Real release — clean start (nothing exists)
  const cleanReal = decideReleaseAction({
    dryRun: false,
    npmPublished: false,
    mcpRegistryPublished: false,
    githubReleasePublished: false,
  });
  assert.equal(cleanReal.status, "full_release");
  assert.equal(cleanReal.shouldPublishNpm, true);
  assert.equal(cleanReal.shouldPublishMcpRegistry, true);
  assert.equal(cleanReal.shouldCreateGitHubRelease, true);

  // Case I: Real release — Partial release (npm published, registry pending)
  const partialNpmReal = decideReleaseAction({
    dryRun: false,
    npmPublished: true,
    mcpRegistryPublished: false,
    githubReleasePublished: false,
  });
  assert.equal(partialNpmReal.status, "resume_from_registry");
  assert.equal(partialNpmReal.shouldPublishNpm, false);
  assert.equal(partialNpmReal.shouldPublishMcpRegistry, true);
  assert.equal(partialNpmReal.shouldCreateGitHubRelease, true);

  // Case J: Real release — Partial release (npm & registry published, github release pending)
  const partialRegistryReal = decideReleaseAction({
    dryRun: false,
    npmPublished: true,
    mcpRegistryPublished: true,
    githubReleasePublished: false,
  });
  assert.equal(partialRegistryReal.status, "resume_from_release");
  assert.equal(partialRegistryReal.shouldPublishNpm, false);
  assert.equal(partialRegistryReal.shouldPublishMcpRegistry, false);
  assert.equal(partialRegistryReal.shouldCreateGitHubRelease, true);

  // Case K: Real release — Fully published release (already_completed)
  const completeReal = decideReleaseAction({
    dryRun: false,
    npmPublished: true,
    mcpRegistryPublished: true,
    githubReleasePublished: true,
  });
  assert.equal(completeReal.status, "already_completed");
  assert.equal(completeReal.shouldPublishNpm, false);
  assert.equal(completeReal.shouldPublishMcpRegistry, false);
  assert.equal(completeReal.shouldCreateGitHubRelease, false);
});
