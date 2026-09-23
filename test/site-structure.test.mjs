import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const indexPath = new URL('index.html', root);
const ignorePath = new URL('.gitignore', root);
const readmePath = new URL('README.md', root);
const chineseReadmePath = new URL('README.zh-CN.md', root);
const viewPath = new URL('lib/view.mjs', root);
const appPath = new URL('app.js', root);
const stylesPath = new URL('styles.css', root);
const packagePath = new URL('package.json', root);
const packageLockPath = new URL('package-lock.json', root);
const changelogPath = new URL('CHANGELOG.md', root);
const licensePath = new URL('LICENSE', root);

const readIndex = () => readFile(indexPath, 'utf8');
const readStyles = () => readFile(stylesPath, 'utf8');

let controllerModulePromise;

function importControllerModule() {
  controllerModulePromise ??= readFile(appPath, 'utf8').then((source) => {
    const resolvedSource = source
      .replace("'./lib/catalog.mjs'", `'${new URL('lib/catalog.mjs', root).href}'`)
      .replace("'./lib/view.mjs'", `'${new URL('lib/view.mjs', root).href}'`);
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(resolvedSource).toString('base64')}`;
    return import(moduleUrl);
  });
  return controllerModulePromise;
}

class FakeElement {
  constructor(tagName = 'div') {
    this.attributes = new Map();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.hidden = false;
    this.listeners = new Map();
    this.parentElement = null;
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this.value = '';
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name, { currentTarget = this, target = this } = {}) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ currentTarget, target });
    }
  }

  listenerCount(name) {
    return (this.listeners.get(name) ?? []).length;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  replaceChildren(...children) {
    this.children = [...children];
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        child.parentElement = this;
      }
    }
  }

  append(...children) {
    for (const child of children) {
      const appended = child?.fragmentChildren ?? [child];
      for (const appendedChild of appended) {
        if (appendedChild instanceof FakeElement) {
          appendedChild.parentElement = this;
        }
        this.children.push(appendedChild);
      }
    }
  }

  closest(selector) {
    if (selector.startsWith('.') && this.className.split(/\s+/).includes(selector.slice(1))) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }

  contains(candidate) {
    return candidate === this || candidate?.container === this;
  }

  querySelectorAll() {
    return this.queryResults ?? [];
  }

  get childElementCount() {
    return this.children.length;
  }
}

function createControllerDocument() {
  const ids = [
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
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const loadMoreWrapper = new FakeElement();
  loadMoreWrapper.className = 'load-more';
  loadMoreWrapper.append(elements.loadMoreButton);
  elements.loadMoreWrapper = loadMoreWrapper;
  return {
    elements,
    document: {
      getElementById: (id) => elements[id] ?? null,
      createDocumentFragment() {
        return {
          fragmentChildren: [],
          append(child) {
            this.fragmentChildren.push(child);
          },
        };
      },
    },
  };
}

function createViewSpies() {
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    view: {
      createRepositoryCard: (repository) => ({ repository }),
      renderEmpty: record('renderEmpty'),
      renderError: record('renderError'),
      renderLanguageOptions: record('renderLanguageOptions'),
      renderLoading: record('renderLoading'),
      renderQuickFilters: record('renderQuickFilters'),
      renderRepositoryGrid: record('renderRepositoryGrid'),
      renderSummary: record('renderSummary'),
    },
  };
}

function repository(id, overrides = {}) {
  return {
    id,
    name: `repository-${id}`,
    fullName: `owner/repository-${id}`,
    description: '',
    language: 'JavaScript',
    topics: [],
    stars: id,
    createdAt: null,
    updatedAt: null,
    homepage: null,
    repositoryUrl: null,
    owner: { login: 'owner', avatarUrl: null, profileUrl: null },
    sourceIndex: id - 1,
    ...overrides,
  };
}

function attributes(tag) {
  const values = {};
  const pattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/gs;
  let match;

  while ((match = pattern.exec(tag)) !== null) {
    values[match[1].toLowerCase()] = match[3];
  }

  return values;
}

function openingTags(html, name) {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];
}

function openingTagById(html, id) {
  const tag = openingTags(html, '[a-z][\\w-]*')
    .find((candidate) => attributes(candidate).id === id);

  assert.ok(tag, `missing #${id}`);
  return tag;
}

function elementById(html, id) {
  const openingTag = openingTagById(html, id);
  const name = openingTag.match(/^<([\w-]+)/i)[1];
  const start = html.indexOf(openingTag);
  const remainder = html.slice(start + openingTag.length);
  const closingTag = new RegExp(`</${name}\\s*>`, 'i');
  const end = remainder.search(closingTag);

  assert.notEqual(end, -1, `missing closing tag for #${id}`);
  return { openingTag, body: remainder.slice(0, end), name: name.toLowerCase() };
}

function firstElement(html, name) {
  const match = html.match(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'));

  assert.ok(match, `missing <${name}> element`);
  return { openingTag: `<${name}${match[1]}>`, body: match[2] };
}

function textContent(markup) {
  return markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function labelFor(html, id) {
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)];
  const label = labels.find((match) => attributes(`<label${match[1]}>`).for === id);

  assert.ok(label, `missing persistent label for #${id}`);
  assert.notEqual(textContent(label[2]), '', `empty label for #${id}`);
  return textContent(label[2]);
}

function linkByHref(html, href) {
  const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(
    new RegExp(`<a\\b(?=[^>]*\\bhref=["']${escapedHref}["'])[^>]*>([\\s\\S]*?)<\\/a>`, 'i'),
  );

  assert.ok(match, `missing link to ${href}`);
  return { openingTag: match[0].slice(0, match[0].indexOf('>') + 1), body: match[1] };
}

function cssAtRuleBody(css, pattern, label) {
  const match = pattern.exec(css);
  assert.ok(match, `missing ${label}`);
  const openingBrace = css.indexOf('{', match.index);
  let depth = 0;

  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === '{') {
      depth += 1;
    } else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(openingBrace + 1, index);
      }
    }
  }

  assert.fail(`unclosed ${label}`);
}

