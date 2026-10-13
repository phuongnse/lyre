import { fileURLToPath } from "node:url";
import { expect, Page, test } from "@playwright/test";

// Loading ONNX Runtime's WebAssembly and running one window on one thread takes a while.
const RUN_TIMEOUT = 120_000;

test.setTimeout(RUN_TIMEOUT + 30_000);

// scripts/e2e.sh makes these with tests/fixtures/source/make.sh before the journeys run.
const source = (name: string) =>
  fileURLToPath(
    new URL(`../../../artifacts/e2e/sources/${name}`, import.meta.url),
  );

// The 2 s tone, separated by the test separator on WebAssembly.
const PAGE = "/#/separation-check?model=test&backend=wasm";
const TONE = "song.webm";

// Records every Content Security Policy or Trusted Types violation, console
// error and page error, from before the page loads.
async function watch(page: Page): Promise<string[]> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { violations });
    addEventListener("securitypolicyviolation", (event) =>
      violations.push(event.violatedDirective),
    );
  });
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

const violations = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { violations: string[] }).violations,
  );

// Picks `file` with the page's button.
async function chooseSource(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose a source" }).click();
  await (await chooser).setFiles(source(file));
}

const labelled = (page: Page, name: string) =>
  page.getByLabel(name, { exact: true });

// The number of seconds in a row such as "2.00 s".
async function secondsIn(page: Page, name: string): Promise<number> {
  const text = (await labelled(page, name).textContent()) ?? "";
  expect(text.trim()).toMatch(/^\d+\.\d{2} s$/);
  return parseFloat(text);
}

test("the test separator splits the tone into vocals and a karaoke track as long as the source, on WebAssembly, window by window", async ({
  page,
}) => {
  const problems = await watch(page);
  await page.goto(PAGE);

  await chooseSource(page, TONE);

  await expect(labelled(page, "Separated audio")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  const sourceSeconds = await secondsIn(page, "Source length");
  expect(Math.abs(sourceSeconds - 2)).toBeLessThanOrEqual(0.15);
  expect(await secondsIn(page, "Vocals length")).toBe(sourceSeconds);
  expect(await secondsIn(page, "Karaoke track length")).toBe(sourceSeconds);
  await expect(labelled(page, "Backend")).toHaveText("WebAssembly");
  // The core cuts a 2 s source into one window.
  await expect(page.getByRole("status")).toContainText("1 of 1 windows done");
  await expect(
    page.getByRole("progressbar", { name: "Separation progress" }),
  ).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("the page stays responsive from picking the source until the separation shows", async ({
  page,
}) => {
  const problems = await watch(page);
  await page.goto(PAGE);

  // The loop starts before the pick, so it covers the whole run. It measures
  // how late a 0 ms timer fires every 20 ms, until the result shows.
  const measuring = page.evaluate(async (limit) => {
    const lags: number[] = [];
    const end = performance.now() + limit;
    let finished = false;
    while (performance.now() < end) {
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 0));
      lags.push(performance.now() - start);
      if (document.querySelector('dl[aria-label="Separated audio"]') !== null) {
        finished = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { lags, finished };
  }, RUN_TIMEOUT);
  await chooseSource(page, TONE);
  const { lags, finished } = await measuring;

  expect(finished).toBe(true);
  expect(lags.length).toBeGreaterThan(0);
  for (const lag of lags) expect(lag).toBeLessThan(50);
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});
