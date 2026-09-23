import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGE_SIZE,
  filterRepositories,
  formatNumber,
  formatRelativeDate,
  getLanguageCounts,
  getSafeUrl,
  normalizeRepositories,
  paginateRepositories,
  sortRepositories,
} from '../lib/catalog.mjs';

function repository(overrides = {}) {
  return {
    id: 1,
    name: 'codex',
    full_name: 'openai/codex',
    description: 'Terminal coding agent',
    language: 'Rust',
    topics: ['ai-agent'],
    stargazers_count: 42_000,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2026-02-02T00:00:00Z',
    homepage: 'https://openai.com/codex',
    html_url: 'https://github.com/openai/codex',
    owner: {
      login: 'openai',
      avatar_url: 'https://avatars.githubusercontent.com/u/14957082',
      html_url: 'https://github.com/openai',
    },
    ...overrides,
  };
}

const groupedFixtures = {
  Rust: [repository()],
  JavaScript: [repository({
    id: 2,
    name: 'next.js',
    full_name: 'vercel/next.js',
    description: 'The React framework for the web',
    language: 'JavaScript',
    topics: ['framework', 'react'],
    stargazers_count: 130_000,
    created_at: '2016-10-05T00:00:00Z',
    updated_at: '2026-03-03T00:00:00Z',
    homepage: 'https://nextjs.org',
    html_url: 'https://github.com/vercel/next.js',
    owner: {
      login: 'vercel',
      avatar_url: 'https://avatars.githubusercontent.com/u/14985020',
      html_url: 'https://github.com/vercel',
    },
  })],
};

test('normalizes grouped input in source order', () => {
  const normalized = normalizeRepositories(groupedFixtures);

  assert.deepEqual(normalized.map(({ fullName }) => fullName), [
    'openai/codex',
    'vercel/next.js',
  ]);
  assert.deepEqual(normalized.map(({ sourceIndex }) => sourceIndex), [0, 1]);
  assert.deepEqual(normalized[0], {
    id: 1,
    name: 'codex',
    fullName: 'openai/codex',
    description: 'Terminal coding agent',
    language: 'Rust',
    topics: ['ai-agent'],
    stars: 42_000,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2026-02-02T00:00:00Z',
    homepage: 'https://openai.com/codex',
    repositoryUrl: 'https://github.com/openai/codex',
    owner: {
      login: 'openai',
      avatarUrl: 'https://avatars.githubusercontent.com/u/14957082',
      profileUrl: 'https://github.com/openai',
    },
    sourceIndex: 0,
  });
});

test('uses starred_order to restore recently starred order across grouped languages', () => {
  const grouped = {
    Rust: [
      repository({ id: 1, language: 'Rust', starred_order: 0 }),
      repository({ id: 3, language: 'Rust', starred_order: 3 }),
    ],
    JavaScript: [repository({ id: 2, language: 'JavaScript', starred_order: 2 })],
  };

  const normalized = normalizeRepositories(grouped);

  assert.deepEqual(normalized.map(({ sourceIndex }) => sourceIndex), [0, 3, 2]);
  assert.deepEqual(
    sortRepositories(normalized, 'recently-starred').map(({ id }) => id),
    [1, 2, 3],
  );
});

test('falls back to flatten order for legacy and invalid starred_order fixtures', () => {
  const normalized = normalizeRepositories([
    repository({ id: 1, starred_order: -1 }),
    repository({ id: 2, starred_order: 1.5 }),
    repository({ id: 3 }),
  ]);

  assert.deepEqual(normalized.map(({ sourceIndex }) => sourceIndex), [0, 1, 2]);
});

test('normalizes array input and safely defaults optional fields', () => {
  const [normalized] = normalizeRepositories([repository({
    id: 3,
    name: 'minimal',
    full_name: null,
    description: null,
    language: null,
    topics: null,
    stargazers_count: Number.NaN,
    created_at: null,
    updated_at: undefined,
    homepage: 'javascript:alert(1)',
    html_url: 'https://example.com/not-github',
    owner: null,
  })]);

  assert.deepEqual(normalized, {
    id: 3,
    name: 'minimal',
    fullName: 'minimal',
    description: '',
    language: 'Other',
    topics: [],
    stars: 0,
    createdAt: null,
    updatedAt: null,
    homepage: null,
    repositoryUrl: null,
    owner: { login: 'unknown', avatarUrl: null, profileUrl: null },
    sourceIndex: 0,
  });
});

test('preserves string full names and non-null timestamp values', () => {
  const [normalized] = normalizeRepositories([repository({
    full_name: '',
    language: '',
    created_at: 0,
    updated_at: false,
    owner: { login: '' },
  })]);

  assert.equal(normalized.fullName, '');
  assert.equal(normalized.language, 'Other');
  assert.equal(normalized.createdAt, 0);
  assert.equal(normalized.updatedAt, false);
  assert.equal(normalized.owner.login, 'unknown');
});

