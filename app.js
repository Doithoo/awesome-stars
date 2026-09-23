import {
  PAGE_SIZE,
  filterRepositories,
  getLanguageCounts,
  normalizeRepositories,
  paginateRepositories,
  sortRepositories,
} from './lib/catalog.mjs';
import {
  createRepositoryCard,
  renderEmpty,
  renderError,
  renderLanguageOptions,
  renderLoading,
  renderQuickFilters,
  renderRepositoryGrid,
  renderSummary,
} from './lib/view.mjs';

const SEARCH_DEBOUNCE_MS = 175;
const LOAD_TIMEOUT_MS = 10_000;
const DOWNLOAD_ERROR = 'The repository list could not be downloaded.';
const INVALID_DATA_ERROR = 'The repository data is not valid.';
const TIMEOUT_ERROR = 'The repository list took too long to load.';
const DEFAULT_VIEW = {
  createRepositoryCard,
  renderEmpty,
  renderError,
  renderLanguageOptions,
  renderLoading,
  renderQuickFilters,
  renderRepositoryGrid,
  renderSummary,
};
const REQUIRED_ELEMENT_IDS = [
  'collectionStats',
  'searchInput',
  'catalog',
  'languageFilter',
  'sortSelect',
  'quickFilters',
  'resultSummary',
  'repositoryGrid',
  'loadMoreButton',
  'statusPanel',
];

export class CatalogApp {
  constructor(documentNode = globalThis.document, dependencies = {}) {
    this.document = documentNode;
    this.view = { ...DEFAULT_VIEW, ...dependencies.view };
    this.fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.setTimeout = dependencies.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.state = {
      repositories: [],
      query: '',
      language: '',
      sort: 'recently-starred',
      visibleCount: PAGE_SIZE,
      status: 'loading',
      error: null,
    };
    this.elements = {};
    this.searchTimer = null;
    this.initialized = false;
    this.activeController = null;
    this.requestGeneration = 0;
  }

  init() {
    if (this.initialized) {
      return;
    }

    this.cacheElements();
    this.bindEvents();
    this.initialized = true;
    this.loadData();
  }

  cacheElements() {
    for (const id of REQUIRED_ELEMENT_IDS) {
      const node = this.document.getElementById(id);
      if (!node) {
        throw new Error(`Required element #${id} was not found.`);
      }
      this.elements[id] = node;
    }

    const loadMoreWrapper = this.elements.loadMoreButton.closest('.load-more');
    if (!loadMoreWrapper || loadMoreWrapper !== this.elements.loadMoreButton.parentElement) {
      throw new Error('Required .load-more wrapper was not found.');
    }
    this.elements.loadMoreWrapper = loadMoreWrapper;
  }

  setLoadMoreVisibility(visible) {
    const hidden = !visible;
    this.elements.loadMoreButton.hidden = hidden;
    this.elements.loadMoreWrapper.hidden = hidden;
  }

  bindEvents() {
    this.elements.searchInput.addEventListener('input', (event) => {
      const query = event.currentTarget.value.trim();
      this.state.query = query;
      this.state.visibleCount = PAGE_SIZE;
      this.clearTimeout(this.searchTimer);
      this.searchTimer = this.setTimeout(() => {
        this.render();
      }, SEARCH_DEBOUNCE_MS);
    });

    this.elements.languageFilter.addEventListener('change', (event) => {
      this.state.language = event.currentTarget.value;
      this.state.visibleCount = PAGE_SIZE;
      this.render();
    });

    this.elements.sortSelect.addEventListener('change', (event) => {
      this.state.sort = event.currentTarget.value;
      this.state.visibleCount = PAGE_SIZE;
      this.render();
    });

    this.elements.quickFilters.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="filter-language"]');
      if (!button || !this.elements.quickFilters.contains(button)) {
        return;
      }