function cssRuleBody(css, selector, label = selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|})\\s*${escapedSelector}\\s*\\{`).exec(css);
  assert.ok(match, `missing bounded rule for ${label}`);
  const openingBrace = css.indexOf('{', match.index);
  const closingBrace = css.indexOf('}', openingBrace + 1);
  assert.notEqual(closingBrace, -1, `unclosed rule for ${label}`);
  return css.slice(openingBrace + 1, closingBrace);
}

test('stylesheet defines the exact Graphic Signal design tokens', async () => {
  const css = await readStyles();
  const tokens = {
    '--color-canvas': '#f8f9fb',
    '--color-surface': '#ffffff',
    '--color-ink': '#17191d',
    '--color-muted': '#626875',
    '--color-line': '#cbd0da',
    '--color-primary': '#214bc8',
    '--color-signal': '#c3322b',
    '--color-focus': '#214bc8',
    '--shadow-card': '2px 2px 0 #dfe3ec',
    '--radius-card': '6px',
    '--content-width': '1180px',
  };

  for (const [name, value] of Object.entries(tokens)) {
    assert.match(
      css,
      new RegExp(`${name}\\s*:\\s*${value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*;`, 'i'),
      `missing exact token ${name}: ${value}`,
    );
  }
});

test('stylesheet excludes legacy effects and disallowed visual treatments', async () => {
  const css = await readStyles();
  const legacyPatterns = [
    [/\.header-parallax\b/i, 'parallax selector'],
    [/\.toast(?:\b|[-_])/i, 'toast selector'],
    [/\.gpu(?:\b|[-_])/i, 'GPU selector'],
    [/\.scroll-to-top\b/i, 'scroll-to-top selector'],
    [/\.virtual-scroll(?:\b|[-_])/i, 'virtual scroll selector'],
    [/\btouch-action\s*:/i, 'touch-action property'],
    [/\.categorization(?:\b|[-_])/i, 'categorization selector'],
    [/\.skeleton-grid\s*\{/i, 'legacy generic skeleton grid'],
    [/\.repo-card\.skeleton\b/i, 'legacy duplicated skeleton card'],
  ];

  assert.doesNotMatch(
    css,
    /(?:background|background-image)\s*:[^;]*(?:linear|radial|conic)-gradient\s*\(/i,
    'gradient backgrounds are not allowed',
  );
  assert.doesNotMatch(css, /\.(?:blob|orb|bokeh)(?:\b|[-_])/i, 'decorative selectors are not allowed');
  assert.doesNotMatch(css, /font-size\s*:[^;]*(?:vw|vh|vmin|vmax)/i, 'viewport-scaled type is not allowed');
  assert.doesNotMatch(css, /letter-spacing\s*:\s*-/i, 'negative letter spacing is not allowed');
  assert.match(css, /letter-spacing\s*:\s*0\s*;/i, 'letter spacing must be explicitly neutral');

  for (const match of css.matchAll(/border-radius\s*:\s*([0-9.]+)px/gi)) {
    assert.ok(Number(match[1]) <= 8, `card/control radius exceeds 8px: ${match[0]}`);
  }
  for (const [pattern, label] of legacyPatterns) {
    assert.doesNotMatch(css, pattern, `legacy feature remains: ${label}`);
  }

  const lineCount = css.split(/\r?\n/).length;
  assert.ok(lineCount <= 1200, `stylesheet must be at most 1200 lines, received ${lineCount}`);
});

test('stylesheet covers the production catalog class and state surface', async () => {
  const css = await readStyles();
  const selectors = [
    '.site-header',
    '.site-nav',
    '.brand-link',
    '.source-link',
    '.catalog',
    '.search-panel',
    '.eyebrow',
    '.search-field',
    '.search-input-wrap',
    '.search-input',
    '.catalog-content',
    '.toolbar',
    '.filter-field',
    '.filter-select',
    '.quick-filters',
    '.quick-filter',
    '.quick-filter-name',
    '.quick-filter-count',
    '.result-summary',
    '.repository-grid',
    '.repository-card-header',
    '.repository-identity',
    '.repository-title',
    '.repository-name',
    '.repository-owner-avatar',
    '.repository-owner-fallback',
    '.repository-owner-name',
    '.repository-description',
    '.repository-topics',
    '.repository-topic',
    '.repository-metadata',
    '.repository-language',
    '.repository-stars',
    '.repository-updated',
    '.repository-homepage',
    '.load-more',
    '.status-panel',
    '.site-footer',
    '.footer-links',
    '.sr-only',
  ];

  for (const selector of selectors) {
    assert.ok(css.includes(selector), `missing production selector ${selector}`);
  }
  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
});

test('key production CSS rules carry meaningful Graphic Signal declarations', async () => {
  const css = await readStyles();
  const owner = cssRuleBody(css, '.repository-owner');
  const card = cssRuleBody(css, '.repository-card');
  const focus = cssRuleBody(css, ':focus-visible');
  const hidden = cssRuleBody(css, '[hidden]');
  const skeletonGrid = cssRuleBody(css, '.loading-skeleton-grid');
  const loading = cssRuleBody(css, '.status-loading');
  const error = cssRuleBody(css, '.status-error');
  const empty = cssRuleBody(css, '.status-empty');
  const errorText = cssRuleBody(css, '.status-error p');
  const emptyText = cssRuleBody(css, '.status-empty p');
  const mobile = cssAtRuleBody(
    css,
    /@media\s*\(max-width:\s*760px\)/i,
    'mobile catalog media query',
  );
  const mobileSkeletonGrid = cssRuleBody(mobile, '.loading-skeleton-grid');
  const reducedMotion = cssAtRuleBody(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)/i,
    'reduced motion media query',
  );

  assert.match(owner, /display\s*:\s*inline-flex\s*;/);
  assert.match(owner, /max-width\s*:\s*100%\s*;/);
  assert.match(card, /min-height\s*:\s*272px\s*;/);
  assert.match(card, /border\s*:\s*1px solid var\(--color-line\)\s*;/);
  assert.match(card, /box-shadow\s*:\s*var\(--shadow-card\)\s*;/);
  assert.match(focus, /outline\s*:\s*3px solid var\(--color-focus\)\s*;/);
  assert.match(focus, /outline-offset\s*:\s*3px\s*;/);
  assert.match(hidden, /display\s*:\s*none\s*!important\s*;/);
  assert.match(skeletonGrid, /display\s*:\s*grid\s*;/);
  assert.match(skeletonGrid, /grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/);
  assert.match(skeletonGrid, /gap\s*:\s*18px\s*;/);
  assert.match(mobileSkeletonGrid, /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.match(mobileSkeletonGrid, /gap\s*:\s*14px\s*;/);
  assert.match(loading, /text-align\s*:\s*left\s*;/);
  assert.match(error, /color\s*:\s*var\(--color-signal\)\s*;/);
  assert.match(empty, /color\s*:\s*var\(--color-muted\)\s*;/);
  assert.match(errorText, /font-size\s*:\s*15px\s*;/);
  assert.match(emptyText, /font-size\s*:\s*15px\s*;/);
  assert.match(
    reducedMotion,
    /\.repository-card-skeleton\s+\*\s*\{[^}]*animation\s*:\s*none\s*!important\s*;/s,
  );
});

test('stylesheet fixes catalog geometry across desktop and mobile', async () => {
  const css = await readStyles();

  assert.match(
    css,
    /\.repository-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
    'desktop repository grid must use two stable columns',
  );
  assert.match(
    css,
    /\.repository-owner-avatar\s*,\s*\.repository-owner-fallback\s*\{[^}]*width\s*:\s*40px\s*;[^}]*height\s*:\s*40px\s*;/s,
    'owner avatar and fallback must remain 40px square',
  );
  assert.match(css, /\.repository-homepage\s*\{[^}]*width\s*:\s*36px\s*;[^}]*height\s*:\s*36px\s*;/s);
  assert.match(css, /\.search-input\s*\{[^}]*height\s*:\s*52px\s*;/s);
  assert.match(css, /\.filter-select\s*\{[^}]*height\s*:\s*40px\s*;/s);
  assert.match(css, /\.quick-filter\s*\{[^}]*min-height\s*:\s*40px\s*;/s);
  assert.match(css, /\.repository-card\s*\{[^}]*min-height\s*:\s*[^;]+;/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.repository-grid\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/,
    'mobile repository grid must collapse to one column at 760px',
  );
});

test('Task 7 contract: filter toolbar stays compact and sticky from 761px', async () => {
  const [css, html] = await Promise.all([readStyles(), readIndex()]);
  const toolbarTag = openingTags(html, 'section').find((tag) => (
    attributes(tag)['aria-label'] === 'Repository filters'
  ));
  assert.ok(toolbarTag, 'missing production Repository filters section');
  const toolbarClasses = attributes(toolbarTag).class?.split(/\s+/).filter(Boolean) ?? [];
  assert.equal(toolbarClasses.length, 1, 'filter toolbar needs one stable production class');
  const toolbarSelector = `.${toolbarClasses[0]}`;
  const escapedSelector = toolbarSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const desktop = cssAtRuleBody(
    css,
    /@media\s*\(min-width:\s*761px\)/i,
    'desktop toolbar media query',
  );
  const mobile = cssAtRuleBody(
    css,
    /@media\s*\(max-width:\s*760px\)/i,
    'mobile toolbar media query',
  );

  assert.match(
    desktop,
    new RegExp(
      `${escapedSelector}\\s*\\{`
      + `(?=[^}]*position\\s*:\\s*sticky\\s*;)`
      + `(?=[^}]*top\\s*:\\s*0\\s*;)`
      + `(?=[^}]*z-index\\s*:\\s*[1-9]\\d*\\s*;)`
      + `(?=[^}]*background(?:-color)?\\s*:\\s*var\\(--color-(?:canvas|surface)\\)\\s*;)`
      + `(?=[^}]*padding-top\\s*:\\s*12px\\s*;)`
      + '[^}]*}',
      's',
    ),
    `${toolbarSelector} must be opaque and sticky at the desktop viewport edge`,
  );
  assert.match(
    mobile,
    new RegExp(
      `${escapedSelector}\\s*\\{`
      + `(?=[^}]*position\\s*:\\s*static\\s*;)`
      + `(?=[^}]*top\\s*:\\s*auto\\s*;)`
      + `(?=[^}]*z-index\\s*:\\s*auto\\s*;)`
      + '[^}]*}',
      's',
    ),
    `${toolbarSelector} must return to normal flow on mobile`,
  );
  assert.doesNotMatch(css, /position\s*:\s*fixed\s*;/i, 'fixed positioning risks content overlap');
});

test('document declares useful metadata and static assets', async () => {
  const html = await readIndex();
  const htmlTag = openingTags(html, 'html')[0];
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const description = openingTags(html, 'meta')
    .map((tag) => attributes(tag))
    .find((attrs) => attrs.name?.toLowerCase() === 'description');
  const links = openingTags(html, 'link').map((tag) => attributes(tag));

  assert.equal(attributes(htmlTag).lang, 'en');
  assert.ok(title && textContent(title[1]), 'missing nonempty title');
  assert.ok(description?.content.trim(), 'missing nonempty meta description');
  assert.ok(
    links.some((attrs) => attrs.rel === 'stylesheet' && attrs.href === 'styles.css'),
    'missing styles.css stylesheet',
  );
  assert.ok(
    links.some((attrs) => attrs.rel === 'icon' && attrs.href === 'assets/favicon.svg'),
    'missing favicon asset',
  );
  assert.equal(existsSync(new URL('assets/favicon.svg', root)), true, 'favicon asset does not exist');
});

test('header navigation carries the exact brand and secure icon-only source link', async () => {
  const html = await readIndex();
  const header = firstElement(html, 'header');
  const primaryNav = openingTags(header.body, 'nav')
    .find((tag) => attributes(tag)['aria-label'] === 'Primary navigation');
  const brand = header.body.match(/<a\b[^>]*\bclass=["'][^"']*\bbrand-link\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  const sourceUrl = 'https://github.com/Doithoo/awesome-stars';
  const source = linkByHref(header.body, sourceUrl);
  const sourceAttrs = attributes(source.openingTag);

  assert.match(header.openingTag, /^<header\b/i);
  assert.ok(primaryNav, 'missing Primary navigation label');
  assert.equal(textContent(brand?.[1] ?? ''), 'DOITHOO / STARS');
  assert.ok(sourceAttrs.class?.split(/\s+/).includes('source-link'));
  assert.equal(sourceAttrs.href, sourceUrl);
  assert.equal(sourceAttrs.target, '_blank');
  assert.ok(sourceAttrs.rel?.split(/\s+/).includes('noopener'));
  assert.ok(sourceAttrs.rel?.split(/\s+/).includes('noreferrer'));
  assert.ok(sourceAttrs['aria-label']?.trim(), 'source link needs an accessible name');
  const icon = source.body.match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/i);
  const iconAttrs = attributes(`<svg${icon?.[1] ?? ''}>`);
  const iconPaths = [...(icon?.[2] ?? '').matchAll(/<path\b([^>]*)\/?\s*>/gi)]
    .map((match) => attributes(`<path${match[1]}>`).d);

  assert.ok(icon, 'source link must contain an inline SVG');
  assert.equal(iconAttrs.fill, 'none');
  assert.equal(iconAttrs.stroke, 'currentColor');
  assert.equal(iconAttrs['stroke-linecap'], 'round');
  assert.equal(iconAttrs['stroke-linejoin'], 'round');
  assert.equal(iconAttrs['aria-hidden'], 'true');
  assert.equal(iconPaths.length, 2);
  assert.match(iconPaths[0], /^M15 22v-4/);
  assert.equal(iconPaths[1], 'M9 18c-4.51 2-5-2-7-2');
  assert.equal(
    textContent(source.body.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')),
    '',
    'source link must remain icon-only',
  );
});

test('search panel exposes the collection identity and labeled search control', async () => {
  const html = await readIndex();
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const searchTag = openingTagById(html, 'searchInput');
  const search = attributes(searchTag);

  assert.equal(textContent(heading?.[1] ?? ''), "Doithoo's Starred Repositories");
  openingTagById(html, 'collectionStats');
  assert.match(searchTag, /^<input\b/i);
  assert.equal(search.type, 'search');
  assert.equal(search.autocomplete, 'off');
  assert.equal(search.placeholder, 'Search by name, topic, owner, or language');
  assert.equal(labelFor(html, 'searchInput'), 'Search repositories');
});

test('catalog exposes exact filter controls and options', async () => {
  const html = await readIndex();
  const main = openingTagById(html, 'catalog');
  const toolbar = openingTags(html, 'section').find((tag) => {
    const attrs = attributes(tag);
    return attrs['aria-label'] === 'Repository filters';
  });
  const language = elementById(html, 'languageFilter');
  const languageOptions = [...language.body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
  const sort = elementById(html, 'sortSelect');
  const sortOptions = [...sort.body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
    .map((match) => ({ value: attributes(`<option${match[1]}>`).value, label: textContent(match[2]) }));
  const quickFilters = attributes(openingTagById(html, 'quickFilters'));

  assert.match(main, /^<main\b/i);
  assert.ok(toolbar, 'missing Repository filters section');
  assert.match(toolbar, /^<section\b/i);
  assert.equal(language.name, 'select');
  assert.equal(sort.name, 'select');
  assert.equal(labelFor(html, 'languageFilter'), 'Language');
  assert.equal(labelFor(html, 'sortSelect'), 'Sort');
  assert.equal(attributes(`<option${languageOptions[0]?.[1] ?? ''}>`).value, '');
  assert.equal(textContent(languageOptions[0]?.[2] ?? ''), 'All languages');
  assert.deepEqual(sortOptions, [
    { value: 'recently-starred', label: 'Recently starred' },
    { value: 'stars', label: 'Most stars' },
    { value: 'updated', label: 'Recently updated' },
    { value: 'name', label: 'Name' },
  ]);
  assert.equal(quickFilters['aria-label'], 'Popular languages');
  assert.equal(quickFilters.role, 'group');
});

test('element lookup accepts whitespace before a dynamic closing bracket', () => {
  const element = elementById('<div id="fixture">content</div   >', 'fixture');

  assert.equal(element.body, 'content');
});

test('catalog result regions preserve their semantic and live-region contracts', async () => {
  const html = await readIndex();
  const resultSummary = attributes(openingTagById(html, 'resultSummary'));
  const repositoryGrid = elementById(html, 'repositoryGrid');
  const loadMoreWrapper = openingTags(html, 'div').find((tag) => (
    attributes(tag).class?.split(/\s+/).includes('load-more')
  ));
  const loadMore = elementById(html, 'loadMoreButton');
  const loadMoreAttrs = attributes(loadMore.openingTag);
  const statusPanel = attributes(openingTagById(html, 'statusPanel'));

  assert.equal(resultSummary['aria-live'], 'polite');
  assert.equal(repositoryGrid.name, 'section');
  assert.equal(attributes(repositoryGrid.openingTag)['aria-label'], 'Repositories');
  assert.equal(loadMore.name, 'button');
  assert.ok(loadMoreWrapper, 'missing load-more wrapper');
  assert.match(loadMoreWrapper, /\shidden(?:\s|>)/i, 'load-more wrapper must fail safe without JavaScript');
  assert.equal(loadMoreAttrs.type, 'button');
  assert.match(loadMore.openingTag, /\shidden(?:\s|>)/i);
  assert.equal(textContent(loadMore.body), 'Load more');
  assert.equal(statusPanel['aria-live'], 'polite');
});

test('footer identifies Doithoo and links to source and Pages securely', async () => {
  const html = await readIndex();
  const footer = elementById(html, 'footer');
  const expectedLinks = [
    ['https://github.com/Doithoo', 'Doithoo'],
    ['https://github.com/Doithoo/awesome-stars', 'Source'],
    ['https://doithoo.github.io/awesome-stars/', 'Pages'],
  ];

  assert.equal(footer.name, 'footer');
  for (const [href, label] of expectedLinks) {
    const link = linkByHref(footer.body, href);
    assert.equal(textContent(link.body), label);
  }
});

test('page loads the application with the exact module contract', async () => {
  const html = await readIndex();
  const appScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => attributes(`<script${match[1]}>`).src === 'app.js');

  assert.equal(appScripts.length, 1);
  assert.equal(attributes(`<script${appScripts[0][1]}>`).type, 'module');
  assert.equal(textContent(appScripts[0][2]), '');
});

test('application controller imports the catalog and view contracts', async () => {
  const source = await readFile(appPath, 'utf8');

  for (const name of [
    'PAGE_SIZE',
    'filterRepositories',
    'getLanguageCounts',
    'normalizeRepositories',
    'paginateRepositories',
    'sortRepositories',
  ]) {
    assert.match(
      source,
      new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\.\\/lib\\/catalog\\.mjs['"]`, 's'),
      `missing catalog import: ${name}`,
    );
  }

  for (const name of [
    'createRepositoryCard',
    'renderLanguageOptions',
    'renderQuickFilters',
    'renderRepositoryGrid',
    'renderSummary',
    'renderLoading',
    'renderError',
    'renderEmpty',
  ]) {
    assert.match(
      source,
      new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\.\\/lib\\/view\\.mjs['"]`, 's'),
      `missing view import: ${name}`,
    );
  }

  assert.equal((source.match(/\bclass\s+CatalogApp\b/g) ?? []).length, 1);
  assert.match(source, /export\s+class\s+CatalogApp\b/);
});