test('rejects invalid containers and non-array groups', () => {
  for (const input of [null, undefined, 'repositories', 1]) {
    assert.throws(() => normalizeRepositories(input), TypeError);
  }
  assert.throws(() => normalizeRepositories({ Rust: {} }), TypeError);
});

test('rejects non-plain object containers', () => {
  for (const input of [new Date(), /repositories/, new Map()]) {
    assert.throws(() => normalizeRepositories(input), TypeError);
  }
});

test('accepts grouped objects with a null prototype', () => {
  const grouped = Object.assign(Object.create(null), {
    Rust: [repository()],
  });

  assert.deepEqual(normalizeRepositories(grouped).map(({ id }) => id), [1]);
});

test('filters entries without a safe integer id or string name', () => {
  const normalized = normalizeRepositories([
    repository({ id: Number.MAX_SAFE_INTEGER + 1 }),
    repository({ id: '1' }),
    repository({ id: 2, name: null }),
    repository({ id: 3, name: 'valid' }),
  ]);

  assert.deepEqual(normalized.map(({ id }) => id), [3]);
});

test('uses token-based AND search across repository fields', () => {
  const repositories = normalizeRepositories(groupedFixtures);

  assert.deepEqual(
    filterRepositories(repositories, { query: 'terminal rust' }).map(({ id }) => id),
    [1],
  );
  assert.deepEqual(
    filterRepositories(repositories, { query: '  REACT   vercel ' }).map(({ id }) => id),
    [2],
  );
});

test('matches uppercase I with lowercase i deterministically', () => {
  const repositories = normalizeRepositories([
    repository({ id: 1, name: 'ITEM', full_name: 'owner/ITEM' }),
    repository({ id: 2, name: 'other', full_name: 'owner/other' }),
  ]);

  assert.deepEqual(
    filterRepositories(repositories, { query: 'item' }).map(({ id }) => id),
    [1],
  );
  assert.deepEqual(
    sortRepositories(repositories.reverse(), 'name').map(({ id }) => id),
    [1, 2],
  );
});

test('searches every supported field', () => {
  const [candidate] = normalizeRepositories([repository({
    id: 10,
    name: 'name-marker',
    full_name: 'full-owner/full-marker',
    description: 'description-marker',
    language: 'language-marker',
    topics: ['topic-marker'],
    owner: { login: 'owner-marker' },
  })]);

  for (const query of [
    'name-marker',
    'full-marker',
    'description-marker',
    'language-marker',
    'topic-marker',
    'owner-marker',
  ]) {
    assert.deepEqual(filterRepositories([candidate], { query }), [candidate]);
  }
  assert.deepEqual(filterRepositories([candidate], { query: 'missing' }), []);
});

test('filters language exactly and combines it with search', () => {
  const repositories = normalizeRepositories(groupedFixtures);

  assert.deepEqual(
    filterRepositories(repositories, { language: 'JavaScript' }).map(({ id }) => id),
    [2],
  );
  assert.deepEqual(
    filterRepositories(repositories, { language: 'javascript' }),
    [],
  );
  assert.deepEqual(
    filterRepositories(repositories, { query: 'react', language: 'Rust' }),
    [],
  );
});

test('sorts all supported modes without mutating input', () => {
  const repositories = normalizeRepositories(groupedFixtures);

  assert.deepEqual(sortRepositories(repositories, 'recently-starred').map(({ id }) => id), [1, 2]);
  assert.deepEqual(sortRepositories(repositories, 'stars').map(({ id }) => id), [2, 1]);
  assert.deepEqual(sortRepositories(repositories, 'updated').map(({ id }) => id), [2, 1]);
  assert.deepEqual(sortRepositories(repositories, 'name').map(({ id }) => id), [1, 2]);
  assert.deepEqual(repositories.map(({ id }) => id), [1, 2]);
});

test('uses sourceIndex as the stable final sorting tie-breaker', () => {
  const repositories = normalizeRepositories([
    repository({ id: 1, name: 'same', stargazers_count: 10, updated_at: '2026-01-01' }),
    repository({ id: 2, name: 'Same', stargazers_count: 10, updated_at: '2026-01-01' }),
  ]).reverse();

  for (const sort of ['recently-starred', 'stars', 'updated', 'name', 'unknown']) {
    assert.deepEqual(sortRepositories(repositories, sort).map(({ id }) => id), [1, 2]);
  }
});

test('paginates visible repositories and reports whether more remain', () => {
  const repositories = normalizeRepositories(groupedFixtures);

  assert.equal(PAGE_SIZE, 24);
  assert.deepEqual(paginateRepositories(repositories, 1), {
    visible: [repositories[0]],
    hasMore: true,
  });
  assert.deepEqual(paginateRepositories(repositories, 99), {
    visible: repositories,
    hasMore: false,
  });
  assert.deepEqual(paginateRepositories(repositories, -1), {
    visible: [],
    hasMore: true,
  });
});

