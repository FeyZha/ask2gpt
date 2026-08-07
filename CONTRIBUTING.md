# Contributing to Ask2GPT

Thanks for helping improve Ask2GPT. Keep changes focused, reviewable and consistent with the
read-only workspace boundary described in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Development setup

Requirements:

- Node.js 22.13+ or 24+ (current Node 24 LTS recommended)
- pnpm 11.20.0 through Corepack
- VS Code 1.96+
- Chrome 116+ for manual Relay testing

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm audit:dependencies
pnpm verify
pnpm package
```

Do not commit `node_modules`, `dist`, VSIX, ZIP, coverage, smoke state or local logs. Generated
release files are uploaded by CI/GitHub Releases and are intentionally ignored by Git.

## Required checks

Before submitting a change, run:

```powershell
pnpm verify
pnpm package
```

The CI and release workflows also require `pnpm audit:dependencies` to report no known production
or development dependency vulnerabilities through the official npm advisory endpoint.

`pnpm verify` includes formatting, TypeScript, ESLint, architecture-boundary checks, source identity
isolation, third-party license notices, workspace tests, Webview preview contracts, repeated
smoke-harness tests and production builds. `pnpm package` verifies the contents and versions of both
generated installation packages.

When production dependencies change, regenerate and review the committed notice file:

```powershell
pnpm notices:generate
pnpm notices:check
```

Changes that affect ChatGPT page interaction, Project discovery, reconnect/recovery, permissions,
multi-window routing or minimized-window behavior must also be checked against the relevant items in
[MANUAL_QA.md](./MANUAL_QA.md).

## Real-session smoke testing

The following command uses the signed-in local Chrome profile, opens ChatGPT tabs and creates remote
conversations. Run it only when those side effects are intentional:

```powershell
pnpm smoke:live -- --host-count 3 --connection-timeout-ms 180000 --generation-timeout-ms 180000
```

Never include prompts, answers, code, ChatGPT URLs, account identifiers, cookies or access tokens in
issues, pull requests, logs or test fixtures.

## Versioning and releases

Keep these versions identical:

- root `package.json`
- `apps/vscode-extension/package.json`
- `apps/chrome-extension/package.json`
- `packages/protocol/package.json`
- `apps/chrome-extension/public/manifest.json`

Update [CHANGELOG.md](./CHANGELOG.md), then create a tag matching the package version (`vX.Y.Z`). The
release workflow rejects mismatched tags and publishes the VSIX, Relay ZIP and SHA-256 checksums.

## Security reports

Do not disclose suspected vulnerabilities in a public issue. Follow the private reporting guidance
in [SECURITY.md](./SECURITY.md).