test('application controller has stable state, loading policy, and action routes', async () => {
  const source = await readFile(appPath, 'utf8');

  assert.match(
    source,
    /this\.state\s*=\s*\{\s*repositories:\s*\[\],\s*query:\s*['"`]{2},\s*language:\s*['"`]{2},\s*sort:\s*['"]recently-starred['"],\s*visibleCount:\s*PAGE_SIZE,\s*status:\s*['"]loading['"],\s*error:\s*null\s*,?\s*\}/s,
  );
  assert.match(source, /new\s+AbortController\s*\(/);
  assert.match(source, /const\s+LOAD_TIMEOUT_MS\s*=\s*10_?000\s*;/);
  assert.match(source, /(?:this\.)?setTimeout\s*\([\s\S]*?,\s*LOAD_TIMEOUT_MS\s*\)/);
  assert.match(source, /(?:this\.)?clearTimeout\s*\(/);
  assert.match(
    source,
    /response\.json\s*\(\s*\)[\s\S]*?catch\s*\(\s*error\s*\)\s*\{[\s\S]*?error\.name\s*===\s*['"]AbortError['"][\s\S]*?throw\s+error\s*;/,
    'JSON parsing must preserve AbortError for timeout handling',
  );
  assert.match(source, /fetch\s*\(\s*['"]data\.json['"]\s*,\s*\{\s*signal\s*:\s*[^,}]+,\s*cache\s*:\s*['"]default['"]\s*,?\s*\}\s*\)/s);
  assert.match(source, /const\s+SEARCH_DEBOUNCE_MS\s*=\s*175\s*;/);

  for (const message of [
    'The repository list took too long to load.',
    'The repository list could not be downloaded.',
    'The repository data is not valid.',
  ]) {
    assert.ok(source.includes(message), `missing exact error message: ${message}`);
  }

  for (const id of [
    'collectionStats',
    'searchInput',
    'languageFilter',
    'sortSelect',
    'quickFilters',
    'resultSummary',
    'repositoryGrid',
    'loadMoreButton',
    'statusPanel',
  ]) {
    assert.match(source, new RegExp(`['"]${id}['"]`), `controller must cache #${id}`);
  }

  for (const action of ['filter-language', 'retry', 'clear-filters']) {
    assert.match(source, new RegExp(`['"]${action}['"]`), `missing ${action} action route`);
  }

  assert.match(source, /setLoadMoreVisibility\s*\(\s*visible\s*\)\s*\{/);
  assert.equal(
    (source.match(/elements\.loadMoreButton\.hidden\s*=/g) ?? []).length,
    1,
    'only the synchronized visibility helper may assign button.hidden',
  );

  for (const [element, eventName] of [
    ['searchInput', 'input'],
    ['languageFilter', 'change'],
    ['sortSelect', 'change'],
    ['quickFilters', 'click'],
    ['loadMoreButton', 'click'],
    ['statusPanel', 'click'],
  ]) {
    const listener = new RegExp(`this\\.elements\\.${element}\\.addEventListener\\(\\s*['"]${eventName}['"]`, 'g');
    assert.equal((source.match(listener) ?? []).length, 1, `${element} listener must be bound once`);
  }

  assert.match(
    source,
    /searchInput\.addEventListener\(\s*['"]input['"]\s*,\s*\(event\)\s*=>\s*\{\s*const\s+query\s*=\s*event\.currentTarget\.value\.trim\(\);\s*this\.state\.query\s*=\s*query;[\s\S]*?setTimeout\s*\(/,
    'search state must update before scheduling the debounced render',
  );
});

test('CatalogApp starts with the exact public state contract', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document } = createControllerDocument();
  const app = new CatalogApp(document);

  assert.deepEqual(app.state, {
    repositories: [],
    query: '',
    language: '',
    sort: 'recently-starred',
    visibleCount: 24,
    status: 'loading',
    error: null,
  });
});

test('CatalogApp fails clearly when the required load-more wrapper is missing', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  elements.loadMoreButton.parentElement = null;
  const app = new CatalogApp(document);

  assert.throws(
    () => app.cacheElements(),
    /Required \.load-more wrapper was not found\./,
  );

  const nested = createControllerDocument();
  const intermediate = new FakeElement();
  nested.elements.loadMoreWrapper.replaceChildren(intermediate);
  intermediate.append(nested.elements.loadMoreButton);
  const nestedApp = new CatalogApp(nested.document);
  assert.throws(
    () => nestedApp.cacheElements(),
    /Required \.load-more wrapper was not found\./,
    'the load-more wrapper must be the button direct parent',
  );
});

test('CatalogApp init and retry never bind static listeners more than once', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  const app = new CatalogApp(document);
  let loadCount = 0;
  let bindCount = 0;
  const bindEvents = app.bindEvents.bind(app);

  app.bindEvents = () => {
    bindCount += 1;
    bindEvents();
  };
  app.loadData = () => {
    loadCount += 1;
  };

  app.init();
  app.init();
  assert.equal(bindCount, 1);
  assert.equal(loadCount, 1);

  for (const [id, eventName] of [
    ['searchInput', 'input'],
    ['languageFilter', 'change'],
    ['sortSelect', 'change'],
    ['quickFilters', 'click'],
    ['loadMoreButton', 'click'],
    ['statusPanel', 'click'],
  ]) {
    assert.equal(elements[id].listenerCount(eventName), 1, `unexpected ${id} listener count`);
  }

  const retry = {
    dataset: { action: 'retry' },
    closest: () => retry,
  };
  elements.statusPanel.dispatch('click', { target: retry });
  assert.equal(loadCount, 2);
  assert.equal(bindCount, 1);
});

test('CatalogApp search uses an exact controllable 175ms debounce', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  const { view } = createViewSpies();
  const timers = [];
  const cleared = [];
  const app = new CatalogApp(document, {
    view,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => cleared.push(timer),
  });
  let renderCount = 0;
  app.loadData = () => {};
  app.render = () => {
    renderCount += 1;
  };
  app.init();
  app.state.visibleCount = 72;
  elements.searchInput.value = '  swift tools  ';

  elements.searchInput.dispatch('input');

  assert.equal(app.state.query, 'swift tools');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 175);
  timers[0].callback();
  assert.equal(app.state.query, 'swift tools');
  assert.equal(app.state.visibleCount, 24);
  assert.equal(renderCount, 1);
  assert.deepEqual(cleared, [null]);
});

test('CatalogApp preserves a typed query when another control renders before debounce', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  const { view } = createViewSpies();
  const timers = [];
  const app = new CatalogApp(document, {
    view,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => {},
  });
  app.loadData = () => {};
  app.init();
  app.state.status = 'ready';
  app.state.repositories = [repository(1)];
  elements.searchInput.value = 'repo';

  elements.searchInput.dispatch('input');
  elements.sortSelect.value = 'name';
  elements.sortSelect.dispatch('change');

  assert.equal(app.state.query, 'repo');
  assert.equal(elements.searchInput.value, 'repo');
  assert.equal(timers.length, 1);
});

test('CatalogApp filter controls synchronize state and reset pagination', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  const app = new CatalogApp(document);
  let renderCount = 0;
  app.loadData = () => {};
  const replacementQuickFilter = {
    dataset: { language: 'Go' },
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
  };
  app.render = () => {
    renderCount += 1;
    if (app.state.language === 'Go') {
      elements.quickFilters.queryResults = [
        { dataset: { language: 'Rust' }, focus() {} },
        replacementQuickFilter,
      ];
    }
  };
  app.init();

  app.state.visibleCount = 60;
  elements.languageFilter.value = 'Rust';
  elements.languageFilter.dispatch('change');
  assert.equal(app.state.language, 'Rust');
  assert.equal(app.state.visibleCount, 24);

  app.state.visibleCount = 60;
  elements.sortSelect.value = 'stars';
  elements.sortSelect.dispatch('change');
  assert.equal(app.state.sort, 'stars');
  assert.equal(app.state.visibleCount, 24);

  const quickFilter = {
    container: elements.quickFilters,
    dataset: { action: 'filter-language', language: 'Go' },
    closest: () => quickFilter,
  };
  app.state.visibleCount = 60;
  elements.quickFilters.dispatch('click', { target: quickFilter });
  assert.equal(app.state.language, 'Go');
  assert.equal(elements.languageFilter.value, 'Go');
  assert.equal(app.state.visibleCount, 24);
  assert.equal(replacementQuickFilter.focusCount, 1);
  assert.equal(renderCount, 3);

  app.state.query = 'server';
  app.state.language = 'Go';
  app.state.visibleCount = 72;
  elements.searchInput.value = 'server';
  elements.languageFilter.value = 'Go';
  const clear = {
    dataset: { action: 'clear-filters' },
    closest: () => clear,
  };
  elements.statusPanel.dispatch('click', { target: clear });
  assert.equal(app.state.query, '');
  assert.equal(app.state.language, '');
  assert.equal(app.state.visibleCount, 24);
  assert.equal(elements.searchInput.value, '');
  assert.equal(elements.languageFilter.value, '');
  assert.equal(renderCount, 4);
});

test('CatalogApp derives filter, stable sort, and pagination without mutating repositories', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document } = createControllerDocument();
  const app = new CatalogApp(document);
  const repositories = [
    repository(1, { name: 'alpha tool', stars: 2 }),
    repository(2, { name: 'alpha server', stars: 9 }),
    repository(3, { name: 'alpha client', language: 'Rust', stars: 20 }),
    repository(4, { name: 'unrelated', stars: 50 }),
  ];
  app.state.repositories = repositories;
  app.state.query = 'alpha';
  app.state.language = 'JavaScript';
  app.state.sort = 'stars';
  app.state.visibleCount = 1;

  const derived = app.getDerivedRepositories();

  assert.deepEqual(derived.filtered.map(({ id }) => id), [1, 2]);
  assert.deepEqual(derived.sorted.map(({ id }) => id), [2, 1]);
  assert.deepEqual(derived.visible.map(({ id }) => id), [2]);
  assert.equal(derived.hasMore, true);
  assert.equal(app.state.repositories, repositories);
  assert.deepEqual(repositories.map(({ id }) => id), [1, 2, 3, 4]);
});

