import { formatNumber, formatRelativeDate, getSafeUrl } from './catalog.mjs';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function element(tagName, { className, text, attributes = {} } = {}) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  return node;
}

function secureExternalLink(className, candidateUrl, { label, githubOnly }) {
  const url = getSafeUrl(candidateUrl, { githubOnly });
  if (!url) {
    return null;
  }

  const link = element('a', {
    className,
    attributes: { href: url },
  });
  if (label) {
    link.setAttribute('aria-label', label);
  }
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener noreferrer');
  return link;
}

function createExternalLinkIcon() {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '18');
  icon.setAttribute('height', '18');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6');
  icon.append(path);
  return icon;
}

function createAvatar(avatarCandidate, login) {
  const avatarUrl = getSafeUrl(avatarCandidate);
  if (!avatarUrl) {
    return element('span', {
      className: 'repository-owner-fallback',
      text: login.slice(0, 1).toUpperCase() || '?',
      attributes: { 'aria-hidden': 'true' },
    });
  }

  const avatar = element('img', {
    className: 'repository-owner-avatar',
    attributes: { src: avatarUrl, alt: `${login}'s avatar` },
  });
  avatar.setAttribute('loading', 'lazy');
  avatar.setAttribute('decoding', 'async');
  avatar.setAttribute('width', '40');
  avatar.setAttribute('height', '40');
  return avatar;
}

function createOwner(repository) {
  const owner = repository.owner ?? {};
  const login = typeof owner.login === 'string' && owner.login !== '' ? owner.login : 'unknown';
  const ownerElement = secureExternalLink('repository-owner', owner.profileUrl, {
    label: `View ${login} on GitHub`,
    githubOnly: true,
  }) ?? element('div', { className: 'repository-owner' });

  ownerElement.append(createAvatar(owner.avatarUrl, login));
  ownerElement.append(element('span', { className: 'repository-owner-name', text: login }));
  return ownerElement;
}

function createTopics(topics) {
  const container = element('div', { className: 'repository-topics' });
  const values = Array.isArray(topics) ? topics.slice(0, 3) : [];

  for (const topic of values) {
    if (typeof topic !== 'string' || topic === '') {
      continue;
    }
    const link = secureExternalLink(
      'repository-topic',
      `https://github.com/topics/${encodeURIComponent(topic)}`,
      { githubOnly: true },
    );
    if (!link) {
      continue;
    }
    link.textContent = topic;
    container.append(link);
  }

  return container;
}

export function createRepositoryCard(repository, { now = new Date() } = {}) {
  const card = element('article', { className: 'repository-card' });
  const header = element('header', { className: 'repository-card-header' });
  const identity = element('div', { className: 'repository-identity' });
  const fullName = typeof repository.fullName === 'string'
    ? repository.fullName
    : repository.name ?? '';

  identity.append(createOwner(repository));
  const titleHeading = element('h2', { className: 'repository-title' });
  const title = secureExternalLink('repository-name', repository.repositoryUrl, {
    label: `View ${fullName} on GitHub`,
    githubOnly: true,
  }) ?? element('span', { className: 'repository-name' });
  title.textContent = fullName;
  titleHeading.append(title);
  identity.append(titleHeading);
  header.append(identity);

  const homepageLink = secureExternalLink('repository-homepage', repository.homepage, {
    label: `Visit the ${fullName} homepage`,
    githubOnly: false,
  });
  if (homepageLink) {
    homepageLink.append(createExternalLinkIcon());
    header.append(homepageLink);
  }
  card.append(header);

  if (typeof repository.description === 'string' && repository.description !== '') {
    card.append(element('p', {
      className: 'repository-description',
      text: repository.description,
    }));
  }

  const topics = createTopics(repository.topics);
  if (topics.childElementCount > 0) {
    card.append(topics);
  }

  const metadata = element('footer', { className: 'repository-metadata' });
  metadata.append(
    element('span', {
      className: 'repository-language',
      text: typeof repository.language === 'string' ? repository.language : 'Other',
    }),
    element('span', {
      className: 'repository-stars',
      text: `${formatNumber(repository.stars)} stars`,
    }),
    element('span', {
      className: 'repository-updated',
      text: `Updated ${formatRelativeDate(repository.updatedAt, now)}`,
    }),
  );
  card.append(metadata);
  return card;
}

function sortedLanguageCounts(counts) {
  if (counts === null || typeof counts !== 'object') {
    return [];
  }

  return Object.entries(counts)
    .filter(([name, count]) => name !== '' && Number.isFinite(count) && count > 0)
    .sort(([leftName, leftCount], [rightName, rightCount]) => (
      rightCount - leftCount || leftName.localeCompare(rightName)
    ));
}

