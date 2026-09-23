import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const updateDispatchGate =
  "github.event_name != 'workflow_dispatch' || github.ref_name == github.event.repository.default_branch";
const pagesGate =
  "(github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success') && (github.event_name != 'workflow_dispatch' || github.ref_name == github.event.repository.default_branch)";

async function readYaml(relativePath) {
  return parse(await readFile(path.join(projectRoot, relativePath), 'utf8'));
}

function step(job, name) {
  assert.ok(job, `missing job containing step: ${name}`);
  const match = job.steps.find((candidate) => candidate.name === name);
  assert.ok(match, `missing step: ${name}`);
  return match;
}

function collectUses(value, pathParts = [], found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUses(item, [...pathParts, index], found));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uses') {
        found.push({ path: pathParts.join('.'), uses: child });
      } else {
        collectUses(child, [...pathParts, key], found);
      }
    }
  }
  return found;
}

test('update workflow separates read-only validation from credentialed generation', async () => {
  const workflow = await readYaml('.github/workflows/main.yml');
  const { test: testJob, update } = workflow.jobs;

  assert.equal(workflow.name, 'Update awesome list');
  assert.ok(Object.hasOwn(workflow, 'on'), 'YAML 1.2 must preserve the on key');
  assert.deepEqual(workflow.on, {
    workflow_dispatch: null,
    schedule: [{ cron: '0 */6 * * *' }],
  });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: 'update-awesome-list',
    'cancel-in-progress': false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), ['test', 'update']);

  assert.equal(testJob.if, updateDispatchGate);
  assert.equal(testJob['runs-on'], 'ubuntu-latest');
  assert.equal(testJob['timeout-minutes'], 20);
  assert.deepEqual(testJob.permissions, { contents: 'read' });
  assert.deepEqual(testJob.steps.map(({ name }) => name), [
    'Checkout',
    'Set up Node.js',
    'Install dependencies',
    'Install Chromium',
    'Test generator and UI',
  ]);
  assert.deepEqual(step(testJob, 'Checkout').with, {
    'persist-credentials': false,
  });
  assert.deepEqual(step(testJob, 'Set up Node.js').with, {
    'node-version': '22',
    cache: 'npm',
  });
  assert.equal(step(testJob, 'Install dependencies').run, 'npm ci');
  assert.equal(
    step(testJob, 'Install Chromium').run,
    'npx playwright install --with-deps chromium',
  );
  assert.equal(step(testJob, 'Test generator and UI').run, 'npm run test:all');

  assert.equal(update.if, updateDispatchGate);
  assert.equal(update.needs, 'test');
  assert.equal(update['runs-on'], 'ubuntu-latest');
  assert.equal(update['timeout-minutes'], 15);
  assert.deepEqual(update.permissions, { contents: 'write' });
  assert.deepEqual(update.steps.map(({ name }) => name), [
    'Checkout',
    'Set up Node.js',
    'Generate awesome list',
    'Commit generated files',
  ]);
  assert.deepEqual(step(update, 'Checkout').with, undefined);
  assert.deepEqual(step(update, 'Set up Node.js').with, {
    'node-version': '22',
  });

  const generate = step(update, 'Generate awesome list');
  assert.equal(generate.run, 'node scripts/update-awesome-list.mjs');
  assert.deepEqual(generate.env, { API_TOKEN: '${{ secrets.API_TOKEN }}' });
  assert.equal(workflow.env, undefined);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.env, undefined);
    for (const candidate of job.steps) {
      if (candidate !== generate) assert.equal(candidate.env, undefined);
    }
  }

  const updateCommands = update.steps.flatMap(({ run }) => (run ? [run] : []));
  assert.doesNotMatch(
    updateCommands.join('\n'),
    /npm (?:ci|install)|playwright|npm (?:run )?test/,
  );
});

test('update workflow preserves exact generated commit and push behavior', async () => {
  const workflow = await readYaml('.github/workflows/main.yml');
  const commit = step(workflow.jobs.update, 'Commit generated files');

  assert.equal(
    commit.run,
    `git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add data.json data.md

if git diff --cached --quiet; then
  echo "No starred repository changes to commit."
  exit 0
fi

git commit -m "chore(updates): update starred repositories"
git push
`,
  );
});

