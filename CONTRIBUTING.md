# Contributing

Thanks for your interest in Relaycast. Bug reports, fixes and improvements
are welcome.

## Before you start

- **Security issues:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Bugs:** open an issue with the version or commit, what you expected, what
  happened, and the smallest reproduction you can manage. Remove credentials,
  tokens and personal data from logs before you paste them.
- **Larger changes:** open an issue first to discuss the approach, so your work
  doesn't conflict with something already in progress.

## Development

```sh
npm ci
npm run build
npm run lint
npm test
```

Run these checks before you open a pull request. CI (see `.github/workflows/`)
runs its own set of checks, which can differ slightly from this list; a green
CI run is required before merge.

## Pull requests

- Branch from `main` and keep each pull request focused on one change.
- Add or update tests for behaviour you change.
- Use short, conventional commit messages (`fix: ...`, `feat: ...`, `docs: ...`).
- Describe what changed and why, and how you tested it.
- Never commit secrets, credentials, real customer data or production
  identifiers, including in tests and fixtures. Use obviously fake values.
- Fork pull request CI runs without repository secrets. Workflows that use
  secrets run only from `main`, from release tags, or when a maintainer with
  write access starts them. The one exception is `preview.yml`, which uses
  Cloudflare secrets to tear down the preview environment when a pull request
  from a branch in this repository closes; it never runs for forks.

A maintainer reviews every pull request. We may ask for changes, or decline a
change that doesn't fit the project's direction.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the license of this repository.