test('CatalogApp uses full collection language counts when rendering controls', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document } = createControllerDocument();
  const { calls, view } = createViewSpies();
  const app = new CatalogApp(document, { view });
  app.cacheElements();
  app.state.repositories = [
    repository(1),
    repository(2, { language: 'Rust' }),
    repository(3, { language: 'Rust' }),
  ];
  app.state.language = 'JavaScript';

  app.renderCollectionControls();

  const languageOptions = calls.find(({ name }) => name === 'renderLanguageOptions');
  const quickFilters = calls.find(({ name }) => name === 'renderQuickFilters');
  assert.deepEqual({ ...languageOptions.args[1] }, { JavaScript: 1, Rust: 2 });
  assert.deepEqual({ ...quickFilters.args[1] }, { JavaScript: 1, Rust: 2 });
  assert.equal(languageOptions.args[2], 'JavaScript');
  assert.equal(app.elements.collectionStats.textContent, '3 repositories across 2 languages');
});

test('CatalogApp loadMore advances by PAGE_SIZE and appends only newly visible cards', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  const { calls, view } = createViewSpies();
  view.renderRepositoryGrid = (grid, repositories) => {
    calls.push({ name: 'renderRepositoryGrid', args: [grid, repositories] });
    grid.replaceChildren(...repositories.map((item) => ({ repository: item })));
  };
  const app = new CatalogApp(document, { view });
  app.cacheElements();
  app.state.repositories = Array.from({ length: 30 }, (_, index) => repository(index + 1));
  app.state.status = 'ready';

  app.render();
  assert.equal(elements.repositoryGrid.children.length, 24);
  const gridRenderCount = calls.filter(({ name }) => name === 'renderRepositoryGrid').length;

  app.loadMore();

  assert.equal(app.state.visibleCount, 48);
  assert.equal(elements.repositoryGrid.children.length, 30);
  assert.deepEqual(
    elements.repositoryGrid.children.map(({ repository: item }) => item.id),
    Array.from({ length: 30 }, (_, index) => index + 1),
  );
  assert.equal(
    calls.filter(({ name }) => name === 'renderRepositoryGrid').length,
    gridRenderCount,
    'loadMore must append without replacing the existing grid',
  );
  assert.equal(elements.loadMoreButton.hidden, true);
  const summary = calls.findLast(({ name }) => name === 'renderSummary');
  assert.deepEqual(summary.args[1], { visibleCount: 30, filteredCount: 30, totalCount: 30 });

  app.state.status = 'loading';
  app.loadMore();
  assert.equal(app.state.visibleCount, 48);
  assert.equal(elements.repositoryGrid.children.length, 30);
});

