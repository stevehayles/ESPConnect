import { test, expect, type Page } from '@playwright/test';

async function connectHappyPath(page: Page) {
  await page.goto('/?e2e=1');
  const connectButton = page.getByTestId('connect-btn');
  await expect(connectButton).toBeEnabled();
  await connectButton.click();

  const status = page.getByTestId('connection-status');
  await expect(status).toContainText('Connected');
}

async function openFlashTools(page: Page) {
  await page.getByText('Flash Tools', { exact: true }).click();
  const toolCard = page.getByTestId('tool-integrity-card');
  await expect(toolCard).toBeVisible();
  return toolCard;
}

test('Connect happy path', async ({ page }) => {
  await connectHappyPath(page);

  const summary = page.getByTestId('device-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('ESP32-S3');
  await expect(summary).toContainText('aa:bb:cc:dd:ee:ff');
});

test('Tool happy path', async ({ page }) => {
  await connectHappyPath(page);

  const toolCard = await openFlashTools(page);

  await toolCard.getByLabel('Length (bytes)', { exact: true }).fill('0x1000');
  await toolCard.getByTestId('tool-integrity-run').click();

  const toast = page.getByTestId('toast-container');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('MD5 checksum computed.');

  await expect(toolCard).toContainText('MD5 checksum:');
  await expect(toolCard).toContainText('d41d8cd98f00b204e9800998ecf8427e');
});

test('Disconnect happy path', async ({ page }) => {
  await connectHappyPath(page);

  await page.getByTestId('disconnect-btn').click();

  const status = page.getByTestId('connection-status');
  await expect(status).toContainText('Disconnected');
  await expect(page.getByTestId('connect-btn')).toBeEnabled();
  await expect(page.getByTestId('device-summary')).toHaveCount(0);
});

test('Navigation unlock', async ({ page }) => {
  await connectHappyPath(page);

  await page.getByText('Partitions', { exact: true }).click();
  await expect(page.getByText('No partition data yet')).toBeVisible();
});

test('Security facts render', async ({ page }) => {
  await connectHappyPath(page);

  const summary = page.getByTestId('device-summary');
  await expect(summary).toContainText('Flash Encryption');
  await expect(summary).toContainText('Secure Boot');
});

test('Serial monitor start/stop', async ({ page }) => {
  await connectHappyPath(page);

  await page.getByText('Serial Monitor', { exact: true }).click();

  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  await expect(startButton).toBeEnabled();
  await startButton.click();

  await expect(startButton).toBeDisabled();
  await expect(page.locator('.monitor-terminal__output')).toContainText('Mock serial');

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(startButton).toBeEnabled();
});

test('MD5 error path', async ({ page }) => {
  await connectHappyPath(page);

  const toolCard = await openFlashTools(page);
  await toolCard.getByTestId('tool-integrity-run').click();

  await expect(toolCard).toContainText('MD5 calculation failed');
});
