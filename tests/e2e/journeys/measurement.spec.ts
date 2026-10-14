import { fileURLToPath } from "node:url";
import { expect, FileChooser, Locator, Page, test } from "@playwright/test";
import { fixture, openSongFile } from "./song-file";

// Separating and running the test aligner on one WebAssembly thread takes a while.
const RUN_TIMEOUT = 180_000;

test.setTimeout(RUN_TIMEOUT + 30_000);

// Chromium runs every journey here with its GPU turned off, so WebGPU gives
// no adapter, even on a machine with a GPU. The flag reaches the Web Workers,
// where the models run, because they share the browser's GPU process. This
// Chromium keeps navigator.gpu with any flag.
test.use({ launchOptions: { args: ["--disable-gpu"] } });

// Whether WebGPU gives the page an adapter.
const adapterFound = (page: Page) =>
  page.evaluate(async () => {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } })
      .gpu;
    return (await gpu?.requestAdapter()) != null;
  });

// The 2 s tone, which scripts/e2e.sh makes with tests/fixtures/source/make.sh,
// with the fixture song's lyrics.
const source = fileURLToPath(
  new URL("../../../artifacts/e2e/sources/song.webm", import.meta.url),
);
const lyrics = fileURLToPath(
  new URL("../../fixtures/song/lyrics.txt", import.meta.url),
);

// The test separator and the test aligner, on WebGPU only.
const PAGE = "/#/model-check?model=test";
// The same, on WebAssembly only.
const WASM_PAGE = "/#/model-check?model=test&backend=wasm";
const CANDIDATES = ["Test lyric-alignment"];
// The labels of the rows the measurement no longer has. The pattern is the
// same for the result's rows and for the lines of the copied text.
const REMOVED_ROWS = /^(Onset\s+error|Within 100 ms)/;

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

// Picks `files` with the button named `button`.
async function choose(
  page: Page,
  button: string,
  files: Parameters<FileChooser["setFiles"]>[0],
): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: button, exact: true }).click();
  await (await chooser).setFiles(files);
}

// Picks the source and `lyricsFile`, then starts the measurement.
async function measure(
  page: Page,
  lyricsFile: Parameters<FileChooser["setFiles"]>[0] = lyrics,
): Promise<void> {
  await choose(page, "Choose a source", source);
  await choose(page, "Choose the lyrics", lyricsFile);
  await page.getByRole("button", { name: "Measure the aligners" }).click();
}

const labelled = (scope: Page | Locator, name: string) =>
  scope.getByLabel(name, { exact: true });