test('Task 7 contract: load-more wrapper is visible only while another page exists', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  const { view } = createViewSpies();
  const app = new CatalogApp(document, { view });
  app.cacheElements();
  app.state.status = 'ready';
  app.state.repositories = Array.from({ length: 25 }, (_, index) => repository(index + 1));
  elements.loadMoreButton.hidden = true;
  elements.loadMoreWrapper.hidden = true;

  app.render();
  assert.equal(elements.loadMoreButton.hidden, false);
  assert.equal(elements.loadMoreWrapper.hidden, false);

  app.state.repositories = app.state.repositories.slice(0, 24);
  app.render();
  assert.equal(elements.loadMoreButton.hidden, true);
  assert.equal(elements.loadMoreWrapper.hidden, true, 'final page must not leave a layout band');

  app.state.repositories = [];
  app.render();
  assert.equal(elements.loadMoreButton.hidden, true);
  assert.equal(elements.loadMoreWrapper.hidden, true, 'empty results must not leave a layout band');

  elements.loadMoreButton.hidden = false;
  elements.loadMoreWrapper.hidden = false;
  app.showError('Unable to load.');
  assert.equal(elements.loadMoreButton.hidden, true);
  assert.equal(elements.loadMoreWrapper.hidden, true, 'errors must not leave a layout band');
});

test('CatalogApp ignores an older aborted request after a newer request succeeds', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  const { calls, view } = createViewSpies();
  const requests = [];
  const clearedTimers = [];
  const app = new CatalogApp(document, {
    view,
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ options, reject, resolve, url });
    }),
    setTimeout: (callback, delay) => ({ callback, delay }),
    clearTimeout: (timer) => clearedTimers.push(timer),
  });
  app.cacheElements();

  const firstLoad = app.loadData();
  const secondLoad = app.loadData();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(requests[1].options.signal.aborted, false);

  requests[1].resolve({ ok: true, json: () => Promise.resolve([{ id: 2, name: 'newer' }]) });
  await secondLoad;
  requests[0].reject(Object.assign(new Error('late abort'), { name: 'AbortError' }));
  await firstLoad;

  assert.equal(app.state.status, 'ready');
  assert.equal(app.state.error, null);
  assert.deepEqual(app.state.repositories.map(({ id }) => id), [2]);
  assert.equal(elements.catalog.getAttribute('aria-busy'), null);
  assert.equal(calls.some(({ name }) => name === 'renderError'), false);
  assert.equal(clearedTimers.length, 2);
});

test('CatalogApp prevents an older success from overwriting newer repository data', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document } = createControllerDocument();
  const { calls, view } = createViewSpies();
  const requests = [];
  const app = new CatalogApp(document, {
    view,
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ options, reject, resolve, url });
    }),
    setTimeout: () => Symbol('timer'),
    clearTimeout: () => {},
  });
  app.cacheElements();

  const firstLoad = app.loadData();
  const secondLoad = app.loadData();
  requests[1].resolve({ ok: true, json: () => Promise.resolve([{ id: 2, name: 'newer' }]) });
  await secondLoad;
  requests[0].resolve({ ok: true, json: () => Promise.resolve([{ id: 1, name: 'older' }]) });
  await firstLoad;

  assert.deepEqual(app.state.repositories.map(({ id }) => id), [2]);
  const gridRenders = calls.filter(({ name }) => name === 'renderRepositoryGrid');
  assert.equal(gridRenders.length, 1);
  assert.deepEqual(gridRenders[0].args[1].map(({ id }) => id), [2]);
  assert.equal(calls.some(({ name }) => name === 'renderError'), false);
});

