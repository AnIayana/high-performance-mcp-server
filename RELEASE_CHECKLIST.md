# Release Checklist

This document serves as the pre-release and deployment gate checklist for publishing public releases of the **High-Performance MCP Server**.

---

## 1. Identity & Credentials

- [x] GitHub identity verified via authenticated GitHub account (`gh auth status`)
- [x] Public commit email/privacy confirmed (`git config user.email` uses noreply or private email)
- [x] npm identity verified via `npm whoami`
- [x] npm package name rechecked immediately before publish (`npm view`)
- [x] `mcpName` in `package.json` matches `server.json.name` exactly
- [x] `mcp-publisher validate` passes with official 2025-12-11 schema

---

## 2. Quality & Release Gates

- [x] Auto-generated files drift check: `npm run check:generated`
- [x] TypeScript compilation: `npm run typecheck`
- [x] Full test suites: `npm test`
- [x] Production build: `npm run build`
- [x] Repository candidate files security scan: `npm run security:repo`
- [x] Package security & privacy scan: `npm run security:package`
- [x] Package manifest & dry-run inspection: `npm run pack:check`
- [x] End-to-end tarball installation smoke test: `npm run smoke:package`

---

## 3. Security & Dependency Audits

- [x] Dependency security audit: `npm audit --omit=dev` (0 vulnerabilities)
- [x] Package payload verified: Zero source code, tests, or scripts included in tarball
- [x] Host machine path privacy: Zero development absolute paths (`C:\...`, `/Users/...`) in compiled bundle
- [x] Safe-by-default profile verified: Default binary execution exposes only `echo` and `ping`
- [x] Workspace traversal & symlink escape unit tests pass 100%
- [x] Prompt argument boundary escaping tests pass 100%

---

## 4. Release Execution

- [ ] `CHANGELOG.md` updated with release date and final version header
- [ ] Package version confirmed in `package.json` and `package-lock.json`
- [ ] Initial git commit created
- [ ] Remote GitHub repository linked and pushed
- [ ] Package published to npm registry (`npm publish --access public`)
- [ ] MCP Registry published (`mcp-publisher publish`)
- [ ] Git version tag created (`git tag v0.1.0`)
- [ ] GitHub release created with matching tag and changelog notes
