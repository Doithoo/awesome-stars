# Awesome Stars

A searchable, responsive catalog of repositories starred by Doithoo. The public UI is in English and the catalog updates every six hours.

[Live site](https://doithoo.github.io/awesome-stars/) | [Source](https://github.com/Doithoo/awesome-stars) | [MIT License](LICENSE) | [中文](README.zh-CN.md)

## Overview

This project presents Doithoo's starred GitHub repositories in a Graphic Signal interface. The English UI supports search, language and quick filters, stable sorting, paginated loading, and responsive desktop and mobile layouts. Catalog data updates every six hours.

## Features

- Search names, descriptions, topics, owners, and languages.
- Filter and sort without mutating source data.
- Accessible loading, empty, error, and retry states.
- Safe rendering through DOM APIs and an explicit URL policy.
- Automated catalog generation, CI checks, and GitHub Pages delivery.

## Architecture

- `index.html` and `styles.css`: semantic shell and responsive visual system.
- `app.js`: loading, filtering, sorting, and pagination controller.
- `lib/catalog.mjs`: data normalization and catalog queries.
- `lib/view.mjs`: safe DOM construction for repository content.
- `data.json` and `data.md`: generated browser data and Markdown catalog. Each public repository's `starred_order` preserves its original GitHub API position so recently starred order remains accurate across language groups.
- `scripts/update-awesome-list.mjs`: authenticated star reader and atomic generator.
- `.github/workflows/main.yml` and `.github/workflows/static.yml`: update, test, and Pages automation.

The modular frontend keeps data, state, and rendering separate. The browser receives only the static application and catalog JSON, which reduces payload and keeps untrusted repository fields out of HTML string sinks.

## Local development

CI and automated tests target Node.js 22; use a compatible current Node.js release for local development:

```bash
npm ci
npm run preview
```

Open `http://127.0.0.1:4173`. `npm run dev` serves port 3000. The npm scripts resolve the lockfile-pinned local `serve` dependency.

## Update and deployment

Set `Settings > Pages > Source` to GitHub Actions and enable Actions. `Update awesome list` runs automatically every six hours and can also be dispatched manually. After its test gate, that workflow's scoped `GITHUB_TOKEN` commits refreshed `data.json` and `data.md`. Separately, `Deploy static content to Pages` repeats the test gate and uses least-privilege Pages write permission plus OIDC deployment authentication to publish the default branch.

## API token security

Create an Actions repository secret named `API_TOKEN`. Token types and GitHub UI labels can vary; configure only the minimum user-level `Starring: read` access required to read the user's stars. A fine-grained PAT needs no repository contents, repository write, Workflow, or private-repository access. Never expose the secret in source, logs, screenshots, issues, or build artifacts.

As defense in depth, the generator publishes only API entries explicitly marked public; private, internal, or unknown metadata is omitted automatically. The token must still have no private-repository access. All generated output in `data.json` and `data.md` is publicly committed and published by the site, so treat every generated field as public information.

## Testing

```bash
npm ci
npx playwright install chromium
npm run test:all
```

Alternatively, run `npm test` for generation, catalog logic, safe rendering, structure, and workflow contracts, or `npm run test:e2e` for Chromium browser coverage.

## License

Licensed under the [MIT License](LICENSE).