test('CatalogApp executes loading, ready, and error controller transitions', async () => {
  const { CatalogApp } = await importControllerModule();
  const { document, elements } = createControllerDocument();
  const { calls, view } = createViewSpies();
  let resolveFetch;
  const clearedTimers = [];
  const app = new CatalogApp(document, {
    view,
    fetch: (url, options) => new Promise((resolve) => {
      resolveFetch = () => resolve({
        ok: true,
        json: async () => [{ id: 1, name: 'catalog' }],
      });
      calls.push({ name: 'fetch', args: [url, options] });
    }),
    setTimeout: () => 'load-timeout',
    clearTimeout: (timer) => clearedTimers.push(timer),
  });
  app.cacheElements();
  app.state.status = 'error';
  app.state.error = 'stale';
  elements.repositoryGrid.children = ['stale-card'];
  elements.resultSummary.textContent = 'stale summary';
  elements.loadMoreButton.hidden = false;

  const loading = app.loadData();
  assert.equal(app.state.status, 'loading');
  assert.equal(app.state.error, null);
  assert.equal(elements.catalog.getAttribute('aria-busy'), 'true');
  assert.deepEqual(elements.repositoryGrid.children, []);
  assert.equal(elements.resultSummary.textContent, '');
  assert.equal(elements.loadMoreButton.hidden, true);
  assert.equal(elements.loadMoreWrapper.hidden, true, 'loading must hide the entire command band');
  assert.ok(calls.some(({ name }) => name === 'renderLoading'));
  assert.deepEqual(calls.find(({ name }) => name === 'fetch').args.slice(0, 1), ['data.json']);
  assert.equal(calls.find(({ name }) => name === 'fetch').args[1].cache, 'default');

  resolveFetch();
  await loading;
  assert.equal(app.state.status, 'ready');
  assert.equal(app.state.error, null);
  assert.equal(app.state.repositories.length, 1);
  assert.equal(elements.catalog.getAttribute('aria-busy'), null);
  assert.equal(elements.statusPanel.hidden, true);
  assert.equal(elements.loadMoreWrapper.hidden, true);
  assert.deepEqual(clearedTimers, ['load-timeout']);
  assert.ok(calls.some(({ name }) => name === 'renderRepositoryGrid'));

  elements.repositoryGrid.children = ['stale-card'];
  elements.resultSummary.textContent = 'stale summary';
  elements.loadMoreButton.hidden = false;
  elements.catalog.setAttribute('aria-busy', 'true');
  app.showError('The repository list could not be downloaded.');
  assert.equal(app.state.status, 'error');
  assert.equal(app.state.error, 'The repository list could not be downloaded.');
  assert.equal(elements.catalog.getAttribute('aria-busy'), null);
  assert.deepEqual(elements.repositoryGrid.children, []);
  assert.equal(elements.resultSummary.textContent, '');
  assert.equal(elements.loadMoreButton.hidden, true);
  assert.equal(elements.loadMoreWrapper.hidden, true, 'errors must hide the entire command band');
  assert.deepEqual(
    calls.findLast(({ name }) => name === 'renderError').args.slice(1),
    ['The repository list could not be downloaded.'],
  );
});

for (const scenario of [
  {
    name: 'abort timeout',
    message: 'The repository list took too long to load.',
    fail({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    trigger(timers) {
      assert.equal(timers[0].delay, 10_000);
      timers[0].callback();
    },
  },
  {
    name: 'network rejection',
    message: 'The repository list could not be downloaded.',
    fail() {
      return Promise.reject(new Error('offline'));
    },
  },
  {
    name: 'non-ok HTTP response',
    message: 'The repository list could not be downloaded.',
    fail() {
      return Promise.resolve({ ok: false });
    },
  },
  {
    name: 'JSON syntax rejection',
    message: 'The repository data is not valid.',
    fail() {
      return Promise.resolve({
        ok: true,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      });
    },
  },
  {
    name: 'invalid grouped schema',
    message: 'The repository data is not valid.',
    fail() {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ JavaScript: 'not-an-array' }),
      });
    },
  },
]) {
  test(`CatalogApp loadData maps ${scenario.name} and recovers on retry`, async () => {
    const { CatalogApp } = await importControllerModule();
    const { document, elements } = createControllerDocument();
    const { calls, view } = createViewSpies();
    const timers = [];
    const clearedTimers = [];
    let attempt = 0;
    const app = new CatalogApp(document, {
      view,
      fetch: (url, options) => {
        attempt += 1;
        if (attempt === 1) {
          return scenario.fail(options);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      },
      setTimeout: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => clearedTimers.push(timer),
    });
    app.cacheElements();

    const failedLoad = app.loadData();
    scenario.trigger?.(timers);
    await failedLoad;

    assert.equal(app.state.status, 'error');
    assert.equal(app.state.error, scenario.message);
    assert.equal(elements.loadMoreButton.hidden, true);
    assert.equal(elements.catalog.getAttribute('aria-busy'), null);
    const renderedError = calls.find(({ name }) => name === 'renderError');
    assert.equal(renderedError.args[1], scenario.message);
    assert.deepEqual(clearedTimers, [timers[0]]);

    await app.loadData();

    assert.equal(attempt, 2);
    assert.equal(app.state.status, 'ready');
    assert.equal(app.state.error, null);
    assert.deepEqual(app.state.repositories, []);
    assert.equal(elements.loadMoreButton.hidden, true);
    assert.equal(elements.catalog.getAttribute('aria-busy'), null);
    assert.equal(calls.filter(({ name }) => name === 'renderError').length, 1);
    const emptyCall = calls.find(({ name }) => name === 'renderEmpty');
    assert.deepEqual(emptyCall.args[1], { collectionEmpty: true });
    assert.deepEqual(clearedTimers, [timers[0], timers[1]]);
  });
}

for (const [name, data] of [['grouped object', {}], ['array', []]]) {
  test(`CatalogApp loadData accepts an empty ${name}`, async () => {
    const { CatalogApp } = await importControllerModule();
    const { document, elements } = createControllerDocument();
    const { calls, view } = createViewSpies();
    const timers = [];
    const clearedTimers = [];
    const app = new CatalogApp(document, {
      view,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(data) }),
      setTimeout: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => clearedTimers.push(timer),
    });
    app.cacheElements();

    await app.loadData();

    assert.equal(app.state.status, 'ready');
    assert.deepEqual(app.state.repositories, []);
    assert.equal(app.state.error, null);
    const emptyCall = calls.find(({ name: callName }) => callName === 'renderEmpty');
    assert.deepEqual(emptyCall.args[1], { collectionEmpty: true });
    assert.equal(calls.some(({ name: callName }) => callName === 'renderError'), false);
    assert.equal(elements.statusPanel.getAttribute('aria-busy'), null);
    assert.equal(elements.catalog.getAttribute('aria-busy'), null);
    assert.equal(elements.loadMoreButton.hidden, true);
    assert.deepEqual(clearedTimers, timers);
  });
}

