export const PAGE_SIZE = 24;

const SORT_MODES = new Set(['recently-starred', 'stars', 'updated', 'name']);
const NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function getSafeUrl(value, { githubOnly = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') {
      return null;
    }
    if (githubOnly && url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeRepository(repository, fallbackSourceIndex) {
  if (
    repository === null
    || typeof repository !== 'object'
    || !Number.isSafeInteger(repository.id)
    || typeof repository.name !== 'string'
  ) {
    return null;
  }

  const owner = repository.owner !== null && typeof repository.owner === 'object'
    ? repository.owner
    : {};
  const sourceIndex = Number.isSafeInteger(repository.starred_order)
    && repository.starred_order >= 0
    ? repository.starred_order
    : fallbackSourceIndex;

  return {
    id: repository.id,
    name: repository.name,
    fullName: typeof repository.full_name === 'string'
      ? repository.full_name
      : repository.name,
    description: stringOrEmpty(repository.description),
    language: typeof repository.language === 'string' && repository.language.trim() !== ''
      ? repository.language
      : 'Other',
    topics: Array.isArray(repository.topics)
      ? repository.topics.filter((topic) => typeof topic === 'string')
      : [],
    stars: typeof repository.stargazers_count === 'number'
      && Number.isFinite(repository.stargazers_count)
      ? repository.stargazers_count
      : 0,
    createdAt: repository.created_at ?? null,
    updatedAt: repository.updated_at ?? null,
    homepage: getSafeUrl(repository.homepage),
    repositoryUrl: getSafeUrl(repository.html_url, { githubOnly: true }),
    owner: {
      login: typeof owner.login === 'string' && owner.login.trim() !== ''
        ? owner.login
        : 'unknown',
      avatarUrl: getSafeUrl(owner.avatar_url),
      profileUrl: getSafeUrl(owner.html_url, { githubOnly: true }),
    },
    sourceIndex,
  };
}

export function normalizeRepositories(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Repository data must be an array or grouped object');
  }

  let repositories;
  if (Array.isArray(input)) {
    repositories = input;
  } else {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Grouped repository data must be a plain object');
    }
    const groups = Object.values(input);
    if (groups.some((group) => !Array.isArray(group))) {
      throw new TypeError('Every repository group must be an array');
    }
    repositories = groups.flat();
  }

  return repositories
    .map((repository, sourceIndex) => normalizeRepository(repository, sourceIndex))
    .filter((repository) => repository !== null);
}

export function filterRepositories(
  repositories,
  { query = '', language = '' } = {},
) {
  const tokens = typeof query === 'string'
    ? query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    : [];

  return repositories.filter((repository) => {
    if (language && repository.language !== language) {
      return false;
    }

    const searchable = [
      repository.name,
      repository.fullName,
      repository.description,
      repository.language,
      repository.owner?.login,
      ...(Array.isArray(repository.topics) ? repository.topics : []),
    ].filter((value) => typeof value === 'string').join(' ').toLowerCase();

    return tokens.every((token) => searchable.includes(token));
  });
}

function sourceOrder(left, right) {
  const leftIndex = Number.isFinite(left.sourceIndex) ? left.sourceIndex : 0;
  const rightIndex = Number.isFinite(right.sourceIndex) ? right.sourceIndex : 0;
  return leftIndex - rightIndex;
}

function dateValue(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareNames(left, right) {
  const leftName = stringOrEmpty(left.name).toLowerCase();
  const rightName = stringOrEmpty(right.name).toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  return 0;
}

export function sortRepositories(repositories, sort = 'recently-starred') {
  const mode = SORT_MODES.has(sort) ? sort : 'recently-starred';

  return [...repositories].sort((left, right) => {
    let comparison = 0;
    if (mode === 'stars') {
      comparison = (Number.isFinite(right.stars) ? right.stars : 0)
        - (Number.isFinite(left.stars) ? left.stars : 0);
    } else if (mode === 'updated') {
      comparison = dateValue(right.updatedAt) - dateValue(left.updatedAt);
    } else if (mode === 'name') {
      comparison = compareNames(left, right);
    }

    return comparison || sourceOrder(left, right);
  });
}

export function paginateRepositories(repositories, visibleCount = PAGE_SIZE) {
  const count = Number.isFinite(visibleCount)
    ? Math.max(0, Math.floor(visibleCount))
    : 0;
  const visible = repositories.slice(0, count);
  return {
    visible,
    hasMore: visible.length < repositories.length,
  };
}

export function getLanguageCounts(repositories) {
  const counts = Object.create(null);
  for (const repository of repositories) {
    if (typeof repository.language === 'string' && repository.language !== '') {
      counts[repository.language] = (counts[repository.language] ?? 0) + 1;
    }
  }
  return counts;
}

export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0';
  }
  return NUMBER_FORMATTER.format(value);
}

export function formatRelativeDate(value, now = new Date()) {
  const date = new Date(value);
  const reference = new Date(now);
  if (
    value === null
    || value === undefined
    || value === ''
    || !Number.isFinite(date.getTime())
    || !Number.isFinite(reference.getTime())
  ) {
    return 'Unknown';
  }

  const elapsedSeconds = Math.max(0, Math.floor((reference - date) / 1_000));
  const intervals = [
    [365 * 24 * 60 * 60, 'year'],
    [30 * 24 * 60 * 60, 'month'],
    [24 * 60 * 60, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];

  for (const [seconds, label] of intervals) {
    const count = Math.floor(elapsedSeconds / seconds);
    if (count >= 1) {
      return `${count} ${label}${count === 1 ? '' : 's'} ago`;
    }
  }

  return 'just now';
}
