# Release Checklist & Automation Gate

This document serves as the pre-release checklist and automated release gate for publishing public releases of the **High-Performance MCP Server**.

---

## 1. Version Preparation & Metadata Synchronization

- [ ] Version updated synchronously in `package.json` (`version`)
- [ ] Version updated synchronously in `server.json` (`version` and `packages[0].version`)
- [ ] `mcpName` in `package.json` matches `server.json.name` (`io.github.AnIayana/high-performance-mcp-server`)
- [ ] `CHANGELOG.md` updated with new version section `## [X.Y.Z] - YYYY-MM-DD` and release notes
- [ ] Code generator executed: `npm run generate`
- [ ] Auto-generated files drift check passes: `npm run check:generated`

---

## 2. Pre-Release Quality & Security Gates

- [ ] TypeScript compilation passes: `npm run typecheck`
- [ ] Full test suites pass 100%: `npm test` (including release automation tests)
- [ ] Production build succeeds: `npm run build`
- [ ] Repository candidate security scan passes: `npm run security:repo`
- [ ] Package payload security scan passes: `npm run security:package`
- [ ] Package manifest & dry-run inspection: `npm run pack:check`
- [ ] End-to-end tarball installation smoke test passes: `npm run smoke:package`
- [ ] Dependency security audit clean: `npm audit --omit=dev` (0 vulnerabilities)

---

## 3. Git Tag & Commit Gate

- [ ] Release commit created on `main` branch
- [ ] Annotated release tag created: `git tag -a vX.Y.Z -m "vX.Y.Z"`
- [ ] Main branch and tag pushed to remote origin: `git push origin main --follow-tags`
- [ ] Remote tag verified on GitHub and matches HEAD commit

---

## 4. Automated Release Pipeline Execution

- [ ] npm Trusted Publisher configured on npmjs.com (or via `npm trust github` with `npm >= 11.15.0`) for `release.yml` and `release` environment
- [ ] GitHub Environment `release` configured on GitHub with maintainer review approval gates
- [ ] **Release Workflow Dry-Run**: Trigger `Release` workflow with `version: X.Y.Z` and `dry_run: true` (verifies all quality gates pass without requiring git tag)
- [ ] **Release Workflow Publication**: Trigger `Release` workflow with `version: X.Y.Z` and `dry_run: false` (requires git tag matching HEAD)
- [ ] npm package published via OIDC trusted publishing (`npmPublished = true`)
- [ ] npm package provenance verified on npmjs.com
- [ ] MCP Registry published via GitHub OIDC (`mcpRegistryPublished = true`)
- [ ] MCP Registry API verified: `io.github.AnIayana/high-performance-mcp-server@X.Y.Z` is active
- [ ] GitHub Release `vX.Y.Z` created with generated release notes

