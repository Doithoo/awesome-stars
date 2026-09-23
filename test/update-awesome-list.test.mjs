import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fileSystem from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeRepositories,
  sortRepositories,
} from '../lib/catalog.mjs';

import {
  fetchStarredRepositories,
  groupRepositories,
  projectRepository,
  renderJson,
  renderMarkdown,
  updateAwesomeList,
  writeOutputs,
} from '../scripts/update-awesome-list.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function response(body, nextLink = null, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(nextLink ? { link: nextLink } : {}),
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function repository(overrides = {}) {
  return {
    id: 1,
    node_id: 'R_1',
    name: 'example',
    full_name: 'owner/example',
    owner: {
      login: 'owner',
      id: 9,
      avatar_url: 'https://avatars.example/owner',
      url: 'https://api.github.com/users/owner',
      html_url: 'https://github.com/owner',
      ignored: 'value',
    },
    html_url: 'https://github.com/owner/example',
    description: 'Example repository',
    url: 'https://api.github.com/repos/owner/example',
    languages_url: 'https://api.github.com/repos/owner/example/languages',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    git_url: 'git://github.com/owner/example.git',
    ssh_url: 'git@github.com:owner/example.git',
    clone_url: 'https://github.com/owner/example.git',
    homepage: null,
    stargazers_count: 10,
    watchers_count: 10,
    language: 'JavaScript',
    topics: ['example'],
    private: false,
    visibility: 'public',
    forks_count: 20,
    ...overrides,
  };
}