      this.state.language = button.dataset.language ?? '';
      this.state.visibleCount = PAGE_SIZE;
      this.elements.languageFilter.value = this.state.language;
      this.render();
      this.restoreQuickFilterFocus(this.state.language);
    });

    this.elements.loadMoreButton.addEventListener('click', () => {
      this.loadMore();
    });

    this.elements.statusPanel.addEventListener('click', (event) => {
      const action = event.target.closest('button[data-action]')?.dataset.action;
      if (action === 'retry') {
        this.loadData();
      } else if (action === 'clear-filters') {
        this.clearFilters();
      }
    });
  }

  async loadData() {
    const generation = ++this.requestGeneration;
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;

    this.state.status = 'loading';
    this.state.error = null;
    this.elements.catalog.setAttribute('aria-busy', 'true');
    this.elements.repositoryGrid.replaceChildren();
    this.elements.resultSummary.textContent = '';
    this.setLoadMoreVisibility(false);
    this.view.renderLoading(this.elements.statusPanel);

    const timeoutId = this.setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

    try {
      const response = await this.fetch('data.json', {
        signal: controller.signal,
        cache: 'default',
      });
      if (!this.isCurrentRequest(generation, controller)) {
        return;
      }
      if (!response.ok) {
        throw new Error(DOWNLOAD_ERROR);
      }

      let repositories;
      try {
        const data = await response.json();
        repositories = normalizeRepositories(data);
      } catch (error) {
        if (error.name === 'AbortError') {
          throw error;
        }
        throw new Error(INVALID_DATA_ERROR);
      }

      if (!this.isCurrentRequest(generation, controller)) {
        return;
      }
      this.state.repositories = repositories;
      this.state.status = 'ready';
      this.state.error = null;
      this.state.visibleCount = PAGE_SIZE;
      this.renderCollectionControls();
      this.render();
    } catch (error) {
      if (!this.isCurrentRequest(generation, controller)) {
        return;
      }
      if (error.name === 'AbortError') {
        this.showError(TIMEOUT_ERROR);
      } else if (error.message === INVALID_DATA_ERROR) {
        this.showError(INVALID_DATA_ERROR);
      } else {
        this.showError(DOWNLOAD_ERROR);
      }
    } finally {
      this.clearTimeout(timeoutId);
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  isCurrentRequest(generation, controller) {
    return generation === this.requestGeneration && controller === this.activeController;
  }

  showError(message) {
    this.state.status = 'error';
    this.state.error = message;
    this.elements.catalog.removeAttribute('aria-busy');
    this.elements.repositoryGrid.replaceChildren();
    this.elements.resultSummary.textContent = '';
    this.setLoadMoreVisibility(false);
    this.view.renderError(this.elements.statusPanel, message);
  }

  renderCollectionControls() {
    const counts = getLanguageCounts(this.state.repositories);
    this.view.renderLanguageOptions(this.elements.languageFilter, counts, this.state.language);
    this.view.renderQuickFilters(this.elements.quickFilters, counts, this.state.language);

    const languageCount = Object.keys(counts).length;
    const repositoryLabel = this.state.repositories.length === 1 ? 'repository' : 'repositories';
    const languageLabel = languageCount === 1 ? 'language' : 'languages';
    this.elements.collectionStats.textContent = `${this.state.repositories.length} ${repositoryLabel} across ${languageCount} ${languageLabel}`;
  }

  restoreQuickFilterFocus(language) {
    const buttons = this.elements.quickFilters.querySelectorAll(
      'button[data-action="filter-language"]',
    );
    for (const button of buttons) {
      if (button.dataset.language === language) {
        button.focus();
        return;
      }
    }
  }

  getDerivedRepositories() {
    const filtered = filterRepositories(this.state.repositories, {
      query: this.state.query,
      language: this.state.language,
    });
    const sorted = sortRepositories(filtered, this.state.sort);
    const page = paginateRepositories(sorted, this.state.visibleCount);
    return { filtered, sorted, ...page };
  }

  render() {
    if (this.state.status !== 'ready') {
      return;
    }

    this.elements.searchInput.value = this.state.query;
    this.elements.languageFilter.value = this.state.language;
    this.elements.sortSelect.value = this.state.sort;

    const derived = this.getDerivedRepositories();
    this.view.renderQuickFilters(
      this.elements.quickFilters,
      getLanguageCounts(this.state.repositories),
      this.state.language,
    );
    this.view.renderRepositoryGrid(this.elements.repositoryGrid, derived.visible);
    this.finishResultsRender(derived);
  }

  finishResultsRender({ filtered, visible, hasMore }) {
    this.view.renderSummary(this.elements.resultSummary, {
      visibleCount: visible.length,
      filteredCount: filtered.length,
      totalCount: this.state.repositories.length,
    });
    this.setLoadMoreVisibility(hasMore);
    this.elements.catalog.removeAttribute('aria-busy');
    this.elements.statusPanel.removeAttribute('aria-busy');

    if (filtered.length === 0) {
      this.view.renderEmpty(this.elements.statusPanel, {
        collectionEmpty: this.state.repositories.length === 0,
      });
    } else {
      this.elements.statusPanel.replaceChildren();
      this.elements.statusPanel.hidden = true;
    }
  }

  loadMore() {
    if (this.state.status !== 'ready') {
      return;
    }

    const before = this.getDerivedRepositories();
    const previousCount = before.visible.length;
    this.state.visibleCount += PAGE_SIZE;
    const after = this.getDerivedRepositories();
    const fragment = this.document.createDocumentFragment();

    for (const repository of after.sorted.slice(previousCount, after.visible.length)) {
      fragment.append(this.view.createRepositoryCard(repository));
    }
    this.elements.repositoryGrid.append(fragment);
    this.finishResultsRender(after);
  }

  clearFilters() {
    this.clearTimeout(this.searchTimer);
    this.state.query = '';
    this.state.language = '';
    this.state.visibleCount = PAGE_SIZE;
    this.elements.searchInput.value = '';
    this.elements.languageFilter.value = '';
    this.render();
  }
}

function bootstrap() {
  new CatalogApp(document).init();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
}