test('paginates at PAGE_SIZE boundaries', () => {
  const twentyFour = normalizeRepositories(Array.from(
    { length: PAGE_SIZE },
    (_, index) => repository({ id: index + 1, name: `repository-${index + 1}` }),
  ));
  const twentyFive = normalizeRepositories([
    ...twentyFour.map(({ id, name }) => repository({ id, name })),
    repository({ id: PAGE_SIZE + 1, name: `repository-${PAGE_SIZE + 1}` }),
  ]);

  assert.deepEqual(paginateRepositories(twentyFour, PAGE_SIZE), {
    visible: twentyFour,
    hasMore: false,
  });

  const defaultPage = paginateRepositories(twentyFive);
  assert.equal(defaultPage.visible.length, PAGE_SIZE);
  assert.deepEqual(defaultPage.visible, twentyFive.slice(0, PAGE_SIZE));
  assert.equal(defaultPage.hasMore, true);

  const explicitPage = paginateRepositories(twentyFive, PAGE_SIZE);
  assert.equal(explicitPage.visible.length, PAGE_SIZE);
  assert.equal(explicitPage.hasMore, true);
  assert.deepEqual(paginateRepositories(twentyFive, 48), {
    visible: twentyFive,
    hasMore: false,
  });
});

test('counts non-empty languages in first-seen order', () => {
  const repositories = normalizeRepositories([
    repository({ id: 1, language: 'Rust' }),
    repository({ id: 2, language: 'JavaScript' }),
    repository({ id: 3, language: 'Rust' }),
    repository({ id: 4, language: null }),
  ]);

  assert.deepEqual(Object.entries(getLanguageCounts(repositories)), [
    ['Rust', 2],
    ['JavaScript', 1],
    ['Other', 1],
  ]);
});

test('counts language names that overlap Object prototype keys', () => {
  const repositories = normalizeRepositories([
    repository({ id: 1, language: '__proto__' }),
    repository({ id: 2, language: 'constructor' }),
    repository({ id: 3, language: 'toString' }),
    repository({ id: 4, language: '__proto__' }),
  ]);

  const counts = getLanguageCounts(repositories);
  assert.equal(counts.__proto__, 2);
  assert.equal(counts.constructor, 1);
  assert.equal(counts.toString, 1);
  assert.deepEqual(Object.entries(counts), [
    ['__proto__', 2],
    ['constructor', 1],
    ['toString', 1],
  ]);
});

test('formats finite numbers compactly and defaults invalid values', () => {
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1_250), '1.3K');
  assert.equal(formatNumber(12_500), '12.5K');
  assert.equal(formatNumber(999_999), '1M');
  assert.equal(formatNumber(1_000_000), '1M');
  assert.equal(formatNumber(-1_250), '-1.3K');
  assert.equal(formatNumber(Number.NaN), '0');
  assert.equal(formatNumber(Infinity), '0');
  assert.equal(formatNumber('1250'), '0');
});

test('formats relative dates deterministically and handles edge cases', () => {
  const now = new Date('2026-07-18T12:00:00Z');

  assert.equal(formatRelativeDate('2026-07-18T11:59:40Z', now), 'just now');
  assert.equal(formatRelativeDate('2026-07-18T11:55:00Z', now), '5 minutes ago');
  assert.equal(formatRelativeDate('2026-07-18T10:00:00Z', now), '2 hours ago');
  assert.equal(formatRelativeDate('2026-07-17T12:00:00Z', now), '1 day ago');
  assert.equal(formatRelativeDate('2026-05-18T12:00:00Z', now), '2 months ago');
  assert.equal(formatRelativeDate('2024-07-18T12:00:00Z', now), '2 years ago');
  assert.equal(formatRelativeDate('2026-07-19T12:00:00Z', now), 'just now');
  assert.equal(formatRelativeDate(0, new Date('1970-01-02T00:00:00Z')), '1 day ago');
  assert.equal(formatRelativeDate('not-a-date', now), 'Unknown');
  assert.equal(formatRelativeDate('', now), 'Unknown');
  assert.equal(formatRelativeDate('2026-07-18T12:00:00Z', 'not-a-date'), 'Unknown');
});

test('accepts safe HTTPS URLs and applies GitHub-only restrictions', () => {
  assert.equal(
    getSafeUrl('https://github.com/openai/codex', { githubOnly: true }),
    'https://github.com/openai/codex',
  );
  assert.equal(getSafeUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(getSafeUrl(' javascript:alert(1) '), null);
  assert.equal(getSafeUrl('http://github.com/openai/codex', { githubOnly: true }), null);
  assert.equal(getSafeUrl('https://example.com', { githubOnly: true }), null);
  assert.equal(getSafeUrl('https://github.com.evil.example/openai/codex', { githubOnly: true }), null);
  assert.equal(getSafeUrl('/relative/path'), null);
  assert.equal(getSafeUrl(null), null);
});