export function renderLanguageOptions(select, counts, selected = '') {
  const fragment = document.createDocumentFragment();
  const allLanguages = element('option', { text: 'All languages' });
  allLanguages.value = '';
  allLanguages.selected = selected === '';
  fragment.append(allLanguages);

  for (const [language, count] of sortedLanguageCounts(counts)) {
    const option = element('option', { text: `${language} (${count})` });
    option.value = language;
    option.selected = language === selected;
    fragment.append(option);
  }

  select.replaceChildren(fragment);
}

export function renderQuickFilters(container, counts, selected = '', limit = 6) {
  const fragment = document.createDocumentFragment();
  const itemLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 6;
  const languages = sortedLanguageCounts(counts).slice(0, itemLimit);

  for (const [language, count] of languages) {
    const button = element('button', {
      className: 'quick-filter',
      attributes: { type: 'button', 'aria-pressed': String(language === selected) },
    });
    button.setAttribute('data-action', 'filter-language');
    button.setAttribute('data-language', language);
    button.append(
      element('span', { className: 'quick-filter-name', text: language }),
      element('span', { className: 'quick-filter-count', text: String(count) }),
    );
    fragment.append(button);
  }

  container.replaceChildren(fragment);
  container.hidden = languages.length === 0;
}

export function renderRepositoryGrid(grid, repositories) {
  const fragment = document.createDocumentFragment();
  for (const repository of repositories) {
    fragment.append(createRepositoryCard(repository));
  }
  grid.replaceChildren(fragment);
}

export function renderSummary(elementNode, { visibleCount, filteredCount, totalCount }) {
  if (filteredCount === totalCount) {
    elementNode.textContent = `Showing ${visibleCount} of ${totalCount} repositories.`;
    return;
  }
  elementNode.textContent = `Showing ${visibleCount} of ${filteredCount} matches (${totalCount} total).`;
}

function showStatus(panel, content) {
  panel.replaceChildren(content);
  panel.hidden = false;
}

function createRepositorySkeletonCard() {
  const card = element('article', {
    className: 'repository-card repository-card-skeleton',
  });
  const header = element('div', { className: 'repository-skeleton-header' });
  const heading = element('div', { className: 'repository-skeleton-heading' });
  heading.append(
    element('span', { className: 'repository-skeleton-owner' }),
    element('span', { className: 'repository-skeleton-title' }),
  );
  header.append(
    element('span', { className: 'repository-skeleton-avatar' }),
    heading,
  );

  const description = element('div', { className: 'repository-skeleton-description' });
  for (let index = 0; index < 3; index += 1) {
    description.append(element('span', { className: 'repository-skeleton-line' }));
  }

  const metadata = element('footer', { className: 'repository-skeleton-meta' });
  for (let index = 0; index < 3; index += 1) {
    metadata.append(element('span', { className: 'repository-skeleton-meta-item' }));
  }

  card.append(header, description, metadata);
  return card;
}

export function renderLoading(panel) {
  const status = element('div', { className: 'status-loading' });
  const skeletonGrid = element('div', {
    className: 'loading-skeleton-grid',
    attributes: { 'aria-hidden': 'true' },
  });
  for (let index = 0; index < 6; index += 1) {
    skeletonGrid.append(createRepositorySkeletonCard());
  }
  status.append(
    element('p', { className: 'status-loading-text', text: 'Loading repositories...' }),
    skeletonGrid,
  );
  panel.setAttribute('aria-busy', 'true');
  showStatus(panel, status);
}

export function renderError(panel, message) {
  const status = element('div', { className: 'status-error' });
  status.append(element('p', {
    text: typeof message === 'string' && message !== ''
      ? message
      : 'Unable to load repositories.',
  }));
  const retry = element('button', { text: 'Retry', attributes: { type: 'button' } });
  retry.setAttribute('data-action', 'retry');
  status.append(retry);
  panel.removeAttribute('aria-busy');
  showStatus(panel, status);
}

export function renderEmpty(panel, { collectionEmpty = false } = {}) {
  const status = element('div', { className: 'status-empty' });
  status.append(element('p', {
    text: collectionEmpty
      ? 'No public repositories are available.'
      : 'No repositories match your filters.',
  }));
  if (!collectionEmpty) {
    const clear = element('button', { text: 'Clear filters', attributes: { type: 'button' } });
    clear.setAttribute('data-action', 'clear-filters');
    status.append(clear);
  }
  panel.removeAttribute('aria-busy');
  showStatus(panel, status);
}
