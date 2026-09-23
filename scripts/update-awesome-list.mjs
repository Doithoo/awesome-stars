import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STARRED_REPOSITORIES_URL =
  'https://api.github.com/user/starred?per_page=100&page=1';

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;

  for (const link of linkHeader.split(',')) {
    if (!/;\s*rel="next"\s*$/.test(link)) continue;

    const match = link.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (!match) throw new Error('GitHub API pagination link is invalid');

    try {
      const url = new URL(match[1]);
      if (url.origin !== 'https://api.github.com') throw new Error();
      return url.href;
    } catch {
      throw new Error('GitHub API pagination link is invalid');
    }
  }

  return null;
}

export async function fetchStarredRepositories(token, fetchImpl = fetch) {
  const repositories = [];
  let url = STARRED_REPOSITORIES_URL;

  while (url) {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `GitHub API request failed (${response.status}): ${details}`,
      );
    }

    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new Error('GitHub API response invalid: expected an array');
    }

    repositories.push(...page);
    url = nextPageUrl(response.headers.get('link'));
  }

  return repositories;
}

function isExplicitlyPublic(repository) {
  return repository?.private === false && repository.visibility === 'public';
}

export function projectRepository(repository, starredOrder) {
  if (!isExplicitlyPublic(repository)) {
    throw new Error('Repository cannot be published');
  }
  if (!Number.isSafeInteger(starredOrder) || starredOrder < 0) {
    throw new TypeError('Repository starred order must be a safe non-negative integer');
  }

  return {
    id: repository.id,
    name: repository.name,
    full_name: repository.full_name,
    owner: {
      login: repository.owner.login,
      avatar_url: repository.owner.avatar_url,
      html_url: repository.owner.html_url,
    },
    html_url: repository.html_url,
    description: repository.description,
    homepage: repository.homepage,
    stargazers_count: repository.stargazers_count,
    language: repository.language,
    topics: repository.topics,
    created_at: repository.created_at,
    updated_at: repository.updated_at,
    starred_order: starredOrder,
  };
}

export function groupRepositories(repositories) {
  const groups = {};

  for (const [starredOrder, repository] of repositories.entries()) {
    if (!isExplicitlyPublic(repository)) continue;

    const language = repository.language || 'miscellaneous';
    groups[language] ??= [];
    groups[language].push(projectRepository(repository, starredOrder));
  }

  return groups;
}

export function renderJson(groups) {
  return `${JSON.stringify(groups, null, 2)}\n`;
}

function headingSlug(language, counts) {
  const base = language
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
    .replace(/ /g, '-');
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function escapeHeading(language) {
  return language.replace(/([\\#])/g, '\\$1');
}

function escapeMarkdownText(value) {
  return value
    .replace(/([\\[_])/g, '\\$1')
    .replace(/&(?=[A-Za-z0-9])/g, '\\&');
}

export function renderMarkdown(groups) {
  const languages = Object.keys(groups);
  const slugCounts = new Map();
  const slugs = languages.map((language) => headingSlug(language, slugCounts));
  const lines = [
    '# [![Awesome](https://cdn.rawgit.com/sindresorhus/awesome/d7305f38d29fed78fa85652e3a63e154dd8e8829/media/badge.svg)](https://github.com/Doithoo) [![Awesome](https://badgen.net/static/GitHub/Repos/blue)](https://github.com/Doithoo)',
    '',
    '## Table of Contents',
    '',
    ...languages.map((language, index) => `* [${language}](#${slugs[index]})`),
    '',
  ];

  for (const language of languages) {
    lines.push(`## ${escapeHeading(language)}`, '');

    for (const repository of groups[language]) {
      const name = escapeMarkdownText(repository.full_name);
      const description = escapeMarkdownText(repository.description ?? '');
      lines.push(
        `* [${name}](${repository.html_url}) - ${description}`.trimEnd(),
        '',
      );
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export async function writeOutputs(
  groups,
  outputDirectory = process.cwd(),
  operations = { rename, rm, writeFile },
) {
  const outputs = [
    ['data.json', renderJson(groups)],
    ['data.md', renderMarkdown(groups)],
  ];
  const targetFiles = outputs.map(([filename]) =>
    path.join(outputDirectory, filename));
  const temporaryFiles = outputs.map(([filename]) =>
    path.join(outputDirectory, `.${filename}.${process.pid}.tmp`));
  const backupFiles = outputs.map(([filename]) =>
    path.join(outputDirectory, `.${filename}.${process.pid}.backup`));
  const backedUp = new Set();
  const installed = new Set();
  let cleanBackups = false;

  try {
    await Promise.all(outputs.map(([, contents], index) =>
      operations.writeFile(temporaryFiles[index], contents, 'utf8')));

    for (let index = 0; index < outputs.length; index += 1) {
      try {
        await operations.rename(targetFiles[index], backupFiles[index]);
        backedUp.add(index);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    for (let index = 0; index < outputs.length; index += 1) {
      await operations.rename(temporaryFiles[index], targetFiles[index]);
      installed.add(index);
    }

    cleanBackups = true;
  } catch (error) {
    const rollbackErrors = [];

    for (let index = outputs.length - 1; index >= 0; index -= 1) {
      try {
        if (installed.has(index)) {
          await operations.rm(targetFiles[index], { force: true });
        }
        if (backedUp.has(index)) {
          await operations.rename(backupFiles[index], targetFiles[index]);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Output replacement and rollback failed: ${error.message}`,
      );
    }

    cleanBackups = true;
    throw error;
  } finally {
    await Promise.all(temporaryFiles.map((filename) =>
      operations.rm(filename, { force: true })));
    if (cleanBackups) {
      await Promise.all(backupFiles.map((filename) =>
        operations.rm(filename, { force: true })));
    }
  }
}

export async function updateAwesomeList(
  token,
  {
    fetchImpl = fetch,
    outputDirectory = process.cwd(),
    log = console.log,
  } = {},
) {
  const repositories = await fetchStarredRepositories(token, fetchImpl);
  const groups = groupRepositories(repositories);
  await writeOutputs(groups, outputDirectory);

  const publishedCount = Object.values(groups)
    .reduce((total, group) => total + group.length, 0);
  const skippedCount = repositories.length - publishedCount;
  const publishedLabel = publishedCount === 1 ? 'repository' : 'repositories';
  const skippedLabel = skippedCount === 1 ? 'repository' : 'repositories';
  log(
    `Updated ${publishedCount} public starred ${publishedLabel}. `
    + `Skipped ${skippedCount} non-public or unknown ${skippedLabel}.`,
  );
}

async function main() {
  const token = process.env.API_TOKEN?.trim();
  if (!token) throw new Error('API_TOKEN is required');

  await updateAwesomeList(token);
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(`Failed to update awesome list: ${error.message}`);
    process.exitCode = 1;
  });
}