test('application controller excludes legacy and unsafe behavior', async () => {
  const source = await readFile(appPath, 'utf8');
  const forbidden = [
    /\.innerHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\bsetInterval\s*\(/,
    /\bPerformanceObserver\b|\bperformance\s*\./i,
    /\bmemory\b|\bgpu\b|\bparallax\b|virtual\s*scroll/i,
    /\.tabIndex\s*=\s*[1-9]\d*|setAttribute\(\s*['"]tabindex['"]\s*,\s*['"]?[1-9]/i,
    /document\.addEventListener\(\s*['"]keydown['"]|window\.addEventListener\(\s*['"]keydown['"]/,
    /typeof\s+process|window\.process|module\.exports|\brequire\s*\(/,
    /\bIntersectionObserver\b|\bMutationObserver\b/,
    /\banalytics\b|console\.log\s*\(|\btoast\b|\btouch(?:start|move|end)\b/i,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern);
  }

  const methodNames = [...source.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)]
    .map((match) => match[1]);
  assert.equal(methodNames.length, new Set(methodNames).size, 'duplicate controller method definition');
});

test('active page contains no legacy ownership or unsafe rendering hook', async () => {
  const html = await readIndex();

  assert.match(html, />DOITHOO \/ STARS</);
  assert.match(html, /https:\/\/github\.com\/Doithoo\/awesome-stars/);
  assert.doesNotMatch(html, /tonngw/i);
  assert.doesNotMatch(html, /innerHTML/);
  assert.equal(existsSync(new URL('index-simple.html', root)), false);
});

test('tracked tree excludes obsolete templates and process documents', () => {
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);

  assert.equal(trackedFiles.includes('template/README.ejs'), false);
  assert.equal(
    trackedFiles.some((relativePath) => relativePath.startsWith('docs/superpowers/')),
    false,
  );
});

test('active project files contain no legacy owner or domain references', async () => {
  const testSource = await readFile(new URL(import.meta.url), 'utf8');
  const legacyOwner = ['ton', 'ngw'].join('');
  const legacyDomain = `awesome.${legacyOwner}.com`;
  const excludedPaths = new Set([
    'LICENSE',
    'data.json',
    'data.md',
    'test/site-structure.test.mjs',
    'test/update-awesome-list.test.mjs',
  ]);
  const textExtensions = new Set(['.css', '.ejs', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.yml', '.yaml']);
  const violations = [];
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);

  for (const relativePath of trackedFiles) {
    if (excludedPaths.has(relativePath)) continue;
    const extension = relativePath.slice(relativePath.lastIndexOf('.'));
    if (!textExtensions.has(extension)) continue;

    const source = await readFile(new URL(relativePath, root), 'utf8');
    if (source.toLowerCase().includes(legacyOwner) || source.toLowerCase().includes(legacyDomain)) {
      violations.push(relativePath);
    }
  }

  assert.deepEqual(violations, []);
  assert.match(testSource, /execFileSync\(\s*['"]git['"]\s*,\s*\[['"]ls-files['"],\s*['"]-z['"]\]/);
  const fsPromisesImport = testSource.match(/import \{([^}]+)\} from 'node:fs\/promises';/)?.[1] ?? '';
  assert.doesNotMatch(fsPromisesImport, /\breaddir\b/);
});

test('package metadata and locked local scripts belong to Doithoo', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const packageLock = JSON.parse(await readFile(packageLockPath, 'utf8'));
  const lockRoot = packageLock.packages[''];

  assert.equal(packageJson.description, 'A searchable, responsive catalog of GitHub repositories starred by Doithoo');
  assert.equal(packageJson.repository.url, 'git+https://github.com/Doithoo/awesome-stars.git');
  assert.equal(packageJson.bugs.url, 'https://github.com/Doithoo/awesome-stars/issues');
  assert.equal(packageJson.homepage, 'https://doithoo.github.io/awesome-stars/');
  assert.equal(packageJson.author, 'Doithoo');
  assert.equal(packageJson.keywords.includes('dark-theme'), false);
  assert.equal(packageJson.keywords.includes('light-theme'), false);
  for (const name of ['start', 'dev', 'serve', 'preview']) {
    assert.match(packageJson.scripts[name], /^serve\b/);
    assert.doesNotMatch(packageJson.scripts[name], /\bnpx\b/);
  }
  assert.equal(lockRoot.name, packageJson.name);
  assert.equal(lockRoot.version, packageJson.version);
  assert.equal(lockRoot.license, packageJson.license);
  assert.deepEqual(lockRoot.devDependencies, packageJson.devDependencies);
});

test('README documents the bilingual project, operation, security, and testing contract', async () => {
  const [readme, chineseReadme] = await Promise.all([
    readFile(readmePath, 'utf8'),
    readFile(chineseReadmePath, 'utf8'),
  ]);
  const documentation = `${readme}\n${chineseReadme}`;
  const requiredText = [
    'https://doithoo.github.io/awesome-stars/',
    'https://github.com/Doithoo/awesome-stars',
    'API_TOKEN',
    'GITHUB_TOKEN',
    'npm ci',
    'npm run preview',
    'npm test',
    'npm run test:e2e',
    'npm run test:all',
    'npx playwright install chromium',
    'Update awesome list',
    'Deploy static content to Pages',
    'data.json',
    'MIT License',
  ];

  for (const text of requiredText) assert.ok(readme.includes(text), `README missing ${text}`);
  assert.match(readme, /\[中文\]\(README\.zh-CN\.md\)/);
  assert.match(chineseReadme, /\[英文版\]\(README\.md\)/);
  assert.match(chineseReadme, /自动更新|GitHub API/);
  assert.match(chineseReadme, /API_TOKEN/);
  assert.match(documentation, /every six hours|每六小时/i);
  assert.match(documentation, /GitHub Actions/);
  assert.match(documentation, /GitHub Pages/);
  assert.match(documentation, /fine-grained PAT/i);
  assert.match(documentation, /Starring: read/i);
  assert.match(documentation, /read-only|只读/i);
  assert.match(documentation, /private repositor|私有仓库/i);
  assert.match(documentation, /explicitly marked public|明确标记为公开/i);
  assert.match(documentation, /private[^\n]*internal[^\n]*unknown|私有[^\n]*内部[^\n]*未知/i);
  assert.match(documentation, /publicly committed|公开提交/i);
  assert.match(documentation, /OIDC/i);
  assert.match(documentation, /Node\.js 22[^\n]*(?:CI|test)|(?:CI|test)[^\n]*Node\.js 22/i);
  assert.match(documentation, /npm ci\s*\n+npx playwright install chromium\s*\n+npm run test:all/);
  assert.match(documentation, /repository contents[^\n]*(?:not required|no access)|不需要[^\n]*仓库内容/i);
  assert.match(documentation, /private repositor[^\n]*(?:no access|not required)|不需要[^\n]*私有仓库/i);
  assert.match(documentation, /English UI|界面.*英文/i);
  assert.doesNotMatch(documentation, /\]\((?:CONTRIBUTING\.md|docs\/[^)]+)\)/i);
  assert.doesNotMatch(documentation, /mawesome/i);
  assert.doesNotMatch(documentation, /(?:ik\.imagekit\.io|githubusercontent\.com)\/[^\s)]*(?:ton|ngw)/i);
  assert.doesNotMatch(documentation, /(?:add|grant|enable|increase|增加|授予|开启)[^\n]*(?:private repositor|私有仓库)/i);
});

