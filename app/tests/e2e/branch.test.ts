// New task on another branch: the dialog lists the project's branches, and the card shows
// the branch the agent works on. Mock agents only. Screenshots land in test-results/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
});

describe('branch choice for a new task', () => {
  it('starts an agent on an existing branch from the New task dialog', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-e2e-branch-'));
    // The demo seeds its project from this repo; give it a second branch first.
    const repo = join(dataDir, 'demo-repo');
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=demo@local', '-c', 'user.name=demo', ...args], { cwd: repo });
    git('init', '-q');
    writeFileSync(join(repo, 'README.md'), '# demo-shop\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('branch', 'release-2');

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '120', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    await page.waitForSelector('.app');
    await expect.poll(() => page.getByTestId('agent-card').count()).toBe(3);

    await page.getByRole('button', { name: 'New task' }).first().click();
    await page.getByRole('radio', { name: /Mock/ }).check();
    const base = page.getByTestId('base-branch');
    // The current branch first, then free branches, then the demo agents' own (in use).
    await expect.poll(() => base.locator('option').allInnerTexts()).toEqual([expect.stringMatching(/^Current branch \(/), 'release-2', ...Array(3).fill(expect.stringMatching(/^amw\/.* \(in use\)$/))]);
    await base.selectOption('release-2');
    await page.getByTestId('use-existing-branch').check();
    await page.getByPlaceholder('e.g. Schema migration for orders').fill('Release fixes');
    await page.screenshot({ path: join(shots, 'branch-01-new-task.png') });
    await page.getByRole('button', { name: 'Create task' }).click();

    await page.keyboard.press('Escape');
    const card = page.getByTestId('agent-card').filter({ hasText: 'Release fixes' });
    await expect.poll(() => card.innerText(), { timeout: 10_000 }).toContain('release-2');
    await page.screenshot({ path: join(shots, 'branch-02-card.png') });
  });
});