test("measuring the test aligner without ?backend=wasm gives only WebGPU results, each saying WebGPU is not available, and sends nothing to another origin", async ({
  page,
}) => {
  const problems = await watch(page);
  await page.goto(PAGE);
  expect(await adapterFound(page)).toBe(false);
  const origin = new URL(page.url()).origin;
  const origins: string[] = [];
  page.on("request", (request) => origins.push(new URL(request.url()).origin));

  await measure(page);

  await expect(page.getByText("The measurement is done.")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  for (const name of CANDIDATES) {
    const onWebGpu = labelled(page, `${name} on WebGPU`);
    await expect(onWebGpu).toBeVisible();
    await expect(onWebGpu).toContainText("WebGPU is not available.");
    await expect(labelled(onWebGpu, "Backend")).toHaveCount(0);
  }
  // Nothing ran on WebAssembly, so there are no WebAssembly results, tracks
  // or Play button, and the copy button is already on.
  await expect(page.getByLabel(/ on WebAssembly$/)).toHaveCount(0);
  await expect(page.getByLabel(/^Tracks separated on /)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Play with this timing/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel(/^Test .+ on WebGPU$/)).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Copy results" }),
  ).toBeEnabled();
  // The test models came from the site's own origin too.
  expect(origins.length).toBeGreaterThan(0);
  for (const requestOrigin of origins) expect(requestOrigin).toBe(origin);
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("measuring shows each WebAssembly result's figures without the removed accuracy rows, and the copied text has none", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(WASM_PAGE);

  await measure(page);

  await expect(page.getByText("The measurement is done.")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  for (const name of CANDIDATES) {
    const result = labelled(page, `${name} on WebAssembly`);
    await expect(result).toBeVisible();
    for (const row of ["Extract audio", "Separate", "Align", "Model load"]) {
      await expect(labelled(result, row)).toHaveText(/^\d+\.\d{2} s$/);
    }
    await expect(labelled(result, "Separator")).toHaveText("Test separator");
    await expect(labelled(result, "Sum check")).toHaveCount(0);
    await expect(result.getByLabel(REMOVED_ROWS)).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Copy results" }).click();
  await expect(page.getByText("The results are copied.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // Exactly one result block: the test aligner on WebAssembly.
  expect(copied.match(/^Test .+ on WebAssembly$/gm)).toHaveLength(1);
  for (const name of CANDIDATES) {
    // The block runs from the result's name to the blank line after it.
    const start = copied.indexOf(`${name} on WebAssembly\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = copied.indexOf("\n\n", start);
    const block = copied.slice(start, end === -1 ? undefined : end);
    expect(block).not.toMatch(new RegExp(REMOVED_ROWS, "m"));
  }
  expect(copied).not.toMatch(new RegExp(REMOVED_ROWS, "m"));
});

test("a separator file with one byte changed is named as failed, deleted and not used, and the run stops", async ({
  page,
}) => {
  await page.route("**/test-models/mel-roformer.onnx", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    body[10] ^= 0x01;
    await route.fulfill({ response, body });
  });
  await page.goto(WASM_PAGE);

  await measure(page);

  await expect(
    page.getByText(
      "The model file test-mel-roformer failed its check. It was deleted and not used.",
    ),
  ).toBeVisible({ timeout: RUN_TIMEOUT });
  await expect(page.getByLabel(/ on WebAssembly$/)).toHaveCount(0);
  const kept = await page.evaluate(async () => {
    try {
      const models = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("models");
      await models.getFileHandle("test-mel-roformer");
      return "found";
    } catch (error) {
      return (error as DOMException).name;
    }
  });
  expect(kept).toBe("NotFoundError");
});

test("the measurement section has no timing file button, and Measure the aligners stays off until a source and the lyrics are picked", async ({
  page,
}) => {
  await page.goto(WASM_PAGE);
  await expect(
    page.getByRole("button", { name: "Choose a timing file" }),
  ).toHaveCount(0);
  const button = page.getByRole("button", { name: "Measure the aligners" });

  await expect(button).toBeDisabled();
  await choose(page, "Choose a source", source);
  await expect(button).toBeDisabled();
  await choose(page, "Choose the lyrics", lyrics);
  await expect(button).toBeEnabled();
});

test("the Device section names the browser and the OS, and says WebGPU is not available when the page has no GPU object", async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as { gpu?: unknown }).gpu;
  });
  await page.goto(WASM_PAGE);

  const device = labelled(page, "Device");
  await expect(device).toBeVisible();
  await expect(labelled(device, "Browser")).toContainText(
    browser.version().split(".")[0]!,
  );
  await expect(labelled(device, "Operating system")).not.toHaveText(
    "not reported",
  );
  await expect(labelled(device, "Operating system")).not.toHaveText("");
  await expect(labelled(device, "WebGPU")).toHaveText("Not available");
});

test("the Device section shows the GPU adapter's vendor and architecture, and says WebGPU is available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", {
      configurable: true,
      get: () => ({
        requestAdapter: async () => ({
          info: {
            vendor: "test-vendor",
            architecture: "test-architecture",
            device: "",
            description: "",
          },
        }),
      }),
    });
  });
  await page.goto(WASM_PAGE);

  const device = labelled(page, "Device");
  await expect(labelled(device, "GPU vendor")).toHaveText("test-vendor");
  await expect(labelled(device, "GPU architecture")).toHaveText(
    "test-architecture",
  );
  await expect(labelled(device, "GPU description")).toHaveText("not reported");
  await expect(labelled(device, "WebGPU")).toHaveText("Available");
});

test("each stage of a WebAssembly run shows the WebAssembly memory it used, and the JavaScript heap when the browser gives it", async ({
  page,
}) => {
  await page.goto(WASM_PAGE);

  await measure(page);

  await expect(page.getByText("The measurement is done.")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  for (const name of CANDIDATES) {
    const result = labelled(page, `${name} on WebAssembly`);
    for (const stage of ["Extract audio", "Separate", "Align"]) {
      await expect(labelled(result, `${stage} WebAssembly memory`)).toHaveText(
        /^[1-9]\d* bytes$/,
      );
      await expect(labelled(result, `${stage} JavaScript heap`)).toHaveText(
        /^([1-9]\d* bytes|not reported)$/,
      );
    }
  }
});

test("after a WebAssembly measurement, the vocals and karaoke track players each play the separated 2 s tone from memory", async ({
  page,
}) => {
  await page.goto(WASM_PAGE);
  const origin = new URL(page.url()).origin;
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));

  await measure(page);

  await expect(page.getByText("The measurement is done.")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(labelled(page, "Tracks separated on WebAssembly")).toBeVisible();
  for (const name of ["Vocals", "Karaoke track"]) {
    const player = labelled(page, name);
    const duration = () =>
      player.evaluate((audio: HTMLAudioElement) => audio.duration);
    await expect.poll(duration, { timeout: 10_000 }).toBeGreaterThan(0);
    // The fixture tone lasts 2 s.
    expect(Math.abs((await duration()) - 2)).toBeLessThanOrEqual(0.15);
    expect(await player.getAttribute("src")).toMatch(/^blob:/);
  }
  // The players load their tracks from blob: URLs, never from another origin.
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    if (!url.startsWith("blob:")) expect(new URL(url).origin).toBe(origin);
  }
});

test("Copy results puts the Device section and every result on the clipboard as label: value lines, and says the results are copied", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(WASM_PAGE);

  await measure(page);

  await expect(page.getByText("The measurement is done.")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await page.getByRole("button", { name: "Copy results" }).click();
  await expect(page.getByText("The results are copied.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());

  const sections = ["Device", ...CANDIDATES.map((c) => `${c} on WebAssembly`)];
  for (const name of sections) {
    const section = labelled(page, name);
    const labels = await section.locator("dt").allInnerTexts();
    const values = await section.locator("dd").allInnerTexts();
    expect(labels.length).toBeGreaterThan(0);
    expect(values).toHaveLength(labels.length);
    expect(copied).toContain(name);
    labels.forEach((label, index) =>
      expect(copied).toContain(`${label}: ${values[index]}`),
    );
  }
});

test("Copy results says the browser refused when the clipboard rejects the write", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      get: () => ({
        writeText: () =>
          Promise.reject(new DOMException("denied", "NotAllowedError")),
      }),
    });
  });
  await page.goto(WASM_PAGE);

  await expect(labelled(page, "Device")).toBeVisible();
  await page.getByRole("button", { name: "Copy results" }).click();

  await expect(
    page.getByText("The browser refused to copy the results."),
  ).toBeVisible();
  await expect(page.getByText("The results are copied.")).toHaveCount(0);
});

test("the main page has no link to the model check page, and the page's code loads only when it opens", async ({
  page,
}) => {
  const scripts: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script")
      scripts.push(response.text());
  });

  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Open a song file" }),
  ).toBeVisible();
  await expect(page.locator('a[href*="model-check"]')).toHaveCount(0);
  const loaded = scripts.length;
  expect(loaded).toBeGreaterThan(0);
  for (const body of await Promise.all(scripts))
    expect(body).not.toContain("lyre-model-check");

  await page.goto("/#/model-check");
  await expect(
    page.getByRole("button", { name: "Measure the aligners" }),
  ).toBeVisible();
  const opened = await Promise.all(scripts.slice(loaded));
  expect(opened.some((body) => body.includes("lyre-model-check"))).toBe(true);
});

// The fixture's syllables, which the test aligner times on the source.
const SYLLABLES = [
  "Mưa",
  "rơi",
  "nhẹ",
  "Em",
  "về",
  "bên",
  "sông",
  "Trăng",
  "lên",
];

const songSeconds = (page: Page) =>
  page.evaluate(
    () => (document.querySelector("video") as HTMLVideoElement).currentTime,
  );

// Counts the seeks of the Player's video, so a journey can show that none happened.
async function countSeeks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector("video") as HTMLVideoElement;
    const counted = window as unknown as { lyreSeeks: number };
    counted.lyreSeeks = 0;
    video.addEventListener("seeking", () => counted.lyreSeeks++);
  });
}
const seeks = (page: Page) =>
  page.evaluate(() => (window as unknown as { lyreSeeks: number }).lyreSeeks);

// Whether any of the fixture's syllables is the current one.
async function syllableCurrent(page: Page): Promise<boolean> {
  const region = page.getByRole("region", { name: "Lyrics" });
  for (const text of SYLLABLES) {
    const syllables = region.getByText(text, { exact: true });
    for (const syllable of await syllables.all()) {
      if ((await syllable.getAttribute("aria-current")) === "true") return true;
    }
  }
  return false;
}

test("after a WebAssembly measurement, the test aligner's timing plays the source in the Player with its lyrics highlighted, the Karaoke / Original switch keeps the position, and the library gets no new song", async ({
  page,
}) => {
  await openSongFile(page, fixture);
  const library = page.getByRole("list", { name: "Library" });
  await expect(library.getByRole("listitem")).toHaveCount(1);
  await page.goto(WASM_PAGE);

  await measure(page);

  await expect(page.getByText("The measurement is done.")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  const poll = { intervals: [50], timeout: 10_000 };
  for (const name of CANDIDATES) {
    const result = `${name} on WebAssembly`;
    await page
      .getByRole("button", { name: `Play with this timing: ${result}` })
      .click();
    // The heading names the result only once its song is made.
    await expect(
      page.getByRole("heading", {
        name: `Playing with the timing of ${result}`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Song video")).toBeVisible();
    // The Player has no open button and no library list.
    await expect(
      page.getByRole("button", { name: "Open a song file" }),
    ).toHaveCount(0);
    await expect(library).toHaveCount(0);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => syllableCurrent(page), poll).toBe(true);
  }

  // The last song is still playing. It pauses after 0.3 s, then switches.
  await countSeeks(page);
  await expect.poll(() => songSeconds(page), poll).toBeGreaterThan(0.3);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  const paused = await songSeconds(page);
  const seeksBefore = await seeks(page);
  await page.getByRole("radio", { name: "Original" }).click();
  await expect(page.getByRole("radio", { name: "Original" })).toBeChecked();
  expect(await songSeconds(page)).toBe(paused);
  expect(await seeks(page)).toBe(seeksBefore);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The measured songs were never kept.
  await page.goto("/");
  await expect(library.getByRole("listitem")).toHaveCount(1);
});

test("after a measurement with invalid lyrics, each result says the alignment was refused and has no Play with this timing button", async ({
  page,
}) => {
  await page.goto(WASM_PAGE);

  await measure(page, {
    name: "lyrics.txt",
    mimeType: "text/plain",
    // Not UTF-8, so the core refuses the lyrics.
    buffer: Buffer.from([0xff, 0xfe]),
  });

  await expect(page.getByText("The measurement is done.")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  for (const name of CANDIDATES) {
    await expect(labelled(page, `${name} on WebAssembly`)).toContainText(
      "The alignment was refused.",
    );
  }
  await expect(
    page.getByRole("button", { name: /^Play with this timing/ }),
  ).toHaveCount(0);
});
