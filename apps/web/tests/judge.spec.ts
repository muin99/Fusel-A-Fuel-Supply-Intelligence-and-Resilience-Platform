import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const password = readFileSync('../../.env', 'utf8').split('\n').find((x) => x.startsWith('OPERATOR_PASSWORD='))?.split('=').slice(1).join('=').replace(/^['"]|['"]$/g, '') ?? 'operator';
test('operator can inspect intelligence, evaluate and compare policies', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/assistant');
  await expect(page.getByRole('heading', { name: 'Intelligence Lab', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run model evaluation' })).toBeDisabled();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByPlaceholder('password', { exact: true }).fill(password);
  await page.locator('form').filter({ has: page.getByPlaceholder('password', { exact: true }) }).getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run model evaluation' })).toBeEnabled();
  await page.getByRole('button', { name: 'Run model evaluation' }).click();
  await expect(page.getByRole('heading', { name: 'Evaluation / replay result' })).toBeVisible();
  await page.getByRole('button', { name: 'Compare policies under stress' }).click();
  await expect(page.getByText('"combined_stress"', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: '../../docs/evidence/intelligence-lab.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('operator pages render without client errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const path of ['/', '/forecast', '/recommendations', '/disruptions', '/health', '/assistant', '/audit', '/control']) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByText('Connecting…', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `../../docs/evidence/page-${path.replace('/','') || 'overview'}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
test('mobile navigation remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/assistant');
  await page.locator('header select').selectOption('/forecast');
  await expect(page).toHaveURL(/forecast$/);
  await expect(page.getByRole('heading', { name: 'Demand forecast & empirical uncertainty' })).toBeVisible();
  await page.screenshot({ path: '../../docs/evidence/mobile-forecast.png', fullPage: true });
});