test('Pages workflow gates tests and deployment and applies least privilege', async () => {
  const workflow = await readYaml('.github/workflows/static.yml');
  const { test: testJob, deploy } = workflow.jobs;

  assert.equal(workflow.name, 'Deploy static content to Pages');
  assert.ok(Object.hasOwn(workflow, 'on'), 'YAML 1.2 must preserve the on key');
  assert.deepEqual(workflow.on, {
    workflow_run: {
      workflows: ['Update awesome list'],
      types: ['completed'],
      branches: ['main'],
    },
    push: { branches: ['main'] },
    workflow_dispatch: null,
  });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: 'pages',
    'cancel-in-progress': false,
  });

  assert.equal(testJob.if, pagesGate);
  assert.equal(testJob['runs-on'], 'ubuntu-latest');
  assert.equal(testJob['timeout-minutes'], 20);
  assert.deepEqual(testJob.permissions, { contents: 'read' });
  assert.deepEqual(testJob.steps.map(({ name }) => name), [
    'Checkout',
    'Set up Node.js',
    'Install dependencies',
    'Install Chromium',
    'Test generator and UI',
  ]);
  assert.deepEqual(step(testJob, 'Checkout').with, {
    'persist-credentials': false,
  });
  assert.deepEqual(step(testJob, 'Set up Node.js').with, {
    'node-version': '22',
    cache: 'npm',
  });
  assert.equal(step(testJob, 'Install dependencies').run, 'npm ci');
  assert.equal(
    step(testJob, 'Install Chromium').run,
    'npx playwright install --with-deps chromium',
  );
  assert.equal(step(testJob, 'Test generator and UI').run, 'npm run test:all');

  assert.equal(deploy.if, pagesGate);
  assert.equal(deploy.needs, 'test');
  assert.equal(deploy['runs-on'], 'ubuntu-latest');
  assert.equal(deploy['timeout-minutes'], 15);
  assert.deepEqual(deploy.permissions, {
    contents: 'read',
    pages: 'write',
    'id-token': 'write',
  });
  assert.deepEqual(deploy.environment, {
    name: 'github-pages',
    url: '${{ steps.deployment.outputs.page_url }}',
  });
  assert.deepEqual(deploy.steps.map(({ name }) => name), [
    'Checkout',
    'Setup Pages',
    'Upload artifact',
    'Deploy to GitHub Pages',
  ]);
  assert.deepEqual(step(deploy, 'Checkout').with, {
    'persist-credentials': false,
  });
  assert.deepEqual(step(deploy, 'Upload artifact').with, { path: '.' });
  assert.equal(step(deploy, 'Deploy to GitHub Pages').id, 'deployment');
});

test('workflows use only the approved official action majors at exact locations', async () => {
  const [update, pages] = await Promise.all([
    readYaml('.github/workflows/main.yml'),
    readYaml('.github/workflows/static.yml'),
  ]);
  const actual = [
    ...collectUses(update).map((entry) => ({ workflow: 'main', ...entry })),
    ...collectUses(pages).map((entry) => ({ workflow: 'static', ...entry })),
  ];

  assert.deepEqual(actual, [
    { workflow: 'main', path: 'jobs.test.steps.0', uses: 'actions/checkout@v4' },
    { workflow: 'main', path: 'jobs.test.steps.1', uses: 'actions/setup-node@v4' },
    { workflow: 'main', path: 'jobs.update.steps.0', uses: 'actions/checkout@v4' },
    { workflow: 'main', path: 'jobs.update.steps.1', uses: 'actions/setup-node@v4' },
    { workflow: 'static', path: 'jobs.test.steps.0', uses: 'actions/checkout@v4' },
    { workflow: 'static', path: 'jobs.test.steps.1', uses: 'actions/setup-node@v4' },
    { workflow: 'static', path: 'jobs.deploy.steps.0', uses: 'actions/checkout@v4' },
    { workflow: 'static', path: 'jobs.deploy.steps.1', uses: 'actions/configure-pages@v5' },
    { workflow: 'static', path: 'jobs.deploy.steps.2', uses: 'actions/upload-pages-artifact@v3' },
    { workflow: 'static', path: 'jobs.deploy.steps.3', uses: 'actions/deploy-pages@v4' },
  ]);
});

test('Dependabot exactly schedules bounded weekly npm and action updates', async () => {
  const dependabot = await readYaml('.github/dependabot.yml');

  assert.deepEqual(dependabot, {
    version: 2,
    updates: [
      {
        'package-ecosystem': 'npm',
        directory: '/',
        schedule: { interval: 'weekly' },
        'open-pull-requests-limit': 5,
      },
      {
        'package-ecosystem': 'github-actions',
        directory: '/',
        schedule: { interval: 'weekly' },
        'open-pull-requests-limit': 5,
      },
    ],
  });
});