test('fetches every starred repository page in response order', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const page = new URL(url).searchParams.get('page');
    return page === '2'
      ? response([repository({ id: 2 })])
      : response(
        [repository({ id: 1 })],
        '<https://api.github.com/user/starred?per_page=100&page=2>; rel="next"',
      );
  };

  const repositories = await fetchStarredRepositories('test-token', fetchImpl);

  assert.deepEqual(repositories.map(({ id }) => id), [1, 2]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(requests[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('reports GitHub API failures with status and response details', async () => {
  const fetchImpl = async () => response('rate limit exceeded', null, 403);

  await assert.rejects(
    fetchStarredRepositories('test-token', fetchImpl),
    /GitHub API request failed \(403\): rate limit exceeded/,
  );
});

test('rejects unexpected GitHub API response bodies', async () => {
  const fetchImpl = async () => response({ message: 'not an array' });

  await assert.rejects(
    fetchStarredRepositories('test-token', fetchImpl),
    /expected an array/,
  );
});

test('rejects malformed next-page links instead of truncating results', async () => {
  const fetchImpl = async () => response(
    [repository()],
    'not-a-valid-link; rel="next"',
  );

  await assert.rejects(
    fetchStarredRepositories('test-token', fetchImpl),
    /GitHub API pagination link is invalid/,
  );
});

test('projects repositories to the reduced browser data contract', () => {
  const projected = projectRepository(repository({
    description: null,
    homepage: null,
    language: null,
    topics: [],
  }), 17);

  assert.deepEqual(Object.keys(projected), [
    'id', 'name', 'full_name', 'owner', 'html_url', 'description', 'homepage',
    'stargazers_count', 'language', 'topics', 'created_at', 'updated_at',
    'starred_order',
  ]);
  assert.deepEqual(Object.keys(projected.owner), [
    'login', 'avatar_url', 'html_url',
  ]);
  for (const field of [
    'node_id', 'url', 'languages_url', 'git_url', 'ssh_url', 'clone_url',
    'watchers_count', 'private', 'visibility', 'forks_count',
  ]) {
    assert.equal(field in projected, false, `${field} should be omitted`);
  }
  for (const field of ['id', 'url', 'ignored']) {
    assert.equal(field in projected.owner, false, `owner.${field} should be omitted`);
  }
  assert.equal(projected.description, null);
  assert.equal(projected.homepage, null);
  assert.equal(projected.language, null);
  assert.deepEqual(projected.topics, []);
  assert.equal(projected.starred_order, 17);
});

test('requires a safe source ordinal for direct repository projection', () => {
  for (const ordinal of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => projectRepository(repository(), ordinal),
      /Repository starred order must be a safe non-negative integer/,
    );
  }
});

test('projects only repositories explicitly marked public and rejects all other metadata generically', () => {
  const missingVisibility = repository({ id: 4, name: 'missing-visibility' });
  delete missingVisibility.visibility;
  const missingPrivate = repository({ id: 5, name: 'missing-private' });
  delete missingPrivate.private;
  const ineligible = [
    repository({ id: 2, private: true, name: 'secret-private' }),
    repository({ id: 3, visibility: 'internal', name: 'secret-internal' }),
    repository({ id: 6, visibility: 'private', name: 'secret-visibility' }),
    missingVisibility,
    missingPrivate,
    repository({ id: 7, private: 'false', name: 'malformed-private' }),
    repository({ id: 8, visibility: 'PUBLIC', name: 'malformed-visibility' }),
    repository({ id: 9, visibility: true, name: 'non-string-visibility' }),
  ];

  assert.equal(projectRepository(repository(), 0).id, 1);
  for (const candidate of ineligible) {
    assert.throws(
      () => projectRepository(candidate, 0),
      (error) => {
        assert.equal(error.message, 'Repository cannot be published');
        assert.doesNotMatch(error.message, /secret|missing|malformed|internal|private|PUBLIC|true/);
        return true;
      },
    );
  }
});

test('groups repositories by first-seen language and uses miscellaneous', () => {
  const grouped = groupRepositories([
    repository({ id: 1, language: 'JavaScript' }),
    repository({ id: 2, language: null }),
    repository({ id: 3, language: 'JavaScript' }),
  ]);

  assert.deepEqual(Object.keys(grouped), ['JavaScript', 'miscellaneous']);
  assert.deepEqual(grouped.JavaScript.map(({ id }) => id), [1, 3]);
  assert.deepEqual(grouped.miscellaneous.map(({ id }) => id), [2]);
  assert.deepEqual(grouped.JavaScript.map(({ starred_order }) => starred_order), [0, 2]);
  assert.deepEqual(grouped.miscellaneous.map(({ starred_order }) => starred_order), [1]);
});

test('preserves raw API order across language groups and skipped non-public gaps', () => {
  const grouped = groupRepositories([
    repository({ id: 1, language: 'Rust' }),
    repository({ id: 2, private: true, language: 'JavaScript' }),
    repository({ id: 3, language: 'JavaScript' }),
    repository({ id: 4, language: 'Rust' }),
  ]);

  assert.deepEqual(grouped.Rust.map(({ starred_order }) => starred_order), [0, 3]);
  assert.deepEqual(grouped.JavaScript.map(({ starred_order }) => starred_order), [2]);
  const sorted = sortRepositories(normalizeRepositories(grouped), 'recently-starred');
  assert.deepEqual(sorted.map(({ id }) => id), [1, 3, 4]);
});

test('excludes every non-public or unknown repository before projection and rendering', () => {
  const missingVisibility = repository({ id: 5, name: 'missing-visibility' });
  delete missingVisibility.visibility;
  const missingPrivate = repository({ id: 6, name: 'missing-private' });
  delete missingPrivate.private;
  const grouped = groupRepositories([
    repository({ id: 1, name: 'first-public', full_name: 'owner/first-public' }),
    repository({
      id: 2,
      private: true,
      name: 'confidential-project',
      full_name: 'private-owner/confidential-project',
      owner: null,
      language: 'Rust',
    }),
    repository({ id: 3, visibility: 'internal', name: 'secret-internal', language: 'Go' }),
    repository({ id: 4, visibility: 'private', name: 'secret-visibility', language: 'Ruby' }),
    missingVisibility,
    missingPrivate,
    repository({ id: 7, private: 'false', name: 'malformed-private' }),
    repository({ id: 8, visibility: 1, name: 'malformed-visibility' }),
    repository({ id: 9, name: 'second-public', full_name: 'owner/second-public' }),
  ]);
  const json = renderJson(grouped);
  const markdown = renderMarkdown(grouped);

  assert.deepEqual(grouped.JavaScript.map(({ id }) => id), [1, 9]);
  assert.equal('Rust' in grouped, false);
  assert.equal('Go' in grouped, false);
  assert.equal('Ruby' in grouped, false);
  for (const output of [json, markdown]) {
    assert.doesNotMatch(output, /confidential|secret|missing-|malformed-|private-owner/);
    for (const id of [2, 3, 4, 5, 6, 7, 8]) {
      assert.doesNotMatch(output, new RegExp(`"id": ${id}(?:,|\\n)`));
    }
  }
});

test('update publishes and logs aggregate counts without repository details', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'awesome-list-update-'));
  const messages = [];
  const unknownRepository = repository({ id: 4, name: 'unknown-project' });
  delete unknownRepository.visibility;
  const fetchImpl = async () => response([
    repository({ id: 1, full_name: 'owner/public-project' }),
    repository({
      id: 2,
      private: true,
      name: 'confidential-project',
      full_name: 'private-owner/confidential-project',
    }),
    repository({ id: 3, visibility: 'internal', name: 'internal-project' }),
    unknownRepository,
  ]);

  try {
    await updateAwesomeList('test-token', {
      fetchImpl,
      outputDirectory: directory,
      log: (message) => messages.push(message),
    });

    const json = await readFile(path.join(directory, 'data.json'), 'utf8');
    const markdown = await readFile(path.join(directory, 'data.md'), 'utf8');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Updated 1 public starred repository/);
    assert.match(messages[0], /Skipped 3 non-public or unknown repositories/);
    assert.doesNotMatch(messages[0], /confidential|private-owner|internal-project|unknown-project/);
    assert.doesNotMatch(`${json}\n${markdown}`, /confidential|private-owner|internal-project|unknown-project/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('renders deterministic two-space JSON with a trailing newline', () => {
  const grouped = {
    JavaScript: [projectRepository(repository(), 0)],
  };

  const json = renderJson(grouped);

  assert.equal(json, `${JSON.stringify(grouped, null, 2)}\n`);
});

test('checked-in generated data matches the exact public projection contract', async () => {
  const json = await readFile(path.join(projectRoot, 'data.json'), 'utf8');
  const markdown = await readFile(path.join(projectRoot, 'data.md'), 'utf8');
  const groups = JSON.parse(json);
  const repositories = Object.values(groups).flat();
  const expectedKeys = [
    'id', 'name', 'full_name', 'owner', 'html_url', 'description', 'homepage',
    'stargazers_count', 'language', 'topics', 'created_at', 'updated_at',
    'starred_order',
  ];

  assert.equal(json, renderJson(groups));
  assert.equal(markdown, renderMarkdown(groups));
  assert.match(markdown.split('\n')[0], /github\.com\/Doithoo/);
  assert.equal(repositories.length > 0, true);
  for (const repositoryData of repositories) {
    assert.deepEqual(Object.keys(repositoryData), expectedKeys);
    assert.equal(Number.isSafeInteger(repositoryData.starred_order), true);
    assert.equal(repositoryData.starred_order >= 0, true);
    for (const privateField of ['private', 'visibility', 'permissions', 'security_and_analysis']) {
      assert.equal(privateField in repositoryData, false);
    }
  }
  const ordinals = repositories.map(({ starred_order }) => starred_order);
  assert.equal(new Set(ordinals).size, ordinals.length);
  assert.deepEqual(
    sortRepositories(normalizeRepositories(groups), 'recently-starred')
      .map(({ sourceIndex }) => sourceIndex),
    [...ordinals].sort((left, right) => left - right),
  );
});

test('renders compatible Markdown headings and duplicate GitHub slugs', () => {
  const grouped = groupRepositories([
    repository({ id: 1, language: 'JavaScript' }),
    repository({ id: 2, language: 'C++', full_name: 'owner/cpp' }),
    repository({ id: 3, language: 'C', full_name: 'owner/c' }),
    repository({ id: 4, language: 'C#', full_name: 'owner/csharp' }),
    repository({
      id: 5,
      language: null,
      full_name: 'owner/no_language',
      description: '[Docs] Q&A :black_flag:',
    }),
    repository({ id: 6, language: null, full_name: 'owner/no-description', description: null }),
  ]);

  const markdown = renderMarkdown(grouped);
  const [header] = markdown.split('\n');

  assert.equal(
    header,
    '# [![Awesome](https://cdn.rawgit.com/sindresorhus/awesome/d7305f38d29fed78fa85652e3a63e154dd8e8829/media/badge.svg)](https://github.com/Doithoo) [![Awesome](https://badgen.net/static/GitHub/Repos/blue)](https://github.com/Doithoo)',
  );
  assert.equal((header.match(/https:\/\/github\.com\/Doithoo/g) ?? []).length, 2);
  assert.doesNotMatch(header, /tonngw/);
  assert.match(markdown, /\* \[JavaScript\]\(#javascript\)/);
  assert.match(markdown, /\* \[C\+\+\]\(#c\)/);
  assert.match(markdown, /\* \[C\]\(#c-1\)/);
  assert.match(markdown, /\* \[C#\]\(#c-2\)/);
  assert.match(markdown, /\* \[miscellaneous\]\(#miscellaneous\)/);
  assert.match(markdown, /## C\+\+/);
  assert.match(markdown, /## C\\#/);
  assert.equal(
    markdown.includes(
      '* [owner/no\\_language](https://github.com/owner/example) - \\[Docs] Q\\&A :black\\_flag:',
    ),
    true,
  );
  assert.match(markdown, /\* \[owner\/no-description\].* -\n/);
  assert.doesNotMatch(markdown, /null/);
  assert.equal(markdown.endsWith('\n'), true);
});

test('writes complete outputs and removes temporary files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'awesome-list-'));
  const grouped = {
    JavaScript: [projectRepository(repository(), 0)],
  };

  try {
    await writeOutputs(grouped, directory);

    assert.equal(
      await readFile(path.join(directory, 'data.json'), 'utf8'),
      renderJson(grouped),
    );
    assert.equal(
      await readFile(path.join(directory, 'data.md'), 'utf8'),
      renderMarkdown(grouped),
    );
    assert.deepEqual((await readdir(directory)).sort(), ['data.json', 'data.md']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('restores both previous outputs when replacement fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'awesome-list-'));
  const jsonPath = path.join(directory, 'data.json');
  const markdownPath = path.join(directory, 'data.md');
  let rejectedMarkdownReplacement = false;
  const operations = {
    ...fileSystem,
    async rename(source, destination) {
      if (
        !rejectedMarkdownReplacement
        && source.includes('.data.md.')
        && source.endsWith('.tmp')
      ) {
        rejectedMarkdownReplacement = true;
        throw new Error('simulated replacement failure');
      }
      return fileSystem.rename(source, destination);
    },
  };

  try {
    await writeFile(jsonPath, 'old json\n');
    await writeFile(markdownPath, 'old markdown\n');

    await assert.rejects(
      writeOutputs(
        { JavaScript: [projectRepository(repository(), 0)] },
        directory,
        operations,
      ),
      /simulated replacement failure/,
    );

    assert.equal(await readFile(jsonPath, 'utf8'), 'old json\n');
    assert.equal(await readFile(markdownPath, 'utf8'), 'old markdown\n');
    assert.deepEqual((await readdir(directory)).sort(), ['data.json', 'data.md']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI rejects a missing API_TOKEN before making requests', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/update-awesome-list.mjs'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, API_TOKEN: '' },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /API_TOKEN is required/);
});
