## Description

Please include a summary of the changes and the motivation behind them.

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactoring / Performance improvement

## Checklist

- [ ] My code adheres to the coding and architectural style of this project.
- [ ] I have not manually edited `src/tools/generated-registry.ts` or `src/generated/build-meta.ts`.
- [ ] Any new tools include a valid `ToolMetadata` export with appropriate category (`safe`, `diagnostics`, `benchmark`, `admin`).
- [ ] I have added tests covering my changes.
- [ ] `npm run typecheck` passes with zero errors.
- [ ] `npm test` passes completely.
- [ ] `npm run build` succeeds cleanly.
- [ ] `npm run pack:check` passes without including unwanted files.
- [ ] No personal paths, credentials, or machine-specific artifacts are included.