test('changelog covers the unreleased redesign and delivery gates', async () => {
  const changelog = await readFile(changelogPath, 'utf8');
  const unreleased = changelog.split(/## \[?1\.0\.0\]?/i)[0];

  assert.match(unreleased, /## \[Unreleased\]/);
  assert.doesNotMatch(unreleased, /^### Quality$/m);
  assert.match(unreleased, /^### Added$/m);
  assert.match(unreleased, /^### Security$/m);
  for (const phrase of ['Graphic Signal', 'modular frontend', 'safe rendering', 'reduced payload', 'browser coverage', 'CI', 'Pages']) {
    assert.match(unreleased, new RegExp(phrase, 'i'), `Unreleased changelog missing ${phrase}`);
  }
});

test('license grants MIT terms under the Doithoo copyright', async () => {
  const license = await readFile(licensePath, 'utf8');

  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Doithoo/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('document metadata identifies the current Doithoo catalog', async () => {
  const html = await readIndex();

  assert.match(html, /<title>Doithoo's Starred Repositories<\/title>/);
  assert.match(html, /<meta name="author" content="Doithoo">/);
  assert.match(html, /<meta name="description" content="A searchable catalog of repositories starred by Doithoo\.">/);
  assert.match(html, /https:\/\/github\.com\/Doithoo\/awesome-stars/);
  assert.match(html, /https:\/\/doithoo\.github\.io\/awesome-stars\//);
  assert.match(html, /<meta name="theme-color" content="#f8f9fb">/);
});

test('stable integration IDs are unique', async () => {
  const html = await readIndex();
  const stableIds = [
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
    'footer',
  ];

  for (const id of stableIds) {
    const occurrences = openingTags(html, '[a-z][\\w-]*')
      .filter((tag) => attributes(tag).id === id);
    assert.equal(occurrences.length, 1, `expected exactly one #${id}`);
  }
});

test('README does not reference the deleted alternate shell', async () => {
  const readme = await readFile(readmePath, 'utf8');

  assert.doesNotMatch(readme, /index-simple\.html/i);
});

test('generated local artifacts are ignored with exact root entries', async () => {
  const entries = (await readFile(ignorePath, 'utf8')).split(/\r?\n/);

  for (const entry of ['.worktrees/', 'playwright-report/', 'test-results/']) {
    assert.ok(entries.includes(entry), `missing exact .gitignore entry: ${entry}`);
  }
});

test('external static links open securely in a new tab', async () => {
  const html = await readIndex();
  const externalLinks = openingTags(html, 'a')
    .filter((tag) => /^https?:\/\//.test(attributes(tag).href ?? ''));

  assert.ok(externalLinks.length > 0, 'expected at least one external link');
  for (const link of externalLinks) {
    const attrs = attributes(link);
    const rel = attrs.rel?.split(/\s+/) ?? [];

    assert.equal(attrs.target, '_blank', `missing target on ${link}`);
    assert.ok(rel.includes('noopener'), `missing noopener on ${link}`);
    assert.ok(rel.includes('noreferrer'), `missing noreferrer on ${link}`);
  }
});

test('safe DOM view exposes the complete rendering contract', async () => {
  assert.equal(existsSync(viewPath), true, 'missing lib/view.mjs');

  const view = await import(viewPath);
  const expectedExports = [
    'createRepositoryCard',
    'renderLanguageOptions',
    'renderQuickFilters',
    'renderRepositoryGrid',
    'renderSummary',
    'renderLoading',
    'renderError',
    'renderEmpty',
  ];

  assert.deepEqual(Object.keys(view).sort(), expectedExports.sort());
  for (const name of expectedExports) {
    assert.equal(typeof view[name], 'function', `${name} must be a function`);
  }
});

test('safe DOM view enforces URL policy inside link and image sinks', async () => {
  const source = await readFile(viewPath, 'utf8');
  const linkHelper = source.match(/function secureExternalLink\b[\s\S]*?\n}/)?.[0] ?? '';
  const avatarHelper = source.match(/function createAvatar\b[\s\S]*?\n}/)?.[0] ?? '';

  assert.match(
    source,
    /import\s*\{[^}]*\bgetSafeUrl\b[^}]*\}\s*from\s*['"]\.\/catalog\.mjs['"]/s,
  );
  assert.notEqual(linkHelper, '', 'missing secureExternalLink helper');
  assert.match(
    linkHelper,
    /function secureExternalLink\(\s*className\s*,\s*candidateUrl\s*,\s*\{\s*label\s*,\s*githubOnly\s*\}\s*\)/,
  );
  assert.match(
    linkHelper,
    /const\s+url\s*=\s*getSafeUrl\(\s*candidateUrl\s*,\s*\{\s*githubOnly\s*\}\s*\)/,
  );
  assert.match(linkHelper, /if\s*\(\s*!url\s*\)\s*\{[\s\S]*?return null;/);
  assert.match(linkHelper, /attributes\s*:\s*\{\s*href\s*:\s*url\s*\}/);

  assert.notEqual(avatarHelper, '', 'missing createAvatar helper');
  assert.match(
    avatarHelper,
    /const\s+avatarUrl\s*=\s*getSafeUrl\(\s*avatarCandidate\s*\)/,
  );
  assert.match(avatarHelper, /attributes\s*:\s*\{\s*src\s*:\s*avatarUrl\s*,/);
  assert.match(source, /createAvatar\(\s*owner\.avatarUrl\s*,\s*login\s*\)/);

  assert.match(
    source,
    /secureExternalLink\(\s*['"]repository-name['"]\s*,\s*repository\.repositoryUrl\s*,\s*\{\s*label\s*:\s*`View \$\{fullName\} on GitHub`\s*,\s*githubOnly\s*:\s*true\s*,?\s*\}\s*,?\s*\)/,
  );
  assert.match(
    source,
    /secureExternalLink\(\s*['"]repository-owner['"]\s*,\s*owner\.profileUrl\s*,\s*\{\s*label\s*:\s*`View \$\{login\} on GitHub`\s*,\s*githubOnly\s*:\s*true\s*,?\s*\}\s*,?\s*\)/,
  );
  assert.match(
    source,
    /secureExternalLink\(\s*['"]repository-homepage['"]\s*,\s*repository\.homepage\s*,\s*\{\s*label\s*:\s*`Visit the \$\{fullName\} homepage`\s*,\s*githubOnly\s*:\s*false\s*,?\s*\}\s*,?\s*\)/,
  );
  assert.doesNotMatch(
    source,
    /(?:href|src)\s*:\s*(?:repository|owner)\.(?:repositoryUrl|profileUrl|homepage|avatarUrl)/,
  );
  assert.doesNotMatch(
    source,
    /setAttribute\(\s*['"](?:href|src)['"]\s*,\s*(?:repository|owner)\./,
  );
  assert.doesNotMatch(source, /\bsafeHttpsUrl\b/);
});

test('topic links use their visible topic text as the accessible name', async () => {
  const source = await readFile(viewPath, 'utf8');

  assert.match(
    source,
    /secureExternalLink\(\s*['"]repository-topic['"]\s*,\s*`https:\/\/github\.com\/topics\/\$\{encodeURIComponent\(topic\)\}`\s*,\s*\{\s*githubOnly\s*:\s*true\s*,?\s*\}\s*,?\s*\)/,
  );
  assert.match(source, /link\.textContent\s*=\s*topic/);
  assert.doesNotMatch(source, /Browse this topic on GitHub/);
});

test('repository cards expose each repository name as an article heading', async () => {
  const source = await readFile(viewPath, 'utf8');

  assert.match(
    source,
    /const\s+titleHeading\s*=\s*element\(\s*['"]h2['"]\s*,\s*\{\s*className\s*:\s*['"]repository-title['"]\s*\}\s*\)/,
  );
  assert.match(source, /titleHeading\.append\(\s*title\s*\)/);
  assert.match(source, /identity\.append\(\s*titleHeading\s*\)/);
});

test('status renderers rely on the shell live region without nested roles', async () => {
  const source = await readFile(viewPath, 'utf8');

  assert.doesNotMatch(
    source,
    /\brole\s*:\s*['"](?:status|alert)['"]|setAttribute\(\s*['"]role['"]\s*,\s*['"](?:status|alert)['"]/,
  );
  assert.doesNotMatch(source, /['"]aria-live['"]/);
});

test('Task 7 contract: loading view renders six safe skeleton cards without fake text', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  };

  try {
    const { renderLoading } = await import(viewPath);
    const panel = new FakeElement('div');

    renderLoading(panel);

    assert.equal(panel.getAttribute('aria-busy'), 'true');
    assert.equal(panel.hidden, false);
    assert.equal(panel.children.length, 1);
    const status = panel.children[0];
    assert.equal(status.className, 'status-loading');
    assert.equal(status.children[0].className, 'status-loading-text');
    assert.equal(status.children[0].textContent, 'Loading repositories...');
    const grid = status.children[1];
    assert.equal(grid.className, 'loading-skeleton-grid');
    assert.equal(grid.getAttribute('aria-hidden'), 'true');
    assert.equal(grid.children.length, 6);

    for (const card of grid.children) {
      assert.equal(card.tagName, 'ARTICLE');
      assert.deepEqual(card.className.split(/\s+/), [
        'repository-card',
        'repository-card-skeleton',
      ]);
      assert.deepEqual(card.children.map(({ className }) => className), [
        'repository-skeleton-header',
        'repository-skeleton-description',
        'repository-skeleton-meta',
      ]);
      const descendants = [card];
      for (let index = 0; index < descendants.length; index += 1) {
        descendants.push(...descendants[index].children);
      }
      assert.equal(
        descendants.every(({ textContent: value }) => value === ''),
        true,
        'aria-hidden skeletons must not contain fake readable text',
      );
      for (const hook of [
        'repository-skeleton-avatar',
        'repository-skeleton-owner',
        'repository-skeleton-title',
        'repository-skeleton-line',
        'repository-skeleton-meta-item',
      ]) {
        assert.ok(descendants.some(({ className }) => className === hook), `missing .${hook}`);
      }
    }
  } finally {
    globalThis.document = originalDocument;
  }
});

test('empty view distinguishes an empty public collection from filtered results', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  };

  try {
    const { renderEmpty } = await import(viewPath);
    const panel = new FakeElement('div');

    renderEmpty(panel);
    assert.equal(panel.children[0].children[0].textContent, 'No repositories match your filters.');
    assert.equal(panel.children[0].children[1].textContent, 'Clear filters');
    assert.equal(panel.children[0].children[1].getAttribute('data-action'), 'clear-filters');

    renderEmpty(panel, { collectionEmpty: true });
    assert.equal(panel.children[0].children[0].textContent, 'No public repositories are available.');
    assert.equal(panel.children[0].children.length, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('safe DOM view builds trusted structure without HTML string sinks', async () => {
  const source = await readFile(viewPath, 'utf8');

  for (const unsafePattern of [
    /\.innerHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\beval\s*\(/,
    /\bdocument\.write\s*\(/,
    /\bhref\s*=\s*`[^`]*\$\{/,
    /setAttribute\(\s*['"]href['"]\s*,\s*`[^`]*\$\{(?!encodeURIComponent\(topic\))/,
  ]) {
    assert.doesNotMatch(source, unsafePattern);
  }

  assert.match(source, /\.textContent\s*=/);
  assert.match(source, /document\.createElement\(/);
  assert.match(source, /document\.createDocumentFragment\(/);
  assert.match(source, /\.replaceChildren\(/);
  assert.match(
    source,
    /https:\/\/github\.com\/topics\/\$\{encodeURIComponent\(topic\)\}/,
  );
  assert.match(source, /setAttribute\(\s*['"]target['"]\s*,\s*['"]_blank['"]\s*\)/);
  assert.match(
    source,
    /setAttribute\(\s*['"]rel['"]\s*,\s*['"]noopener noreferrer['"]\s*\)/,
  );
  assert.match(source, /setAttribute\(\s*['"]loading['"]\s*,\s*['"]lazy['"]\s*\)/);
  assert.match(source, /setAttribute\(\s*['"]decoding['"]\s*,\s*['"]async['"]\s*\)/);
  assert.match(source, /setAttribute\(\s*['"]width['"]\s*,\s*['"]40['"]\s*\)/);
  assert.match(source, /setAttribute\(\s*['"]height['"]\s*,\s*['"]40['"]\s*\)/);
  assert.match(source, /setAttribute\(\s*['"]data-action['"]\s*,\s*['"]filter-language['"]\s*\)/);
  assert.match(source, /setAttribute\(\s*['"]data-action['"]\s*,\s*['"]retry['"]\s*\)/);
  assert.match(source, /setAttribute\(\s*['"]data-action['"]\s*,\s*['"]clear-filters['"]\s*\)/);
  assert.match(source, /\.slice\(0,\s*3\)/);
});
