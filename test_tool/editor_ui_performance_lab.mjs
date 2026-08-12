import { _electron as electron } from "playwright";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const projectRoot = process.cwd();
const cliOptions = new Map(process.argv.slice(2).flatMap((argument) => {
  if (!argument.startsWith("--") || !argument.includes("=")) return [];
  const separator = argument.indexOf("=");
  return [[argument.slice(2, separator), argument.slice(separator + 1)]];
}));
const shapes = (cliOptions.get("shapes") ?? process.env.EDITOR_UI_SHAPES ?? "24,120,420")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const virtualInputReliabilityRepeats = Math.max(
  1,
  Number.parseInt(cliOptions.get("input-repeats") ?? process.env.EDITOR_UI_VIRTUAL_INPUT_REPEATS ?? "1", 10) || 1
);
const requestedFixtureProfile = cliOptions.get("fixture-profile") ?? process.env.EDITOR_UI_FIXTURE_PROFILE;
const fixtureProfile = requestedFixtureProfile === "mixed-media"
  ? "mixed-media"
  : requestedFixtureProfile === "heterogeneous"
    ? "heterogeneous"
    : "uniform";
const runCorrectnessGates = (cliOptions.get("correctness-gates") ?? process.env.EDITOR_UI_CORRECTNESS_GATES) === "1";
const runPipelineProbes = (cliOptions.get("pipeline-probes") ?? process.env.EDITOR_UI_PIPELINE_PROBES) === "1";
const experiment = cliOptions.get("experiment") ?? process.env.EDITOR_UI_EXPERIMENT ?? "full";
const sourceOverscan = Math.max(
  1,
  Math.min(16, Number.parseInt(cliOptions.get("source-overscan") ?? process.env.EDITOR_UI_SOURCE_OVERSCAN ?? "8", 10) || 8)
);
const sourceScrollShell = (cliOptions.get("source-scroll-shell") ?? process.env.EDITOR_UI_SOURCE_SCROLL_SHELL) === "1";
const layoutAnchor = (cliOptions.get("layout-anchor") ?? process.env.EDITOR_UI_LAYOUT_ANCHOR) === "1";
const productDefaults = (cliOptions.get("product-defaults") ?? process.env.EDITOR_UI_PRODUCT_DEFAULTS) === "1";
const outputPath = path.resolve(
  projectRoot,
  cliOptions.get("output") ?? process.env.EDITOR_UI_OUTPUT ?? path.join("output", "performance", "editor-ui-baseline.json")
);
const results = [];

for (const blockCount of shapes) {
  process.stdout.write(`[editor ui lab] measuring ${blockCount} blocks\n`);
  results.push(await measureShape(blockCount));
}

const correctnessGateFailures = runCorrectnessGates ? collectCorrectnessGateFailures(results) : [];

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    node: process.version,
    electronEntry: "apps/windows/electron-dist/main.cjs"
  },
  method: {
    scrollFrames: 180,
    experiment,
    variants: experiment === "interaction" ? [
      "manual-window-drag-burst",
      "actual-window-drag-burst",
      "task-center-closed-burst",
      "task-center-open-burst"
    ] : experiment === "recognition-stream" ? [
      "recognition-preview-away-burst",
      "recognition-preview-bottom-burst"
    ] : experiment === "render-commit" ? [
      "tanstack-both-block-projection",
      "render-commit-probe"
    ] : [
      "current",
      "finite-view-upper-bound",
      "dynamic-visible-window",
      "virtual-block-window",
      "virtual-both-windows",
      "virtual-both-measured",
      "virtual-source-tanstack-preview",
      "tanstack-source-tanstack-preview",
      "tanstack-both-block-projection",
      "render-commit-probe"
    ],
    activeEditorViewLimit: 12,
    dynamicOverscanPx: 1200,
    sourceOverscan: productDefaults ? "product-default" : sourceOverscan,
    sourceScrollShell: productDefaults ? "product-default" : sourceScrollShell,
    productDefaults,
    fixtureProfile,
    virtualInputReliabilityRepeats,
    correctnessGates: {
      enabled: runCorrectnessGates,
      status: runCorrectnessGates ? (correctnessGateFailures.length === 0 ? "passed" : "failed") : "deferred",
      failureCount: correctnessGateFailures.length,
      failures: correctnessGateFailures
    },
    pipelineProbes: {
      enabled: runPipelineProbes,
      status: runPipelineProbes ? "enabled" : "deferred",
      stages: ["source-commit", "source-two-frame-paint", "preview-commit", "preview-two-frame-paint", "long-task"]
    },
    note: "Synthetic notes root only. All prototypes are disabled in normal product runs. The virtual source variant estimates the complete scroll range, switches a three-segment static shell only at 12-block boundaries, then hydrates the precise visible range from cached EditorState in two-editor animation-frame chunks after scrolling settles. The combined measured variant calibrates preview block heights with one ResizeObserver, batches measurements per animation frame, and compensates scrollTop when heights above the visible anchor change."
  },
  results
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`EDITOR_UI_PERFORMANCE_LAB_OK ${outputPath}\n`);
if (correctnessGateFailures.length > 0) {
  process.exitCode = 1;
}

async function measureShape(blockCount) {
  const notesRoot = await mkdtemp(path.join(tmpdir(), `mathnotes-editor-ui-${blockCount}-`));
  const userDataDir = path.join(notesRoot, "user-data");
  let app;
  try {
    await writeSessionFixture(notesRoot, blockCount, fixtureProfile);
    const launchStartedAt = performance.now();
    app = await electron.launch({
      args: [
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        path.join(projectRoot, "apps/windows/electron-dist/main.cjs"),
        `--user-data-dir=${userDataDir}`
      ],
      cwd: projectRoot,
      env: {
        ...process.env,
        MATHNOTES_ROOT: notesRoot,
        MATHNOTES_DEV_SERVER: "http://127.0.0.1:9"
      }
    });
    const page = await app.firstWindow();
    process.stdout.write(`[editor ui lab] ${blockCount}: window opened\n`);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.show();
      window?.focus();
    });
    await page.bringToFront();
    await page.waitForSelector("[data-testid='session-source-editor'] .cm-editor", { timeout: 90000 });
    if (experiment === "interaction") {
      return await measureInteractionExperiment({
        app,
        blockCount,
        launchStartedAt,
        page
      });
    }
    if (experiment === "recognition-stream") {
      return await measureRecognitionPreviewStreamExperiment({
        app,
        blockCount,
        launchStartedAt,
        notesRoot,
        page
      });
    }
    if (experiment === "render-commit") {
      return await measureRenderCommitExperiment({
        app,
        blockCount,
        launchStartedAt,
        notesRoot,
        page
      });
    }
    await page.waitForFunction(
      (expected) => document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length === expected,
      blockCount,
      { timeout: 90000 }
    );
    process.stdout.write(`[editor ui lab] ${blockCount}: all editors mounted\n`);
    await waitForIdleFrames(page, 8);
    const launchToEditorsReadyMs = performance.now() - launchStartedAt;
    await waitForPreviewReady(page, blockCount);
    await waitForIdleFrames(page, 8);
    process.stdout.write(`[editor ui lab] ${blockCount}: initial frames settled\n`);

    const launchToPreviewReadyMs = performance.now() - launchStartedAt;
    const currentDom = await collectDomStats(page);
    const currentScroll = await collectVariant(page, "current");
    process.stdout.write(`[editor ui lab] ${blockCount}: current scroll measured\n`);
    const currentInputLatency = await measureInputToPreview(page, `${blockCount}-current`);
    process.stdout.write(`[editor ui lab] ${blockCount}: input latency measured\n`);

    await page.evaluate(() => localStorage.setItem("mathnotes:editor-windowing-lab", "finite"));
    const prototypeStartedAt = performance.now();
    await page.reload();
    await page.bringToFront();
    await page.waitForFunction(
      ({ expectedEditors, expectedStaticSources, expectedBlocks }) =>
        document.querySelectorAll("[data-testid='source-block']").length === expectedBlocks &&
        document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length === expectedEditors &&
        document.querySelectorAll("[data-testid='performance-static-source']").length === expectedStaticSources,
      {
        expectedEditors: Math.min(blockCount, 12),
        expectedStaticSources: Math.max(0, blockCount - 12),
        expectedBlocks: blockCount
      },
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 8);
    const finiteViewSourceReadyMs = performance.now() - prototypeStartedAt;
    const finiteViewSourceReadyDom = await collectDomStats(page);
    await waitForPreviewReady(page, blockCount);
    await waitForIdleFrames(page, 8);
    const finiteViewReloadToReadyMs = performance.now() - prototypeStartedAt;
    const finiteViewDom = await collectDomStats(page);
    const finiteViewScroll = await collectVariant(page, "finite-view-upper-bound");
    const finiteViewInputLatency = await measureInputToPreview(page, `${blockCount}-finite`);
    process.stdout.write(`[editor ui lab] ${blockCount}: finite-view upper bound measured\n`);

    await page.evaluate(() => localStorage.setItem("mathnotes:editor-windowing-lab", "dynamic"));
    const dynamicStartedAt = performance.now();
    await page.reload();
    await page.bringToFront();
    await page.waitForFunction(
      (expectedBlocks) => {
        const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
        const staticCount = document.querySelectorAll("[data-testid='performance-static-source']").length;
        return document.querySelectorAll("[data-testid='source-block']").length === expectedBlocks &&
          editorCount > 0 && editorCount < expectedBlocks && staticCount > 0;
      },
      blockCount,
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 8);
    const dynamicSourceReadyMs = performance.now() - dynamicStartedAt;
    const dynamicSourceReadyDom = await collectDomStats(page);
    await waitForPreviewReady(page, blockCount);
    await waitForIdleFrames(page, 8);
    const dynamicReloadToReadyMs = performance.now() - dynamicStartedAt;
    const dynamicDom = await collectDomStats(page);
    const dynamicScroll = await collectVariant(page, "dynamic-visible-window");
    const dynamicInputLatency = await measureInputToPreview(page, `${blockCount}-dynamic`);
    const dynamicStateRetention = await measureEditorStateRetention(page, blockCount);
    process.stdout.write(`[editor ui lab] ${blockCount}: dynamic visible window measured\n`);

    await page.evaluate(() => localStorage.setItem("mathnotes:editor-windowing-lab", "virtual"));
    const virtualStartedAt = performance.now();
    await page.reload();
    await page.bringToFront();
    await page.waitForFunction(
      (expectedBlocks) => {
        const renderedBlocks = document.querySelectorAll("[data-testid='source-block']").length;
        const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
        return renderedBlocks > 0 && renderedBlocks < expectedBlocks && editorCount > 0 && editorCount <= renderedBlocks;
      },
      blockCount,
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 8);
    const virtualSourceReadyMs = performance.now() - virtualStartedAt;
    const virtualSourceReadyDom = await collectDomStats(page);
    await waitForPreviewReady(page, blockCount);
    await waitForIdleFrames(page, 8);
    const virtualReloadToReadyMs = performance.now() - virtualStartedAt;
    const virtualDom = await collectDomStats(page);
    const virtualScroll = await collectVariant(page, "virtual-block-window");
    const virtualInputLatency = await measureInputToPreview(page, `${blockCount}-virtual`);
    const virtualStateRetention = await measureEditorStateRetention(page, blockCount);
    process.stdout.write(`[editor ui lab] ${blockCount}: virtual block window measured\n`);

    await page.evaluate(() => localStorage.setItem("mathnotes:preview-windowing-lab", "virtual"));
    const combinedStartedAt = performance.now();
    await page.reload();
    await page.bringToFront();
    await page.waitForFunction(
      (expectedBlocks) => {
        const renderedSourceBlocks = document.querySelectorAll("[data-testid='source-block']").length;
        const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
        const renderedPreviewBlocks = document.querySelectorAll("[data-testid='render-block']").length;
        const previewWindowingEnabled = document.querySelector(".preview-scroll")?.getAttribute("data-preview-windowing-lab") === "virtual";
        return renderedSourceBlocks > 0 && renderedSourceBlocks <= expectedBlocks &&
          editorCount > 0 && editorCount <= Math.min(expectedBlocks, 12) &&
          renderedPreviewBlocks > 0 && renderedPreviewBlocks <= expectedBlocks && previewWindowingEnabled;
      },
      blockCount,
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 8);
    const combinedReloadToReadyMs = performance.now() - combinedStartedAt;
    const combinedDom = await collectDomStats(page);
    const combinedSourceScroll = await collectVariant(page, "virtual-both-windows-source");
    const combinedPreviewScroll = await collectVariant(page, "virtual-both-windows-preview", ".preview-scroll");
    const combinedInputReliability = [];
    for (let repeat = 0; repeat < virtualInputReliabilityRepeats; repeat += 1) {
      if (repeat > 0) await moveVirtualWindowsToEnd(page);
      await resetVirtualWindowsToStart(page);
      combinedInputReliability.push(await measureInputToPreview(page, `${blockCount}-virtual-both-${repeat + 1}`));
    }
    const combinedInputLatency = combinedInputReliability[0];
    const combinedStateRetention = await measureEditorStateRetention(page, blockCount);
    process.stdout.write(`[editor ui lab] ${blockCount}: virtual source and preview windows measured\n`);

    await page.evaluate(() => localStorage.setItem("mathnotes:preview-windowing-lab", "virtual-measured"));
    const measuredCombinedStartedAt = performance.now();
    await page.reload();
    await page.bringToFront();
    await page.waitForFunction(
      (expectedBlocks) => {
        const renderedSourceBlocks = document.querySelectorAll("[data-testid='source-block']").length;
        const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
        const renderedPreviewBlocks = document.querySelectorAll("[data-testid='render-block']").length;
        const previewMode = document.querySelector(".preview-scroll")?.getAttribute("data-preview-windowing-lab");
        return renderedSourceBlocks > 0 && renderedSourceBlocks <= expectedBlocks &&
          editorCount > 0 && editorCount <= Math.min(expectedBlocks, 12) &&
          renderedPreviewBlocks > 0 && renderedPreviewBlocks <= expectedBlocks && previewMode === "virtual-measured";
      },
      blockCount,
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 8);
    const measuredCombinedReloadToReadyMs = performance.now() - measuredCombinedStartedAt;
    const measuredCombinedInitialDom = await collectDomStats(page);
    const measuredCombinedPreviewScroll = await collectVariant(page, "virtual-both-measured-preview", ".preview-scroll");
    const measuredCombinedCalibration = await collectPreviewCalibrationStats(page);
    const measuredCombinedResizeAnchor = await measurePreviewResizeAnchor(page);
    const measuredCombinedCorrectness = runCorrectnessGates
      ? await runCorrectnessGateSuite({
          app,
          blockCount,
          label: "virtual-both-measured",
          notesRoot,
          page
        })
      : deferredCorrectnessGateSuite();
    await resetVirtualWindowsToStart(page);
    const measuredCombinedInputLatency = await measureInputToPreview(page, `${blockCount}-virtual-both-measured`);
    const measuredCombinedPipeline = runPipelineProbes
      ? await measureInputPipelineSegments(page, `${blockCount}-virtual-both-measured`)
      : deferredPipelineProbe();
    process.stdout.write(`[editor ui lab] ${blockCount}: measured preview calibration recorded\n`);

    await page.evaluate(() => localStorage.setItem("mathnotes:preview-windowing-lab", "tanstack-measured"));
    const tanStackStartedAt = performance.now();
    await page.reload();
    await page.bringToFront();
    await page.waitForFunction(
      (expectedBlocks) => {
        const renderedSourceBlocks = document.querySelectorAll("[data-testid='source-block']").length;
        const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
        const renderedPreviewBlocks = document.querySelectorAll("[data-testid='render-block']").length;
        const previewMode = document.querySelector(".preview-scroll")?.getAttribute("data-preview-windowing-lab");
        return renderedSourceBlocks > 0 && renderedSourceBlocks <= expectedBlocks &&
          editorCount > 0 && editorCount <= Math.min(expectedBlocks, 12) &&
          renderedPreviewBlocks > 0 && renderedPreviewBlocks <= expectedBlocks && previewMode === "tanstack-measured";
      },
      blockCount,
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 8);
    const tanStackReloadToReadyMs = performance.now() - tanStackStartedAt;
    const tanStackInitialDom = await collectDomStats(page);
    const tanStackPreviewScroll = await collectVariant(page, "virtual-source-tanstack-preview", ".preview-scroll");
    const tanStackCalibration = await collectPreviewCalibrationStats(page);
    const tanStackResizeAnchor = await measurePreviewResizeAnchor(page);
    const tanStackCorrectness = runCorrectnessGates
      ? await runCorrectnessGateSuite({
          app,
          blockCount,
          label: "virtual-source-tanstack-preview",
          notesRoot,
          page
        })
      : deferredCorrectnessGateSuite();
    await resetVirtualWindowsToStart(page);
    const tanStackInputLatency = await measureInputToPreview(page, `${blockCount}-virtual-source-tanstack-preview`);
    const tanStackPipeline = runPipelineProbes
      ? await measureInputPipelineSegments(page, `${blockCount}-virtual-source-tanstack-preview`)
      : deferredPipelineProbe();
    process.stdout.write(`[editor ui lab] ${blockCount}: TanStack preview comparison prepared\n`);

    await page.evaluate(() => localStorage.setItem("mathnotes:editor-windowing-lab", "tanstack-virtual"));
    const tanStackBothStartedAt = performance.now();
    await page.reload();
    await page.bringToFront();
    await page.waitForFunction(
      (expectedBlocks) => {
        const source = document.querySelector("[data-testid='session-source-editor']");
        const renderedSourceBlocks = document.querySelectorAll("[data-testid='source-block']").length;
        const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
        const renderedPreviewBlocks = document.querySelectorAll("[data-testid='render-block']").length;
        const previewMode = document.querySelector(".preview-scroll")?.getAttribute("data-preview-windowing-lab");
        return source?.getAttribute("data-editor-windowing-lab") === "tanstack-virtual" &&
          renderedSourceBlocks > 0 && renderedSourceBlocks <= expectedBlocks &&
          editorCount === renderedSourceBlocks &&
          renderedPreviewBlocks > 0 && renderedPreviewBlocks <= expectedBlocks &&
          previewMode === "tanstack-measured";
      },
      blockCount,
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 8);
    const tanStackBothReloadToReadyMs = performance.now() - tanStackBothStartedAt;
    const tanStackBothInitialDom = await collectDomStats(page);
    const tanStackBothSourceStats = await collectSourceTanStackStats(page);
    const tanStackBothSourceScroll = await collectVariant(page, "tanstack-source-tanstack-preview-source");
    const tanStackBothPreviewScroll = await collectVariant(page, "tanstack-source-tanstack-preview-preview", ".preview-scroll");
    const tanStackBothCorrectness = runCorrectnessGates
      ? await runCorrectnessGateSuite({
          app,
          blockCount,
          label: "tanstack-source-tanstack-preview",
          notesRoot,
          page
        })
      : deferredCorrectnessGateSuite();
    await resetVirtualWindowsToStart(page);
    const tanStackBothInputLatency = await measureInputToPreview(page, `${blockCount}-tanstack-source-tanstack-preview`);
    const tanStackBothPipeline = runPipelineProbes
      ? await measureInputPipelineSegments(page, `${blockCount}-tanstack-source-tanstack-preview`)
      : deferredPipelineProbe();
    process.stdout.write(`[editor ui lab] ${blockCount}: TanStack source and preview comparison prepared\n`);

    await page.evaluate(() => {
      localStorage.setItem("mathnotes:preview-projection-lab", "block-map");
      localStorage.setItem("mathnotes:render-commit-lab", "on");
    });
    const blockProjectionStartedAt = performance.now();
    await page.reload();
    await page.bringToFront();
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.getAttribute("data-preview-projection-lab") === "block-map",
      undefined,
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 8);
    const blockProjectionReloadToReadyMs = performance.now() - blockProjectionStartedAt;
    const blockProjectionInitialStats = await collectPreviewProjectionStats(page);
    let blockProjectionCorrectness = runCorrectnessGates
      ? await runCorrectnessGateSuite({
          app,
          blockCount,
          label: "tanstack-both-block-projection",
          notesRoot,
          page
        })
      : deferredCorrectnessGateSuite();
    await resetVirtualWindowsToStart(page);
    await resetRenderCommitProbe(page);
    const blockProjectionInputLatency = await measureInputToPreview(page, `${blockCount}-tanstack-both-block-projection`);
    const blockProjectionRenderCommits = await collectRenderCommitProbe(page);
    const blockProjectionAfterInputStats = await collectPreviewProjectionStats(page);
    if (runCorrectnessGates) {
      const projectionReuse = {
        status: blockProjectionAfterInputStats.reparsedBlockCount === 1 ? "passed" : "failed",
        passed: blockProjectionAfterInputStats.reparsedBlockCount === 1,
        expectedReparsedBlockCount: 1,
        ...blockProjectionAfterInputStats
      };
      blockProjectionCorrectness = {
        ...blockProjectionCorrectness,
        passed: blockProjectionCorrectness.passed && projectionReuse.passed,
        gates: {
          ...blockProjectionCorrectness.gates,
          projectionReuse
        }
      };
    }
    const blockProjectionPipeline = runPipelineProbes
      ? await measureInputPipelineSegments(page, `${blockCount}-tanstack-both-block-projection`)
      : deferredPipelineProbe();
    process.stdout.write(`[editor ui lab] ${blockCount}: block projection comparison prepared\n`);

    return {
      blockCount,
      launchToEditorsReadyMs: round(launchToEditorsReadyMs),
      launchToPreviewReadyMs: round(launchToPreviewReadyMs),
      current: {
        ...currentDom,
        scroll: currentScroll,
        inputLatency: currentInputLatency
      },
      finiteViewUpperBound: {
        sourceReadyMs: round(finiteViewSourceReadyMs),
        reloadToReadyMs: round(finiteViewReloadToReadyMs),
        sourceReadyDom: finiteViewSourceReadyDom,
        ...finiteViewDom,
        scroll: finiteViewScroll,
        inputLatency: finiteViewInputLatency
      },
      dynamicVisibleWindow: {
        sourceReadyMs: round(dynamicSourceReadyMs),
        reloadToReadyMs: round(dynamicReloadToReadyMs),
        sourceReadyDom: dynamicSourceReadyDom,
        ...dynamicDom,
        scroll: dynamicScroll,
        inputLatency: dynamicInputLatency,
        stateRetention: dynamicStateRetention
      },
      virtualBlockWindow: {
        sourceReadyMs: round(virtualSourceReadyMs),
        reloadToReadyMs: round(virtualReloadToReadyMs),
        sourceReadyDom: virtualSourceReadyDom,
        ...virtualDom,
        scroll: virtualScroll,
        inputLatency: virtualInputLatency,
        stateRetention: virtualStateRetention
      },
      virtualBothWindows: {
        reloadToReadyMs: round(combinedReloadToReadyMs),
        ...combinedDom,
        sourceScroll: combinedSourceScroll,
        previewScroll: combinedPreviewScroll,
        inputLatency: combinedInputLatency,
        inputReliability: {
          attempts: combinedInputReliability,
          passed: combinedInputReliability.filter((attempt) => attempt.error === null).length,
          total: combinedInputReliability.length
        },
        stateRetention: combinedStateRetention
      },
      virtualBothMeasured: {
        reloadToReadyMs: round(measuredCombinedReloadToReadyMs),
        initialDom: measuredCombinedInitialDom,
        previewScroll: measuredCombinedPreviewScroll,
        calibration: measuredCombinedCalibration,
        resizeAnchor: measuredCombinedResizeAnchor,
        inputLatency: measuredCombinedInputLatency,
        inputPipeline: measuredCombinedPipeline,
        correctness: measuredCombinedCorrectness
      },
      virtualSourceTanStackPreview: {
        reloadToReadyMs: round(tanStackReloadToReadyMs),
        initialDom: tanStackInitialDom,
        previewScroll: tanStackPreviewScroll,
        calibration: tanStackCalibration,
        resizeAnchor: tanStackResizeAnchor,
        inputLatency: tanStackInputLatency,
        inputPipeline: tanStackPipeline,
        correctness: tanStackCorrectness
      },
      tanStackSourceTanStackPreview: {
        reloadToReadyMs: round(tanStackBothReloadToReadyMs),
        initialDom: tanStackBothInitialDom,
        sourceStats: tanStackBothSourceStats,
        sourceScroll: tanStackBothSourceScroll,
        previewScroll: tanStackBothPreviewScroll,
        inputLatency: tanStackBothInputLatency,
        inputPipeline: tanStackBothPipeline,
        correctness: tanStackBothCorrectness
      },
      tanStackBothBlockProjection: {
        reloadToReadyMs: round(blockProjectionReloadToReadyMs),
        initialProjection: blockProjectionInitialStats,
        afterInputProjection: blockProjectionAfterInputStats,
        renderCommits: blockProjectionRenderCommits,
        inputLatency: blockProjectionInputLatency,
        inputPipeline: blockProjectionPipeline,
        correctness: blockProjectionCorrectness
      }
    };
  } finally {
    await app?.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    }).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await rm(notesRoot, { recursive: true, force: true });
  }
}

async function measureRecognitionPreviewStreamExperiment({ app, blockCount, launchStartedAt, notesRoot, page }) {
  await page.evaluate(() => {
    for (const key of [
      "mathnotes:editor-windowing-lab",
      "mathnotes:source-overscan-lab",
      "mathnotes:source-scroll-shell-lab",
      "mathnotes:layout-anchor-lab",
      "mathnotes:preview-windowing-lab",
      "mathnotes:preview-projection-lab"
    ]) localStorage.removeItem(key);
    localStorage.setItem("mathnotes:render-commit-lab", "on");
  });
  const reloadStartedAt = performance.now();
  await page.reload();
  await page.bringToFront();
  await page.waitForFunction(
    () => {
      const source = document.querySelector("[data-testid='session-source-editor']");
      const renderedSourceBlocks = document.querySelectorAll("[data-testid='source-block']").length;
      const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
      return source?.getAttribute("data-editor-windowing-lab") === "tanstack-virtual" &&
        renderedSourceBlocks > 0 && editorCount === renderedSourceBlocks;
    },
    undefined,
    { timeout: 30000 }
  );
  const reloadToSourceReadyMs = performance.now() - reloadStartedAt;
  await page.waitForFunction(
    (expectedBlocks) => {
      const source = document.querySelector("[data-testid='session-source-editor']");
      const preview = document.querySelector(".preview-scroll");
      return source?.getAttribute("data-editor-windowing-lab") === "tanstack-virtual" &&
        preview?.getAttribute("data-preview-windowing-lab") === "tanstack-measured" &&
        document.querySelector(".app-shell")?.getAttribute("data-preview-projection-lab") === "block-map" &&
        document.querySelectorAll("[data-testid='source-block']").length > 0 &&
        document.querySelectorAll("[data-testid='source-block']").length <= expectedBlocks;
    },
    blockCount,
    { timeout: 90000 }
  );
  await waitForIdleFrames(page, 10);
  const reloadToReadyMs = performance.now() - reloadStartedAt;
  const lastBlockId = String(blockCount).padStart(4, "0");
  const lastBlockPath = path.join(
    notesRoot,
    "notebooks",
    "functional_analysis",
    "sessions",
    "lecture",
    "blocks",
    `${lastBlockId}_user_note.md`
  );

  const away = await measureRecognitionPreviewStreamBurst({
    app,
    count: 48,
    intervalMs: 16,
    lastBlockId,
    lastBlockPath,
    page,
    scrollRatio: 0.42,
    suffix: `away-${blockCount}`
  });
  const bottom = await measureRecognitionPreviewStreamBurst({
    app,
    count: 48,
    intervalMs: 16,
    lastBlockId,
    lastBlockPath,
    page,
    scrollRatio: 1,
    suffix: `bottom-${blockCount}`
  });
  const correctness = runCorrectnessGates
    ? recognitionStreamCorrectnessSuite(away, bottom)
    : deferredRecognitionStreamCorrectnessSuite();

  process.stdout.write(`[editor ui lab] ${blockCount}: recognition preview stream measured\n`);
  return {
    blockCount,
    launchToInitialReadyMs: round(performance.now() - launchStartedAt),
    recognitionStreamExperiment: {
      reloadToReadyMs: round(reloadToReadyMs),
      away,
      bottom,
      correctness
    }
  };
}

async function measureInteractionExperiment({ app, blockCount, launchStartedAt, page }) {
  await page.evaluate(() => {
    for (const key of [
      "mathnotes:editor-windowing-lab",
      "mathnotes:source-overscan-lab",
      "mathnotes:source-scroll-shell-lab",
      "mathnotes:layout-anchor-lab",
      "mathnotes:preview-windowing-lab",
      "mathnotes:preview-projection-lab"
    ]) localStorage.removeItem(key);
    localStorage.setItem("mathnotes:render-commit-lab", "on");
  });
  const reloadStartedAt = performance.now();
  await page.reload();
  await page.bringToFront();
  await page.getByRole("button", { name: "任务与块信息" }).waitFor({ timeout: 30000 });
  await waitForIdleFrames(page, 8);
  const reloadToReadyMs = performance.now() - reloadStartedAt;

  const windowDrag = await measureManualWindowDragBurst(app, page);
  const actualWindowDrag = await measureActualWindowDragBurst(app, page);
  const runtimeIdleControl = await measureIdleRenderCommits(page, 6400);
  const taskCenterClosed = await measureTaskCenterRuntimeBurst(app, page, {
    count: 180,
    intervalMs: 16,
    open: false,
    suffix: "closed"
  });

  await page.reload();
  await page.bringToFront();
  await page.getByRole("button", { name: "任务与块信息" }).waitFor({ timeout: 30000 });
  await waitForIdleFrames(page, 8);
  const taskCenterOpen = await measureTaskCenterRuntimeBurst(app, page, {
    count: 180,
    intervalMs: 16,
    open: true,
    suffix: "open"
  });

  process.stdout.write(`[editor ui lab] ${blockCount}: interaction burst experiment measured\n`);
  return {
    blockCount,
    launchToInitialReadyMs: round(performance.now() - launchStartedAt),
    interactionExperiment: {
      reloadToReadyMs: round(reloadToReadyMs),
      windowDrag,
      actualWindowDrag,
      runtimeIdleControl,
      taskCenterClosed,
      taskCenterOpen
    }
  };
}

async function measureIdleRenderCommits(page, durationMs) {
  await resetRenderCommitProbe(page);
  const startedAt = performance.now();
  await page.waitForTimeout(durationMs);
  await waitForIdleFrames(page, 8);
  return mapNumbers({
    elapsedMs: performance.now() - startedAt,
    renderCommits: await collectRenderCommitProbe(page)
  });
}

async function measureManualWindowDragBurst(app, page) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Performance window is unavailable");
    window.__mathNotesDragProbe = {
      calls: 0,
      originalSetPosition: window.setPosition.bind(window)
    };
    window.setPosition = () => {
      window.__mathNotesDragProbe.calls += 1;
    };
  });
  await resetRenderCommitProbe(page);
  await page.evaluate(() => {
    const probe = { startedAt: performance.now(), intervals: [], longTasks: [], running: true, frameHandle: 0, previousFrame: performance.now(), longTaskObserver: null };
    const frameLoop = (now) => {
      probe.intervals.push(now - probe.previousFrame);
      probe.previousFrame = now;
      if (probe.running) probe.frameHandle = requestAnimationFrame(frameLoop);
    };
    probe.frameHandle = requestAnimationFrame(frameLoop);
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      probe.longTaskObserver = new PerformanceObserver((list) => probe.longTasks.push(...list.getEntries().map((entry) => ({ duration: entry.duration }))));
      probe.longTaskObserver.observe({ entryTypes: ["longtask"] });
    }
    window.__mathNotesWindowDragBurstProbe = probe;
  });
  await page.mouse.move(300, 10);
  await page.mouse.down();
  for (let index = 1; index <= 240; index += 1) {
    await page.waitForTimeout(4);
    await page.mouse.move(300 + index, 10);
  }
  await page.mouse.up();
  await waitForIdleFrames(page, 8);
  const renderer = await page.evaluate(() => {
    const probe = window.__mathNotesWindowDragBurstProbe;
    if (!probe) throw new Error("Window drag burst probe was not installed");
    probe.running = false;
    cancelAnimationFrame(probe.frameHandle);
    probe.longTaskObserver?.disconnect();
    const sorted = probe.intervals.slice(2).sort((left, right) => left - right);
    const result = {
      inputCount: 240,
      elapsedMs: performance.now() - probe.startedAt,
      frameCount: sorted.length,
      frameP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
      frameMaxMs: sorted.at(-1) ?? 0,
      framesOver20Ms: sorted.filter((duration) => duration > 20).length,
      longTaskCount: probe.longTasks.length,
      longTaskMaxMs: probe.longTasks.length ? Math.max(...probe.longTasks.map((entry) => entry.duration)) : 0
    };
    delete window.__mathNotesWindowDragBurstProbe;
    return result;
  });
  const main = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const probe = window?.__mathNotesDragProbe;
    if (!window || !probe) return { positionUpdateCalls: null };
    window.setPosition = probe.originalSetPosition;
    delete window.__mathNotesDragProbe;
    return { positionUpdateCalls: probe.calls };
  });
  return mapNumbers({
    ...renderer,
    ...main,
    renderCommits: await collectRenderCommitProbe(page)
  });
}

async function measureActualWindowDragBurst(app, page) {
  const mainSetup = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Performance window is unavailable");
    const originalSetPosition = window.setPosition.bind(window);
    const initialPosition = window.getPosition();
    window.__mathNotesActualDragProbe = {
      calls: 0,
      durations: [],
      initialPosition,
      originalSetPosition
    };
    window.setPosition = (x, y, animate) => {
      const startedAt = performance.now();
      try {
        return originalSetPosition(x, y, animate);
      } finally {
        window.__mathNotesActualDragProbe.calls += 1;
        window.__mathNotesActualDragProbe.durations.push(performance.now() - startedAt);
      }
    };
    return { initialPosition };
  });

  await resetRenderCommitProbe(page);
  let renderer;
  try {
    renderer = await page.evaluate(async ({ count }) => {
      if (!window.mathNotes) throw new Error("MathNotes bridge is unavailable");
      const intervals = [];
      const ipcLatencies = [];
      const longTasks = [];
      let previousFrame = performance.now();
      let pendingCalls = 0;
      let maxPendingCalls = 0;
      const pending = [];
      let longTaskObserver = null;
      if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        longTaskObserver = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)));
        longTaskObserver.observe({ entryTypes: ["longtask"] });
      }

      const startedAt = performance.now();
      await window.mathNotes.beginWindowDrag({ screenX: 500, screenY: 500 });
      for (let index = 1; index <= count; index += 1) {
        const now = await new Promise((resolve) => requestAnimationFrame(resolve));
        intervals.push(now - previousFrame);
        previousFrame = now;
        const offsetX = Math.round(Math.sin((index / count) * Math.PI * 4) * 24);
        const offsetY = Math.round(Math.cos((index / count) * Math.PI * 4) * 12 - 12);
        const callStartedAt = performance.now();
        pendingCalls += 1;
        maxPendingCalls = Math.max(maxPendingCalls, pendingCalls);
        const call = window.mathNotes.updateWindowDrag({ screenX: 500 + offsetX, screenY: 500 + offsetY })
          .then(() => ipcLatencies.push(performance.now() - callStartedAt))
          .finally(() => { pendingCalls -= 1; });
        pending.push(call);
      }
      await Promise.allSettled(pending);
      await window.mathNotes.endWindowDrag();
      longTaskObserver?.disconnect();
      const sortedFrames = intervals.slice(2).sort((left, right) => left - right);
      const sortedIpc = ipcLatencies.sort((left, right) => left - right);
      return {
        inputCount: count,
        elapsedMs: performance.now() - startedAt,
        frameCount: sortedFrames.length,
        frameP95Ms: sortedFrames[Math.min(sortedFrames.length - 1, Math.floor(sortedFrames.length * 0.95))] ?? 0,
        frameMaxMs: sortedFrames.at(-1) ?? 0,
        framesOver20Ms: sortedFrames.filter((duration) => duration > 20).length,
        ipcP50Ms: sortedIpc[Math.min(sortedIpc.length - 1, Math.floor(sortedIpc.length * 0.5))] ?? 0,
        ipcP95Ms: sortedIpc[Math.min(sortedIpc.length - 1, Math.floor(sortedIpc.length * 0.95))] ?? 0,
        ipcMaxMs: sortedIpc.at(-1) ?? 0,
        maxPendingCalls,
        longTaskCount: longTasks.length,
        longTaskMaxMs: longTasks.length ? Math.max(...longTasks) : 0
      };
    }, { count: 180 });
  } finally {
    await app.evaluate(({ BrowserWindow }, { initialPosition }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const probe = window?.__mathNotesActualDragProbe;
      if (!window || !probe) return;
      window.setPosition = probe.originalSetPosition;
      probe.originalSetPosition(initialPosition[0], initialPosition[1], false);
    }, mainSetup);
  }

  const main = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const probe = window?.__mathNotesActualDragProbe;
    if (!window || !probe) return { positionUpdateCalls: null };
    const sorted = probe.durations.sort((left, right) => left - right);
    const result = {
      positionUpdateCalls: probe.calls,
      setPositionP50Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] ?? 0,
      setPositionP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
      setPositionMaxMs: sorted.at(-1) ?? 0
    };
    delete window.__mathNotesActualDragProbe;
    return result;
  });

  return mapNumbers({
    ...renderer,
    ...main,
    renderCommits: await collectRenderCommitProbe(page)
  });
}

async function measureTaskCenterRuntimeBurst(app, page, { count, intervalMs, open, suffix }) {
  if (open) {
    await page.getByRole("button", { name: "任务与块信息" }).click();
    await page.waitForSelector("[data-testid='task-popover']", { timeout: 5000 });
    const taskToggle = page.locator(".recognition-task-row .task-row-toggle").first();
    await taskToggle.waitFor({ timeout: 5000 });
    await taskToggle.click();
    await page.waitForSelector(".recognition-task-row .task-row-details", { timeout: 5000 });
  }
  await resetRenderCommitProbe(page);
  await page.evaluate(() => {
    const root = document.querySelector(".task-popover");
    if (!(root instanceof HTMLElement)) throw new Error("Task center is unavailable");
    const probe = {
      startedAt: performance.now(),
      mutations: 0,
      textMutations: 0,
      longTasks: [],
      intervals: [],
      previousFrame: performance.now(),
      running: true,
      frameHandle: 0,
      observer: new MutationObserver((records) => {
        probe.mutations += records.length;
        probe.textMutations += records.filter((record) => record.type === "characterData" || record.addedNodes.length > 0).length;
      }),
      longTaskObserver: null
    };
    const frameLoop = (now) => {
      probe.intervals.push(now - probe.previousFrame);
      probe.previousFrame = now;
      if (probe.running) probe.frameHandle = requestAnimationFrame(frameLoop);
    };
    probe.frameHandle = requestAnimationFrame(frameLoop);
    probe.observer.observe(root, { characterData: true, childList: true, subtree: true });
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      probe.longTaskObserver = new PerformanceObserver((list) => probe.longTasks.push(...list.getEntries().map((entry) => ({ duration: entry.duration }))));
      probe.longTaskObserver.observe({ entryTypes: ["longtask"] });
    }
    window.__mathNotesTaskCenterBurstProbe = probe;
  });
  const emittedAt = performance.now();
  await app.evaluate(async ({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Performance window is unavailable");
    const at = new Date().toISOString();
    for (let index = 0; index < input.count; index += 1) {
      window.webContents.send("mathnotes:recognition-runtime-event", {
        id: `performance-${input.suffix}-${index}`,
        recognitionJobId: "performance-recognition-summary",
        notebookId: "functional_analysis",
        sessionId: "lecture",
        level: index % 7 === 0 ? "stdout" : "info",
        message: `runtime ${input.suffix} chunk ${String(index).padStart(4, "0")} ${"x".repeat(32)}`,
        at,
        previewChanged: false
      });
      if (input.intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
    }
  }, { count, intervalMs, suffix });
  await page.waitForTimeout(1600);
  await waitForIdleFrames(page, 8);
  const renderer = await page.evaluate(({ expectedCount, isOpen }) => {
    const probe = window.__mathNotesTaskCenterBurstProbe;
    if (!probe) throw new Error("Task center burst probe was not installed");
    probe.observer.disconnect();
    probe.longTaskObserver?.disconnect();
    probe.running = false;
    cancelAnimationFrame(probe.frameHandle);
    const consoleElement = document.querySelector(".task-runtime-console pre");
    const sorted = probe.intervals.slice(2).sort((left, right) => left - right);
    const result = {
      inputCount: expectedCount,
      taskCenterOpen: isOpen,
      elapsedMs: performance.now() - probe.startedAt,
      mutationCount: probe.mutations,
      textMutationCount: probe.textMutations,
      consoleMounted: consoleElement instanceof HTMLElement,
      consoleCharacterCount: consoleElement?.textContent?.length ?? 0,
      frameCount: sorted.length,
      frameP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
      frameMaxMs: sorted.at(-1) ?? 0,
      framesOver20Ms: sorted.filter((duration) => duration > 20).length,
      longTaskCount: probe.longTasks.length,
      longTaskMaxMs: probe.longTasks.length ? Math.max(...probe.longTasks.map((entry) => entry.duration)) : 0,
      renderCommits: window.__mathNotesRenderCommitLab?.snapshot() ?? {}
    };
    delete window.__mathNotesTaskCenterBurstProbe;
    return result;
  }, { expectedCount: count, isOpen: open });
  return mapNumbers({ ...renderer, emitRoundTripMs: performance.now() - emittedAt });
}

async function measureRecognitionPreviewStreamBurst({
  app,
  count,
  intervalMs,
  lastBlockId,
  lastBlockPath,
  page,
  scrollRatio,
  suffix
}) {
  await setWorkspaceScrollRatio(page, scrollRatio);
  const beforeScroll = await captureWorkspaceScrollState(page);
  await resetRenderCommitProbe(page);
  await page.evaluate(({ expectedPrefix, expectedCount }) => {
    const source = document.querySelector("[data-testid='session-source-editor']");
    const preview = document.querySelector(".preview-scroll");
    if (!(source instanceof HTMLElement) || !(preview instanceof HTMLElement)) {
      throw new Error("Recognition stream roots are unavailable");
    }
    const probe = {
      expectedPrefix,
      expectedCount,
      startedAt: performance.now(),
      sourceLatencies: new Map(),
      previewLatencies: new Map(),
      sourceMutationBatches: 0,
      previewMutationBatches: 0,
      intervals: [],
      previousFrame: performance.now(),
      running: true,
      frameHandle: 0,
      longTasks: [],
      sourceObserver: null,
      previewObserver: null,
      longTaskObserver: null
    };
    const scan = (root, target) => {
      const text = root.textContent ?? "";
      const pattern = new RegExp(`${expectedPrefix}-(\\d+)-(\\d+)`, "g");
      for (const match of text.matchAll(pattern)) {
        const marker = match[0];
        if (!target.has(marker)) target.set(marker, Date.now() - Number(match[2]));
      }
    };
    probe.sourceObserver = new MutationObserver(() => {
      probe.sourceMutationBatches += 1;
      scan(source, probe.sourceLatencies);
    });
    probe.previewObserver = new MutationObserver(() => {
      probe.previewMutationBatches += 1;
      scan(preview, probe.previewLatencies);
    });
    probe.sourceObserver.observe(source, { characterData: true, childList: true, subtree: true });
    probe.previewObserver.observe(preview, { characterData: true, childList: true, subtree: true });
    const frameLoop = (now) => {
      probe.intervals.push(now - probe.previousFrame);
      probe.previousFrame = now;
      if (probe.running) probe.frameHandle = requestAnimationFrame(frameLoop);
    };
    probe.frameHandle = requestAnimationFrame(frameLoop);
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      probe.longTaskObserver = new PerformanceObserver((list) => {
        probe.longTasks.push(...list.getEntries().map((entry) => ({ duration: entry.duration })));
      });
      probe.longTaskObserver.observe({ entryTypes: ["longtask"] });
    }
    window.__mathNotesRecognitionPreviewProbe = probe;
    window.__mathNotesRecognitionTimelineLab = {
      entries: [],
      record(entry) {
        this.entries.push(entry);
      }
    };
  }, { expectedPrefix: `recognition-${suffix}`, expectedCount: count });

  let draft = await readFile(lastBlockPath, "utf8");
  const emittedMarkers = [];
  const emittedAt = performance.now();
  for (let index = 0; index < count; index += 1) {
    const epoch = Date.now();
    const marker = `recognition-${suffix}-${String(index).padStart(3, "0")}-${epoch}`;
    emittedMarkers.push(marker);
    draft += `\n${marker}`;
    await writeFile(lastBlockPath, draft, "utf8");
    await emitRuntimePreviewChanged(app, `${suffix}-${index}`);
    if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const finalMarker = emittedMarkers.at(-1);
  if (scrollRatio >= 0.95 && finalMarker) {
    await page.waitForFunction(
      ({ blockId, marker }) => {
        const source = document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`);
        const preview = document.querySelector(`[data-testid='render-block'][data-block-id='${blockId}']`);
        return source?.textContent?.includes(marker) && preview?.textContent?.includes(marker);
      },
      { blockId: lastBlockId, marker: finalMarker },
      { timeout: 30000 }
    );
  } else {
    await page.waitForTimeout(1200);
  }
  await waitForIdleFrames(page, 14);
  const afterScroll = await captureWorkspaceScrollState(page);
  const renderer = await page.evaluate(({ expectedMarkers }) => {
    const probe = window.__mathNotesRecognitionPreviewProbe;
    if (!probe) throw new Error("Recognition preview stream probe was not installed");
    probe.sourceObserver?.disconnect();
    probe.previewObserver?.disconnect();
    probe.longTaskObserver?.disconnect();
    probe.running = false;
    cancelAnimationFrame(probe.frameHandle);
    const summarize = (values) => {
      const sorted = values.slice().sort((left, right) => left - right);
      return {
        observed: sorted.length,
        p50Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] ?? null,
        p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
        maxMs: sorted.at(-1) ?? null
      };
    };
    const frames = probe.intervals.slice(2).sort((left, right) => left - right);
    const result = {
      elapsedMs: performance.now() - probe.startedAt,
      emittedCount: expectedMarkers.length,
      source: summarize(Array.from(probe.sourceLatencies.values())),
      preview: summarize(Array.from(probe.previewLatencies.values())),
      finalSourceMarkerPresent: document.querySelector("[data-testid='session-source-editor']")?.textContent?.includes(expectedMarkers.at(-1) ?? "") ?? false,
      finalPreviewMarkerPresent: document.querySelector(".preview-scroll")?.textContent?.includes(expectedMarkers.at(-1) ?? "") ?? false,
      sourceMutationBatches: probe.sourceMutationBatches,
      previewMutationBatches: probe.previewMutationBatches,
      frameCount: frames.length,
      frameP95Ms: frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))] ?? 0,
      frameMaxMs: frames.at(-1) ?? 0,
      framesOver20Ms: frames.filter((duration) => duration > 20).length,
      longTaskCount: probe.longTasks.length,
      longTaskMaxMs: probe.longTasks.length ? Math.max(...probe.longTasks.map((entry) => entry.duration)) : 0,
      renderCommits: window.__mathNotesRenderCommitLab?.snapshot() ?? {}
    };
    delete window.__mathNotesRecognitionPreviewProbe;
    return result;
  }, { expectedMarkers: emittedMarkers });
  const timelineEntries = await page.evaluate(() => {
    const entries = window.__mathNotesRecognitionTimelineLab?.entries ?? [];
    delete window.__mathNotesRecognitionTimelineLab;
    return entries;
  });

  return mapNumbers({
    ...renderer,
    timeline: summarizeRecognitionTimeline(timelineEntries),
    emitRoundTripMs: performance.now() - emittedAt,
    scrollRatio,
    sourceScrollDriftPx: afterScroll.sourceScrollTop - beforeScroll.sourceScrollTop,
    previewScrollDriftPx: afterScroll.previewScrollTop - beforeScroll.previewScrollTop,
    sourceBottomDistancePx: afterScroll.sourceBottomDistance,
    previewBottomDistancePx: afterScroll.previewBottomDistance
  });
}

function summarizeRecognitionTimeline(entries) {
  const stages = [
    ["eventToScheduleMs", "runtime-event-received", "refresh-scheduled"],
    ["timerWaitMs", "refresh-scheduled", "refresh-timer-fired"],
    ["sessionLoadMs", "session-load-start", "session-load-end"],
    ["documentApplyMs", "document-apply-start", "document-apply-end"],
    ["commitWaitMs", "document-apply-end", "react-layout-commit"],
    ["paintWaitMs", "react-layout-commit", "next-paint"],
    ["cycleToPaintMs", "refresh-scheduled", "next-paint"]
  ];
  const byTrace = new Map();
  for (const entry of entries) {
    const trace = byTrace.get(entry.traceId) ?? new Map();
    if (!trace.has(entry.stage)) trace.set(entry.stage, entry.at);
    byTrace.set(entry.traceId, trace);
  }
  const summarize = (values) => {
    const sorted = values.slice().sort((left, right) => left - right);
    return {
      observed: sorted.length,
      p50Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] ?? null,
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
      maxMs: sorted.at(-1) ?? null
    };
  };
  return {
    cycles: byTrace.size,
    ...Object.fromEntries(stages.map(([label, startStage, endStage]) => {
      const values = [];
      for (const trace of byTrace.values()) {
        const start = trace.get(startStage);
        const end = trace.get(endStage);
        if (start !== undefined && end !== undefined) values.push(end - start);
      }
      return [label, summarize(values)];
    }))
  };
}

async function measureRenderCommitExperiment({ app, blockCount, launchStartedAt, notesRoot, page }) {
  await page.evaluate(({ layoutAnchorValue, productDefaultsValue, sourceOverscanValue, sourceScrollShellValue }) => {
    if (productDefaultsValue) {
      for (const key of [
        "mathnotes:editor-windowing-lab",
        "mathnotes:source-overscan-lab",
        "mathnotes:source-scroll-shell-lab",
        "mathnotes:layout-anchor-lab",
        "mathnotes:preview-windowing-lab",
        "mathnotes:preview-projection-lab"
      ]) localStorage.removeItem(key);
      localStorage.setItem("mathnotes:render-commit-lab", "on");
      return;
    }
    localStorage.setItem("mathnotes:editor-windowing-lab", "tanstack-virtual");
    localStorage.setItem("mathnotes:source-overscan-lab", String(sourceOverscanValue));
    localStorage.setItem("mathnotes:source-scroll-shell-lab", sourceScrollShellValue ? "on" : "off");
    localStorage.setItem("mathnotes:layout-anchor-lab", layoutAnchorValue ? "on" : "off");
    localStorage.setItem("mathnotes:preview-windowing-lab", "tanstack-measured");
    localStorage.setItem("mathnotes:preview-projection-lab", "block-map");
    localStorage.setItem("mathnotes:render-commit-lab", "on");
  }, {
    layoutAnchorValue: layoutAnchor,
    productDefaultsValue: productDefaults,
    sourceOverscanValue: sourceOverscan,
    sourceScrollShellValue: sourceScrollShell
  });
  const reloadStartedAt = performance.now();
  await page.reload();
  await page.bringToFront();
  await page.waitForFunction(
    () => {
      const source = document.querySelector("[data-testid='session-source-editor']");
      const renderedSourceBlocks = document.querySelectorAll("[data-testid='source-block']").length;
      const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
      return source?.getAttribute("data-editor-windowing-lab") === "tanstack-virtual" &&
        renderedSourceBlocks > 0 && editorCount === renderedSourceBlocks;
    },
    undefined,
    { timeout: 30000 }
  );
  const reloadToSourceReadyMs = performance.now() - reloadStartedAt;
  await page.waitForFunction(
    (expectedBlocks) => {
      const source = document.querySelector("[data-testid='session-source-editor']");
      const renderedSourceBlocks = document.querySelectorAll("[data-testid='source-block']").length;
      const editorCount = document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length;
      const renderedPreviewBlocks = document.querySelectorAll("[data-testid='render-block']").length;
      const preview = document.querySelector(".preview-scroll");
      return source?.getAttribute("data-editor-windowing-lab") === "tanstack-virtual" &&
        preview?.getAttribute("data-preview-windowing-lab") === "tanstack-measured" &&
        document.querySelector(".app-shell")?.getAttribute("data-preview-projection-lab") === "block-map" &&
        renderedSourceBlocks > 0 && renderedSourceBlocks <= expectedBlocks &&
        editorCount === renderedSourceBlocks &&
        renderedPreviewBlocks > 0 && renderedPreviewBlocks <= expectedBlocks;
    },
    blockCount,
    { timeout: 30000 }
  );
  await waitForIdleFrames(page, 8);
  const reloadToReadyMs = performance.now() - reloadStartedAt;
  const launchToInitialReadyMs = performance.now() - launchStartedAt;
  const initialDom = await collectDomStats(page);
  const sourceStats = await collectSourceTanStackStats(page);
  const initialProjectionStats = await collectPreviewProjectionStats(page);
  await resetVirtualWindowsToStart(page);
  await resetRenderCommitProbe(page);
  const inputLatency = await measureInputToPreview(page, `${blockCount}-render-commit`);
  const renderCommits = await collectRenderCommitProbe(page);
  const projectionStats = await collectPreviewProjectionStats(page);
  const pipeline = runPipelineProbes
    ? await measureInputPipelineSegments(page, `${blockCount}-render-commit`)
    : deferredPipelineProbe();
  const sourceScroll = await collectVariant(page, "render-commit-source");
  const sourceScrollSettleStability = await collectScrollSettleStability(
    page,
    "[data-testid='session-source-editor']"
  );
  const previewScroll = await collectVariant(page, "render-commit-preview", ".preview-scroll");
  let correctness = deferredCorrectnessGateSuite();
  if (runCorrectnessGates) {
    await prepareRenderCommitCorrectness(page, blockCount);
    correctness = await runCorrectnessGateSuite({
        app,
        blockCount,
        label: "render-commit",
        notesRoot,
        page
      });
  }

  process.stdout.write(`[editor ui lab] ${blockCount}: focused render commit experiment measured\n`);
  return {
    blockCount,
    launchToInitialReadyMs: round(launchToInitialReadyMs),
    renderCommitExperiment: {
      reloadToSourceReadyMs: round(reloadToSourceReadyMs),
      reloadToReadyMs: round(reloadToReadyMs),
      initialDom,
      sourceStats,
      initialProjectionStats,
      inputLatency,
      renderCommits,
      projectionStats,
      pipeline,
      sourceScroll,
      sourceScrollSettleStability,
      previewScroll,
      correctness
    }
  };
}

async function prepareRenderCommitCorrectness(page, blockCount) {
  await page.reload();
  await page.bringToFront();
  await page.waitForFunction(
    (expectedBlocks) => {
      const source = document.querySelector("[data-testid='session-source-editor']");
      const preview = document.querySelector(".preview-scroll");
      return source?.getAttribute("data-editor-windowing-lab") === "tanstack-virtual" &&
        preview?.getAttribute("data-preview-windowing-lab") === "tanstack-measured" &&
        document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length > 0 &&
        document.querySelectorAll("[data-testid='render-block']").length > 0 &&
        document.querySelectorAll("[data-testid='render-block']").length <= expectedBlocks;
    },
    blockCount,
    { timeout: 30000 }
  );
  await waitForIdleFrames(page, 8);
}

async function collectPreviewProjectionStats(page) {
  return page.locator(".app-shell").evaluate((element) => ({
    mode: element.getAttribute("data-preview-projection-lab"),
    reparsedBlockCount: Number(element.getAttribute("data-preview-projection-reparsed") || 0),
    relocatedBlockCount: Number(element.getAttribute("data-preview-projection-relocated") || 0),
    reusedBlockCount: Number(element.getAttribute("data-preview-projection-reused") || 0)
  }));
}

async function resetRenderCommitProbe(page) {
  await page.evaluate(() => window.__mathNotesRenderCommitLab?.reset());
}

async function collectRenderCommitProbe(page) {
  return page.evaluate(() => ({
    enabled: window.__mathNotesRenderCommitLab?.enabled ?? false,
    measurements: window.__mathNotesRenderCommitLab?.snapshot() ?? {}
  }));
}

function deferredCorrectnessGateSuite() {
  return {
    status: "deferred",
    passed: null,
    gates: {
      previewLocate: { status: "deferred", passed: null },
      streamingViewport: { status: "deferred", passed: null },
      blockMutation: { status: "deferred", passed: null },
      protectedSpanRemount: { status: "deferred", passed: null },
      layoutMutationAnchor: { status: "deferred", passed: null },
      editorStateRemount: { status: "deferred", passed: null }
    }
  };
}

function deferredPipelineProbe() {
  return {
    status: "deferred",
    marker: null,
    sourceCommitMs: null,
    sourcePaintMs: null,
    previewCommitMs: null,
    previewPaintMs: null,
    longTaskCount: null,
    longTaskTotalMs: null,
    longTaskMaxMs: null
  };
}

function collectCorrectnessGateFailures(measuredResults) {
  const failures = [];
  for (const result of measuredResults) {
    const focusedSuite = result.renderCommitExperiment?.correctness;
    if (focusedSuite && focusedSuite.status !== "deferred") {
      collectSuiteFailures(failures, result.blockCount, "renderCommitExperiment", focusedSuite);
    }
    const recognitionSuite = result.recognitionStreamExperiment?.correctness;
    if (recognitionSuite && recognitionSuite.status !== "deferred") {
      collectSuiteFailures(failures, result.blockCount, "recognitionStreamExperiment", recognitionSuite);
    }
    for (const variant of [
      "virtualBothMeasured",
      "virtualSourceTanStackPreview",
      "tanStackSourceTanStackPreview",
      "tanStackBothBlockProjection"
    ]) {
      const suite = result[variant]?.correctness;
      if (!suite || suite.status === "deferred") continue;
      collectSuiteFailures(failures, result.blockCount, variant, suite);
    }
  }
  return failures;
}

function deferredRecognitionStreamCorrectnessSuite() {
  return {
    status: "deferred",
    passed: null,
    gates: {
      awayViewport: { status: "deferred", passed: null },
      bottomFollow: { status: "deferred", passed: null }
    }
  };
}

function recognitionStreamCorrectnessSuite(away, bottom) {
  const gates = {
    awayViewport: {
      status: "measured",
      passed: Math.abs(away.sourceScrollDriftPx) <= 6 && Math.abs(away.previewScrollDriftPx) <= 6,
      sourceScrollDriftPx: away.sourceScrollDriftPx,
      previewScrollDriftPx: away.previewScrollDriftPx
    },
    bottomFollow: {
      status: "measured",
      passed: bottom.finalSourceMarkerPresent &&
        bottom.finalPreviewMarkerPresent &&
        bottom.sourceBottomDistancePx <= 8 &&
        bottom.previewBottomDistancePx <= 8,
      finalSourceMarkerPresent: bottom.finalSourceMarkerPresent,
      finalPreviewMarkerPresent: bottom.finalPreviewMarkerPresent,
      sourceBottomDistancePx: bottom.sourceBottomDistancePx,
      previewBottomDistancePx: bottom.previewBottomDistancePx
    }
  };
  return {
    status: "measured",
    passed: Object.values(gates).every((gate) => gate.passed),
    gates
  };
}

function collectSuiteFailures(failures, blockCount, variant, suite) {
  for (const [gate, detail] of Object.entries(suite.gates ?? {})) {
    if (detail?.passed === true) continue;
    failures.push({
      blockCount,
      variant,
      gate,
      error: detail?.error ?? null
    });
  }
}

async function runCorrectnessGateSuite({ app, blockCount, label, notesRoot, page }) {
  const previewLocate = await captureCorrectnessGate(() => measurePreviewLocateGate(page, blockCount));
  await resetCorrectnessUi(page);
  const streamingViewport = await captureCorrectnessGate(() => measureStreamingViewportGate({
    app,
    blockCount,
    label,
    notesRoot,
    page
  }));
  await resetCorrectnessUi(page);
  const backgroundRefreshIntent = await captureCorrectnessGate(() => measureBackgroundRefreshIntentGate({
    app,
    blockCount,
    label,
    notesRoot,
    page
  }));
  await resetCorrectnessUi(page);
  const blockMutation = await captureCorrectnessGate(() => measureBlockMutationGate({
    blockCount,
    notesRoot,
    page
  }));
  await resetCorrectnessUi(page);
  const protectedSpanRemount = await captureCorrectnessGate(() => measureProtectedSpanRemountGate({
    blockCount,
    notesRoot,
    page
  }));
  await resetCorrectnessUi(page);
  const layoutMutationAnchor = await captureCorrectnessGate(() => measureLayoutMutationAnchorGate({
    blockCount,
    page
  }));
  await resetCorrectnessUi(page);
  const editorStateRemount = await captureCorrectnessGate(() => measureEditorStateRemountGate({
    blockCount,
    page
  }));
  const gates = {
    previewLocate,
    streamingViewport,
    backgroundRefreshIntent,
    blockMutation,
    protectedSpanRemount,
    layoutMutationAnchor,
    editorStateRemount
  };
  return {
    status: "measured",
    passed: Object.values(gates).every((gate) => gate.passed === true),
    gates
  };
}

async function resetCorrectnessUi(page) {
  await page.reload();
  await page.bringToFront();
  await page.waitForFunction(() => Boolean(
    document.querySelector("[data-testid='session-source-editor']") &&
    document.querySelector(".preview-scroll") &&
    document.querySelector("[data-testid='source-block-editor'] .cm-editor")
  ), undefined, { timeout: 30000 });
  await waitForIdleFrames(page, 8);
}

async function captureCorrectnessGate(measure) {
  try {
    const detail = await measure();
    return {
      status: detail.passed ? "passed" : "failed",
      ...detail
    };
  } catch (error) {
    return {
      status: "failed",
      passed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function measurePreviewLocateGate(page, blockCount) {
  const targetIndex = Math.max(1, Math.min(blockCount - 1, Math.floor(blockCount * 0.68)));
  const targetId = String(targetIndex + 1).padStart(4, "0");
  await scrollVirtualItemIntoView({
    blockCount,
    itemSelector: `[data-testid='render-block'][data-block-id='${targetId}']`,
    page,
    scrollerSelector: ".preview-scroll",
    targetIndex
  });

  const target = page.locator(`[data-testid='render-block'][data-block-id='${targetId}']`);
  const geometry = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const lineCount = Number(element.getAttribute("data-line-count") ?? 1);
    const clickRatio = 0.68;
    return {
      clickX: Math.max(12, Math.min(rect.width - 12, rect.width * 0.38)),
      clickY: Math.max(12, Math.min(rect.height - 12, rect.height * clickRatio)),
      expectedLine: Math.max(1, Math.min(lineCount, Math.floor(clickRatio * lineCount) + 1)),
      lineCount
    };
  });
  await target.click({ position: { x: geometry.clickX, y: geometry.clickY } });
  await page.waitForFunction(
    (blockId) => Boolean(document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}'].locating .cm-previewLocatedLine`)),
    targetId,
    { timeout: 10000 }
  );

  const observed = await page.evaluate((blockId) => {
    const source = document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`);
    const scroller = document.querySelector("[data-testid='session-source-editor']");
    if (!(source instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      throw new Error("Located source block is not mounted");
    }
    const lines = Array.from(source.querySelectorAll(".cm-line"));
    const highlightedLineIndex = lines.findIndex((line) => line.classList.contains("cm-previewLocatedLine"));
    const sourceRect = source.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return {
      highlightedLine: highlightedLineIndex + 1,
      highlightedText: highlightedLineIndex >= 0 ? lines[highlightedLineIndex]?.textContent ?? "" : "",
      locating: source.classList.contains("locating"),
      sourceCenterOffsetPx: (sourceRect.top + sourceRect.height / 2) - (scrollerRect.top + scrollerRect.height / 2)
    };
  }, targetId);
  const lineDelta = Math.abs(observed.highlightedLine - geometry.expectedLine);
  return {
    passed: observed.locating && observed.highlightedLine > 0 && lineDelta <= 1,
    targetBlockId: targetId,
    expectedLine: geometry.expectedLine,
    observedLine: observed.highlightedLine,
    lineDelta,
    lineCount: geometry.lineCount,
    highlightedText: observed.highlightedText,
    sourceCenterOffsetPx: round(observed.sourceCenterOffsetPx)
  };
}

async function measureStreamingViewportGate({ app, blockCount, label, notesRoot, page }) {
  const lastBlockId = String(blockCount).padStart(4, "0");
  const lastBlockPath = path.join(
    notesRoot,
    "notebooks",
    "functional_analysis",
    "sessions",
    "lecture",
    "blocks",
    `${lastBlockId}_user_note.md`
  );
  await setWorkspaceScrollRatio(page, 0.42);
  const awayBefore = await captureWorkspaceScrollState(page);
  const awayMarker = `stream-away-${label}-${blockCount}-${Date.now()}`;
  await appendFile(lastBlockPath, `\n${awayMarker}\n`, "utf8");
  await emitRuntimePreviewChanged(app, `${label}-away-${blockCount}`);
  await page.waitForTimeout(650);
  await waitForIdleFrames(page, 8);
  const awayAfter = await captureWorkspaceScrollState(page);

  await setWorkspaceScrollRatio(page, 1);
  const bottomMarker = `stream-bottom-${label}-${blockCount}-${Date.now()}`;
  await appendFile(lastBlockPath, `\n${bottomMarker}\n`, "utf8");
  await emitRuntimePreviewChanged(app, `${label}-bottom-${blockCount}`);
  await page.waitForFunction(
    ({ blockId, marker }) => {
      const source = document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`);
      const preview = document.querySelector(`[data-testid='render-block'][data-block-id='${blockId}']`);
      return source?.textContent?.includes(marker) && preview?.textContent?.includes(marker);
    },
    { blockId: lastBlockId, marker: bottomMarker },
    { timeout: 15000 }
  );
  await waitForIdleFrames(page, 8);
  const bottomAfter = await captureWorkspaceScrollState(page);
  const sourceAwayDrift = awayAfter.sourceScrollTop - awayBefore.sourceScrollTop;
  const previewAwayDrift = awayAfter.previewScrollTop - awayBefore.previewScrollTop;
  return {
    passed:
      Math.abs(sourceAwayDrift) <= 6 &&
      Math.abs(previewAwayDrift) <= 6 &&
      bottomAfter.sourceBottomDistance <= 8 &&
      bottomAfter.previewBottomDistance <= 8,
    awayMarker,
    bottomMarker,
    sourceAwayDriftPx: round(sourceAwayDrift),
    previewAwayDriftPx: round(previewAwayDrift),
    sourceBottomDistancePx: round(bottomAfter.sourceBottomDistance),
    previewBottomDistancePx: round(bottomAfter.previewBottomDistance)
  };
}

async function measureBackgroundRefreshIntentGate({ app, blockCount, label, notesRoot, page }) {
  const lastBlockId = String(blockCount).padStart(4, "0");
  const lastBlockPath = path.join(
    notesRoot,
    "notebooks",
    "functional_analysis",
    "sessions",
    "lecture",
    "blocks",
    `${lastBlockId}_user_note.md`
  );
  await setWorkspaceScrollRatio(page, 0.31);
  const marker = `intent-race-${label}-${blockCount}-${Date.now()}`;
  await appendFile(lastBlockPath, `\n${marker}\n`, "utf8");
  await page.evaluate(() => {
    window.__mathNotesRecognitionTimelineLab = {
      entries: [],
      record(entry) {
        this.entries.push(entry);
      }
    };
  });
  const event = await emitRuntimePreviewChanged(app, `${label}-intent-race-${blockCount}`);
  await page.waitForFunction(
    ({ traceId }) => {
      const timeline = window.__mathNotesRecognitionTimelineLab;
      return timeline?.entries?.some(
        (entry) => entry.traceId === traceId && entry.stage === "document-apply-end"
      );
    },
    { traceId: event.id },
    { timeout: 15000 }
  );
  const intended = await page.evaluate(() => {
    const source = document.querySelector("[data-testid='session-source-editor']");
    const preview = document.querySelector(".preview-scroll");
    if (!(source instanceof HTMLElement) || !(preview instanceof HTMLElement)) {
      throw new Error("Workspace scrollers are unavailable");
    }
    const applyIntent = (element, ratio) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 180 }));
      const target = Math.round((element.scrollHeight - element.clientHeight) * ratio);
      element.scrollTop = target;
      return target;
    };
    return {
      sourceScrollTop: applyIntent(source, 0.73),
      previewScrollTop: applyIntent(preview, 0.67)
    };
  });
  await page.waitForTimeout(650);
  await waitForIdleFrames(page, 8);
  const settled = await captureWorkspaceScrollState(page);
  const sourceDrift = settled.sourceScrollTop - intended.sourceScrollTop;
  const previewDrift = settled.previewScrollTop - intended.previewScrollTop;
  await page.evaluate(() => {
    delete window.__mathNotesRecognitionTimelineLab;
  });
  return {
    passed: Math.abs(sourceDrift) <= 6 && Math.abs(previewDrift) <= 6,
    marker,
    sourceIntentDriftPx: round(sourceDrift),
    previewIntentDriftPx: round(previewDrift)
  };
}

async function measureBlockMutationGate({ blockCount, notesRoot, page }) {
  const beforeIds = await readFixtureBlockIds(notesRoot);
  const targetIndex = Math.max(1, Math.min(beforeIds.length - 2, Math.floor(beforeIds.length * 0.52)));
  const targetId = beforeIds[targetIndex];
  await scrollVirtualItemIntoView({
    blockCount,
    itemSelector: `[data-testid='source-block'][data-block-id='${targetId}']`,
    page,
    scrollerSelector: "[data-testid='session-source-editor']",
    targetIndex
  });
  const targetEditor = page.locator(`[data-testid='source-block'][data-block-id='${targetId}'] .cm-content`);
  await targetEditor.waitFor({ state: "visible", timeout: 10000 });
  await targetEditor.click({ position: { x: 120, y: 18 } });
  const sourceScrollTopBeforeCreate = await readScrollTop(page, "[data-testid='session-source-editor']");
  await page.getByRole("button", { name: "添加内容" }).click();
  await page.getByRole("menuitem", { name: "新建文本块" }).click();

  const createdIds = await waitForFixtureBlockCount(notesRoot, beforeIds.length + 1);
  const createdId = createdIds.find((id) => !beforeIds.includes(id));
  if (!createdId) throw new Error("Created block id was not persisted");
  const createdBlock = page.locator(`[data-testid='source-block'][data-block-id='${createdId}']`);
  await createdBlock.waitFor({ state: "visible", timeout: 10000 });
  const createdLocated = await createdBlock.evaluate((element) => element.classList.contains("locating"));
  const sourceScrollTopAfterCreate = await readScrollTop(page, "[data-testid='session-source-editor']");

  await page.evaluate(() => {
    window.confirm = () => true;
  });
  const sourceScrollTopBeforeDelete = await readScrollTop(page, "[data-testid='session-source-editor']");
  await createdBlock.locator("button.source-block-delete").click();
  const restoredIds = await waitForFixtureBlockCount(notesRoot, beforeIds.length);
  const expectedNeighborId = beforeIds[targetIndex + 1] ?? beforeIds[targetIndex - 1];
  await page.waitForFunction(
    (blockId) => Boolean(document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}'].locating`)),
    expectedNeighborId,
    { timeout: 10000 }
  );
  await waitForIdleFrames(page, 8);
  const after = await page.evaluate((blockId) => {
    const scroller = document.querySelector("[data-testid='session-source-editor']");
    const block = document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`);
    return {
      locating: block?.classList.contains("locating") ?? false,
      scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : 0
    };
  }, expectedNeighborId);
  return {
    passed:
      createdLocated &&
      restoredIds.length === beforeIds.length &&
      restoredIds.every((id, index) => id === beforeIds[index]) &&
      after.locating &&
      after.scrollTop > 0,
    targetBlockId: targetId,
    createdBlockId: createdId,
    createdLocated,
    sourceScrollTopBeforeCreate: round(sourceScrollTopBeforeCreate),
    sourceScrollTopAfterCreate: round(sourceScrollTopAfterCreate),
    sourceScrollTopBeforeDelete: round(sourceScrollTopBeforeDelete),
    expectedNeighborId,
    neighborLocated: after.locating,
    sourceScrollTopAfterDelete: round(after.scrollTop)
  };
}

async function readScrollTop(page, selector) {
  return page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector);
    return element instanceof HTMLElement ? element.scrollTop : -1;
  }, selector);
}

async function measureProtectedSpanRemountGate({ blockCount, notesRoot, page }) {
  const protectedFixture = await readProtectedFixture(notesRoot);
  const targetIndex = Number.parseInt(protectedFixture.blockId, 10) - 1;
  await scrollVirtualItemIntoView({
    blockCount,
    itemSelector: `[data-testid='source-block'][data-block-id='${protectedFixture.blockId}']`,
    page,
    scrollerSelector: "[data-testid='session-source-editor']",
    targetIndex
  });

  const before = await captureProtectedSpanDom(page, protectedFixture.blockId);
  await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid='session-source-editor']");
    if (!(scroller instanceof HTMLElement)) throw new Error("Source scroller is unavailable");
    scroller.scrollTop = 0;
  });
  await page.waitForFunction(
    (blockId) => !document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`),
    protectedFixture.blockId,
    { timeout: 10000 }
  );
  await waitForIdleFrames(page, 8);
  const unmounted = await page.locator(
    `[data-testid='source-block'][data-block-id='${protectedFixture.blockId}']`
  ).count() === 0;

  await scrollVirtualItemIntoView({
    blockCount,
    itemSelector: `[data-testid='source-block'][data-block-id='${protectedFixture.blockId}']`,
    page,
    scrollerSelector: "[data-testid='session-source-editor']",
    targetIndex
  });
  const after = await captureProtectedSpanDom(page, protectedFixture.blockId);
  const persistedFixture = await readProtectedFixture(notesRoot);

  return {
    passed:
      unmounted &&
      before.bodyDecorationCount > 0 &&
      before.boundaryDecorationCount >= 2 &&
      after.bodyDecorationCount === before.bodyDecorationCount &&
      after.boundaryDecorationCount === before.boundaryDecorationCount &&
      after.decoratedText === before.decoratedText &&
      persistedFixture.markdown === protectedFixture.markdown &&
      persistedFixture.content === protectedFixture.content &&
      persistedFixture.contentHash === protectedFixture.contentHash &&
      persistedFixture.computedHash === protectedFixture.contentHash,
    blockId: protectedFixture.blockId,
    lockId: protectedFixture.lockId,
    unmounted,
    bodyDecorationCountBefore: before.bodyDecorationCount,
    bodyDecorationCountAfter: after.bodyDecorationCount,
    boundaryDecorationCountBefore: before.boundaryDecorationCount,
    boundaryDecorationCountAfter: after.boundaryDecorationCount,
    decoratedTextStable: after.decoratedText === before.decoratedText,
    markdownStable: persistedFixture.markdown === protectedFixture.markdown,
    contentStable: persistedFixture.content === protectedFixture.content,
    metadataHashStable: persistedFixture.contentHash === protectedFixture.contentHash,
    computedHashMatchesMetadata: persistedFixture.computedHash === protectedFixture.contentHash
  };
}

async function measureLayoutMutationAnchorGate({ blockCount, page }) {
  const targetIndex = Math.max(1, Math.min(blockCount - 2, Math.floor(blockCount * 0.61)));
  const targetId = String(targetIndex + 1).padStart(4, "0");
  await scrollVirtualItemIntoView({
    blockCount,
    itemSelector: `[data-testid='source-block'][data-block-id='${targetId}']`,
    page,
    scrollerSelector: "[data-testid='session-source-editor']",
    targetIndex
  });
  await scrollVirtualItemIntoView({
    blockCount,
    itemSelector: `[data-testid='render-block'][data-block-id='${targetId}']`,
    page,
    scrollerSelector: ".preview-scroll",
    targetIndex
  });
  const before = await captureLayoutMutationAnchor(page, targetId);
  const previousStyles = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    if (!(shell instanceof HTMLElement)) throw new Error("App shell is unavailable");
    window.dispatchEvent(new Event("mathnotes:layout-anchor-start"));
    const computed = getComputedStyle(shell);
    const sourceFontSize = Number.parseFloat(computed.getPropertyValue("--source-font-size")) || 13;
    const previewFontSize = Number.parseFloat(computed.getPropertyValue("--preview-font-size")) || 16;
    const previous = {
      sourceWidth: shell.style.getPropertyValue("--source-width"),
      sourceFontSize: shell.style.getPropertyValue("--source-font-size"),
      previewFontSize: shell.style.getPropertyValue("--preview-font-size")
    };
    shell.style.setProperty("--source-width", "36%");
    shell.style.setProperty("--source-font-size", `${sourceFontSize + 3}px`);
    shell.style.setProperty("--preview-font-size", `${previewFontSize + 3}px`);
    window.dispatchEvent(new Event("mathnotes:layout-anchor-end"));
    window.dispatchEvent(new Event("resize"));
    return previous;
  });

  const selectedAnchors = await page.evaluate(() => ({
    source: {
      blockId: document.querySelector("[data-testid='session-source-editor']")?.dataset.workspaceLayoutAnchorBlockId ?? "",
      offsetTop: Number(document.querySelector("[data-testid='session-source-editor']")?.dataset.workspaceLayoutAnchorOffsetTop ?? 0)
    },
    preview: {
      blockId: document.querySelector(".preview-scroll")?.dataset.workspaceLayoutAnchorBlockId ?? "",
      offsetTop: Number(document.querySelector(".preview-scroll")?.dataset.workspaceLayoutAnchorOffsetTop ?? 0)
    }
  }));

  let after;
  try {
    await waitForIdleFrames(page, 24);
    after = await captureLayoutMutationAnchor(page, targetId);
    after.selectedAnchorOffsets = await page.evaluate((anchors) => {
      const offsetFor = (scrollerSelector, blockSelector, blockId) => {
        const scroller = document.querySelector(scrollerSelector);
        const block = document.querySelector(`${blockSelector}[data-block-id='${blockId}']`);
        if (!(scroller instanceof HTMLElement) || !(block instanceof HTMLElement)) return null;
        return block.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      };
      return {
        source: offsetFor("[data-testid='session-source-editor']", "[data-testid='source-block']", anchors.source.blockId),
        preview: offsetFor(".preview-scroll", "[data-testid='render-block']", anchors.preview.blockId)
      };
    }, selectedAnchors);
  } finally {
    await page.evaluate((previous) => {
      const shell = document.querySelector(".app-shell");
      if (!(shell instanceof HTMLElement)) return;
      for (const [property, value] of [
        ["--source-width", previous.sourceWidth],
        ["--source-font-size", previous.sourceFontSize],
        ["--preview-font-size", previous.previewFontSize]
      ]) {
        if (value) shell.style.setProperty(property, value);
        else shell.style.removeProperty(property);
      }
      window.dispatchEvent(new Event("resize"));
    }, previousStyles);
    await waitForIdleFrames(page, 12);
  }

  const sourceDriftPx = after.sourceOffsetPx - before.sourceOffsetPx;
  const previewDriftPx = after.previewOffsetPx - before.previewOffsetPx;
  const sourceSelectedAnchorDriftPx = after.selectedAnchorOffsets?.source === null
    ? Number.POSITIVE_INFINITY
    : after.selectedAnchorOffsets.source - selectedAnchors.source.offsetTop;
  const previewSelectedAnchorDriftPx = after.selectedAnchorOffsets?.preview === null
    ? Number.POSITIVE_INFINITY
    : after.selectedAnchorOffsets.preview - selectedAnchors.preview.offsetTop;
  return {
    passed:
      after.sourceBlockId === before.sourceBlockId &&
      after.previewBlockId === before.previewBlockId &&
      after.sourceWidthPx < before.sourceWidthPx - 80 &&
      after.sourceFontSizePx >= before.sourceFontSizePx + 2.5 &&
      after.previewFontSizePx >= before.previewFontSizePx + 2.5 &&
      Math.abs(sourceSelectedAnchorDriftPx) <= 12 &&
      Math.abs(previewSelectedAnchorDriftPx) <= 12,
    targetBlockId: targetId,
    sourceSelectedAnchorBlockId: selectedAnchors.source.blockId,
    previewSelectedAnchorBlockId: selectedAnchors.preview.blockId,
    sourceBlockIdentityStable: after.sourceBlockId === before.sourceBlockId,
    previewBlockIdentityStable: after.previewBlockId === before.previewBlockId,
    sourceWidthBeforePx: round(before.sourceWidthPx),
    sourceWidthAfterPx: round(after.sourceWidthPx),
    sourceFontSizeBeforePx: round(before.sourceFontSizePx),
    sourceFontSizeAfterPx: round(after.sourceFontSizePx),
    previewFontSizeBeforePx: round(before.previewFontSizePx),
    previewFontSizeAfterPx: round(after.previewFontSizePx),
    sourceAnchorDriftPx: round(sourceDriftPx),
    previewAnchorDriftPx: round(previewDriftPx),
    sourceSelectedAnchorDriftPx: round(sourceSelectedAnchorDriftPx),
    previewSelectedAnchorDriftPx: round(previewSelectedAnchorDriftPx)
  };
}

async function captureLayoutMutationAnchor(page, targetId) {
  return page.evaluate((blockId) => {
    const sourceScroller = document.querySelector("[data-testid='session-source-editor']");
    const previewScroller = document.querySelector(".preview-scroll");
    const source = document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`);
    const preview = document.querySelector(`[data-testid='render-block'][data-block-id='${blockId}']`);
    const shell = document.querySelector(".app-shell");
    if (
      !(sourceScroller instanceof HTMLElement) ||
      !(previewScroller instanceof HTMLElement) ||
      !(source instanceof HTMLElement) ||
      !(preview instanceof HTMLElement) ||
      !(shell instanceof HTMLElement)
    ) {
      throw new Error(`Layout anchor ${blockId} is not mounted on both surfaces`);
    }
    const sourceScrollerRect = sourceScroller.getBoundingClientRect();
    const previewScrollerRect = previewScroller.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    const shellStyles = getComputedStyle(shell);
    return {
      sourceBlockId: source.dataset.blockId ?? "",
      previewBlockId: preview.dataset.blockId ?? "",
      sourceOffsetPx: sourceRect.top - sourceScrollerRect.top,
      previewOffsetPx: previewRect.top - previewScrollerRect.top,
      sourceWidthPx: sourceScrollerRect.width,
      sourceFontSizePx: Number.parseFloat(shellStyles.getPropertyValue("--source-font-size")) || 0,
      previewFontSizePx: Number.parseFloat(shellStyles.getPropertyValue("--preview-font-size")) || 0
    };
  }, targetId);
}

async function measureEditorStateRemountGate({ blockCount, page }) {
  const targetIndex = Math.max(1, Math.min(blockCount - 2, Math.floor(blockCount * 0.56)));
  const targetId = String(targetIndex + 1).padStart(4, "0");
  const marker = `state-gate-${blockCount}-${Date.now()}`;
  const insertionProbe = "~";
  const cursorTailLength = Math.min(4, marker.length - 1);
  await scrollVirtualItemIntoView({
    blockCount,
    itemSelector: `[data-testid='source-block'][data-block-id='${targetId}']`,
    page,
    scrollerSelector: "[data-testid='session-source-editor']",
    targetIndex
  });
  const editor = page.locator(`[data-testid='source-block'][data-block-id='${targetId}'] .cm-content`);
  await editor.waitFor({ state: "visible", timeout: 10000 });
  await editor.click({ position: { x: 120, y: 18 } });
  await editor.press("Control+End");
  await page.keyboard.insertText(`\n${marker}`);
  for (let index = 0; index < cursorTailLength; index += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await waitForMountedEditorText(page, targetId, marker, true, "editor-state-initial-edit");
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid='session-source-editor']");
    if (!(scroller instanceof HTMLElement)) throw new Error("Source scroller is unavailable");
    scroller.scrollTop = 0;
  });
  await runGateStage("editor-state-unmount", () => page.waitForFunction(
    (blockId) => !document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`),
    targetId,
    { timeout: 10000 }
  ));
  await waitForIdleFrames(page, 8);
  const unmounted = await page.locator(`[data-testid='source-block'][data-block-id='${targetId}']`).count() === 0;

  await scrollVirtualItemIntoView({
    blockCount,
    itemSelector: `[data-testid='source-block'][data-block-id='${targetId}']`,
    page,
    scrollerSelector: "[data-testid='session-source-editor']",
    targetIndex
  });
  const remountedEditor = page.locator(`[data-testid='source-block'][data-block-id='${targetId}'] .cm-content`);
  await remountedEditor.focus();
  const survivedRemount = await readMountedEditorText(page, targetId).then((text) => text.includes(marker));
  await page.keyboard.insertText(insertionProbe);
  const expectedMarkerWithProbe = `${marker.slice(0, -cursorTailLength)}${insertionProbe}${marker.slice(-cursorTailLength)}`;
  await waitForMountedEditorText(page, targetId, expectedMarkerWithProbe, true, "editor-state-selection-restore");
  const selectionRestored = await readMountedEditorText(page, targetId).then((text) => text.includes(expectedMarkerWithProbe));

  await page.keyboard.press("Control+Z");
  await waitForMountedEditorText(page, targetId, expectedMarkerWithProbe, false, "editor-state-probe-undo");
  const probeUndoPreservedMarker = await readMountedEditorText(page, targetId).then(
    (text) => text.includes(marker) && !text.includes(expectedMarkerWithProbe)
  );
  await page.keyboard.press("Control+Z");
  await waitForMountedEditorText(page, targetId, marker, false, "editor-state-marker-undo");
  const markerUndoSucceeded = await readMountedEditorText(page, targetId).then((text) => !text.includes(marker));

  await page.keyboard.press("Control+Y");
  await waitForMountedEditorText(page, targetId, marker, true, "editor-state-marker-redo");
  const markerRedoSucceeded = await readMountedEditorText(page, targetId).then((text) => text.includes(marker));
  await page.keyboard.press("Control+Y");
  await waitForMountedEditorText(page, targetId, expectedMarkerWithProbe, true, "editor-state-probe-redo");
  const probeRedoSucceeded = await readMountedEditorText(page, targetId).then((text) => text.includes(expectedMarkerWithProbe));

  return {
    passed:
      unmounted &&
      survivedRemount &&
      selectionRestored &&
      probeUndoPreservedMarker &&
      markerUndoSucceeded &&
      markerRedoSucceeded &&
      probeRedoSucceeded,
    targetBlockId: targetId,
    marker,
    unmounted,
    survivedRemount,
    selectionRestoredAtExpectedOffset: selectionRestored,
    probeUndoPreservedMarker,
    markerUndoSucceeded,
    markerRedoSucceeded,
    probeRedoSucceeded
  };
}

async function waitForMountedEditorText(page, blockId, expected, present, stage = "editor-state-text") {
  await runGateStage(stage, () => page.waitForFunction(
    ({ expectedText, shouldBePresent, targetBlockId }) => {
      const source = document.querySelector(`[data-testid='source-block'][data-block-id='${targetBlockId}']`);
      const text = Array.from(source?.querySelectorAll(".cm-line") ?? [])
        .map((line) => line.textContent ?? "")
        .join("\n");
      return text.includes(expectedText) === shouldBePresent;
    },
    { expectedText: expected, shouldBePresent: present, targetBlockId: blockId },
    { timeout: 10000 }
  ));
}

async function runGateStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readMountedEditorText(page, blockId) {
  return page.evaluate((targetBlockId) => {
    const source = document.querySelector(`[data-testid='source-block'][data-block-id='${targetBlockId}']`);
    if (!(source instanceof HTMLElement)) throw new Error(`Source block ${targetBlockId} is not mounted`);
    return Array.from(source.querySelectorAll(".cm-line"))
      .map((line) => line.textContent ?? "")
      .join("\n");
  }, blockId);
}

async function captureProtectedSpanDom(page, blockId) {
  return page.evaluate((targetBlockId) => {
    const source = document.querySelector(`[data-testid='source-block'][data-block-id='${targetBlockId}']`);
    if (!(source instanceof HTMLElement)) throw new Error(`Protected source block ${targetBlockId} is not mounted`);
    const bodyDecorations = Array.from(source.querySelectorAll(".cm-lockSpanBody"));
    const boundaryDecorations = Array.from(source.querySelectorAll(".cm-lockSpanBoundary"));
    return {
      bodyDecorationCount: bodyDecorations.length,
      boundaryDecorationCount: boundaryDecorations.length,
      decoratedText: bodyDecorations.map((element) => element.textContent ?? "").join("\n")
    };
  }, blockId);
}

async function readProtectedFixture(notesRoot) {
  const sessionPath = path.join(notesRoot, "notebooks", "functional_analysis", "sessions", "lecture", "session.json");
  const sessionDir = path.dirname(sessionPath);
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  const lock = session.locks.find((entry) => entry.kind === "span");
  if (!lock) throw new Error("Performance fixture has no protected span lock");
  const block = session.blocks.find((entry) => entry.id === lock.blockId);
  if (!block?.path) throw new Error(`Protected block ${lock.blockId} is missing`);
  const markdown = await readFile(path.join(sessionDir, block.path), "utf8");
  const pattern = new RegExp(
    `<!-- lock:start id="${escapeRegExp(lock.id)}" hash="([a-f0-9]{64})" -->\\r?\\n?([\\s\\S]*?)\\r?\\n?<!-- lock:end id="${escapeRegExp(lock.id)}" -->`
  );
  const match = markdown.match(pattern);
  if (!match) throw new Error(`Protected span ${lock.id} is missing from Markdown`);
  const content = match[2].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return {
    blockId: lock.blockId,
    lockId: lock.id,
    contentHash: lock.contentHash,
    computedHash: sha256Hex(content),
    content,
    markdown
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function scrollVirtualItemIntoView({ blockCount, itemSelector, page, scrollerSelector, targetIndex }) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const found = await page.evaluate(
      ({ count, index, item, scroller }) => {
        const root = document.querySelector(scroller);
        if (!(root instanceof HTMLElement)) throw new Error(`Scroller not found: ${scroller}`);
        const element = document.querySelector(item);
        if (element instanceof HTMLElement) {
          const rootRect = root.getBoundingClientRect();
          const elementRect = element.getBoundingClientRect();
          const centeredTop = elementRect.top - rootRect.top - (root.clientHeight - elementRect.height) / 2;
          root.scrollTop += centeredTop;
          return true;
        }
        const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
        root.scrollTop = count <= 1 ? 0 : maxScrollTop * (index / (count - 1));
        return false;
      },
      { count: blockCount, index: targetIndex, item: itemSelector, scroller: scrollerSelector }
    );
    await waitForIdleFrames(page, found ? 4 : 8);
    if (found && await page.locator(itemSelector).isVisible()) {
      if (scrollerSelector === "[data-testid='session-source-editor']") {
        await page.waitForFunction(
          (selector) => Boolean(document.querySelector(`${selector} .cm-editor`)),
          itemSelector,
          { timeout: 2000 }
        );
      }
      return;
    }
  }
  await page.locator(itemSelector).waitFor({ state: "visible", timeout: 10000 });
}

async function setWorkspaceScrollRatio(page, ratio) {
  await page.evaluate((nextRatio) => {
    for (const selector of ["[data-testid='session-source-editor']", ".preview-scroll"]) {
      const scroller = document.querySelector(selector);
      if (!(scroller instanceof HTMLElement)) throw new Error(`Workspace scroller not found: ${selector}`);
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * nextRatio;
    }
  }, ratio);
  await waitForIdleFrames(page, 12);
}

async function captureWorkspaceScrollState(page) {
  return page.evaluate(() => {
    const source = document.querySelector("[data-testid='session-source-editor']");
    const preview = document.querySelector(".preview-scroll");
    if (!(source instanceof HTMLElement) || !(preview instanceof HTMLElement)) {
      throw new Error("Workspace scrollers are unavailable");
    }
    return {
      sourceScrollTop: source.scrollTop,
      previewScrollTop: preview.scrollTop,
      sourceBottomDistance: Math.max(0, source.scrollHeight - source.clientHeight - source.scrollTop),
      previewBottomDistance: Math.max(0, preview.scrollHeight - preview.clientHeight - preview.scrollTop)
    };
  });
}

async function emitRuntimePreviewChanged(app, suffix) {
  const event = {
    id: `performance-${suffix}-${Date.now()}`,
    recognitionJobId: `performance-${suffix}`,
    notebookId: "functional_analysis",
    sessionId: "lecture",
    level: "info",
    message: `performance preview refresh ${suffix}`,
    at: new Date().toISOString(),
    previewChanged: true
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await app.evaluate(({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send("mathnotes:recognition-runtime-event", payload);
      }, event);
      return event;
    } catch (error) {
      if (attempt === 3 || !String(error).includes("Execution context was destroyed")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return event;
}

async function readFixtureBlockIds(notesRoot) {
  const sessionPath = path.join(notesRoot, "notebooks", "functional_analysis", "sessions", "lecture", "session.json");
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  return session.blocks.filter((block) => block.type === "markdown").map((block) => block.id);
}

async function waitForFixtureBlockCount(notesRoot, expectedCount, timeoutMs = 10000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const ids = await readFixtureBlockIds(notesRoot);
    if (ids.length === expectedCount) return ids;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Fixture block count did not reach ${expectedCount}`);
}

async function measureEditorStateRetention(page, blockCount) {
  const marker = `state-retention-${blockCount}-${Date.now()}`;
  const scroller = page.getByTestId("session-source-editor");
  const firstBlock = page.locator("[data-testid='source-block'][data-block-id='0001']");
  const secondBlock = page.locator("[data-testid='source-block'][data-block-id='0002']");
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await firstBlock.locator(".cm-content").waitFor({ state: "visible", timeout: 10000 });
  const firstEditor = firstBlock.locator(".cm-content");
  await firstEditor.click({ position: { x: 120, y: 18 } });
  await firstEditor.press("Control+End");
  await page.keyboard.insertText(`\n${marker}`);
  await page.waitForFunction(
    ({ blockId, expected }) => document.querySelector(`[data-block-id='${blockId}'] .cm-content`)?.textContent?.includes(expected),
    { blockId: "0001", expected: marker },
    { timeout: 5000 }
  );
  let previewProjectionObserved = true;
  try {
    await page.waitForFunction(
      (expected) => document.querySelector("[data-testid='preview-pane']")?.textContent?.includes(expected),
      marker,
      { timeout: 3000 }
    );
  } catch {
    previewProjectionObserved = false;
    await page.waitForTimeout(300);
  }

  await secondBlock.locator(".cm-content").click({ position: { x: 120, y: 18 } });
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(
    () => !document.querySelector("[data-block-id='0001'] .cm-editor"),
    undefined,
    { timeout: 10000 }
  );
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await firstBlock.locator(".cm-content").waitFor({ state: "visible", timeout: 10000 });
  const survivedRemount = (await firstBlock.locator(".cm-content").textContent())?.includes(marker) ?? false;
  await firstBlock.locator(".cm-content").click({ position: { x: 120, y: 18 } });
  await firstBlock.locator(".cm-content").press("Control+Z");
  await page.waitForFunction(
    ({ blockId, expected }) => !document.querySelector(`[data-block-id='${blockId}'] .cm-content`)?.textContent?.includes(expected),
    { blockId: "0001", expected: marker },
    { timeout: 5000 }
  );
  return {
    marker,
    unmounted: true,
    previewProjectionObserved,
    survivedRemount,
    undoRestoredPreviousDocument: true
  };
}

async function collectDomStats(page) {
  return page.evaluate(() => {
    const source = document.querySelector("[data-testid='session-source-editor']");
    const preview = document.querySelector(".preview-scroll");
    return {
      codeMirrorViewCount: document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length,
      staticSourceCount: document.querySelectorAll("[data-testid='performance-static-source']").length,
      previewBlockCount: document.querySelectorAll("[data-testid='render-block']").length,
      domNodeCount: document.getElementsByTagName("*").length,
      sourceDomNodeCount: source?.querySelectorAll("*").length ?? 0,
      previewDomNodeCount: preview?.querySelectorAll("*").length ?? 0,
      sourceScrollHeight: source instanceof HTMLElement ? source.scrollHeight : 0,
      previewScrollHeight: preview instanceof HTMLElement ? preview.scrollHeight : 0,
      previewMeasuredBlockCount: preview instanceof HTMLElement ? Number(preview.dataset.previewMeasuredCount ?? 0) : 0,
      previewEstimatedTotalHeight: preview instanceof HTMLElement ? Number(preview.dataset.previewEstimatedTotalHeight ?? 0) : 0,
      previewCalibratedTotalHeight: preview instanceof HTMLElement ? Number(preview.dataset.previewCalibratedTotalHeight ?? 0) : 0,
      renderedLineCount: document.querySelectorAll(".session-source-editor .cm-line").length,
      usedJsHeapBytes:
        "memory" in performance && performance.memory && "usedJSHeapSize" in performance.memory
          ? performance.memory.usedJSHeapSize
          : null
    };
  });
}

async function collectPreviewCalibrationStats(page) {
  return page.evaluate(() => {
    const preview = document.querySelector(".preview-scroll");
    const article = preview?.querySelector(".rendered-note");
    if (!(preview instanceof HTMLElement) || !(article instanceof HTMLElement)) {
      throw new Error("Preview calibration surface not found");
    }
    const previewStyles = getComputedStyle(preview);
    const articleStyles = getComputedStyle(article);
    const chromeHeight = [
      previewStyles.paddingTop,
      previewStyles.paddingBottom,
      articleStyles.paddingTop,
      articleStyles.paddingBottom
    ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
    const measuredBlockCount = Number(preview.dataset.previewMeasuredCount ?? 0);
    const estimatedTotalHeight = Number(preview.dataset.previewEstimatedTotalHeight ?? 0);
    const calibratedTotalHeight = Number(preview.dataset.previewCalibratedTotalHeight ?? 0);
    const contentScrollHeight = Math.max(0, preview.scrollHeight - chromeHeight);
    return {
      measuredBlockCount,
      estimatedTotalHeight: roundBrowser(estimatedTotalHeight),
      calibratedTotalHeight: roundBrowser(calibratedTotalHeight),
      contentScrollHeight: roundBrowser(contentScrollHeight),
      calibrationErrorPx: roundBrowser(Math.abs(contentScrollHeight - calibratedTotalHeight)),
      estimatedErrorPx: roundBrowser(Math.abs(contentScrollHeight - estimatedTotalHeight)),
      anchorCorrectionCount: Number(preview.dataset.previewAnchorCorrectionCount ?? 0),
      anchorCorrectionPx: roundBrowser(Number(preview.dataset.previewAnchorCorrectionPx ?? 0))
    };

    function roundBrowser(value) {
      return Math.round(value * 1000) / 1000;
    }
  });
}

async function collectSourceTanStackStats(page) {
  return page.evaluate(() => {
    const source = document.querySelector("[data-testid='session-source-editor']");
    if (!(source instanceof HTMLElement)) throw new Error("Source editor scroller not found");
    return {
      measuredBlockCount: Number(source.dataset.sourceTanstackMeasuredCount ?? 0),
      totalHeight: roundBrowser(Number(source.dataset.sourceTanstackTotalHeight ?? 0)),
      scrollHeight: source.scrollHeight,
      renderedBlockCount: source.querySelectorAll("[data-testid='source-block']").length,
      mountedEditorCount: source.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length
    };

    function roundBrowser(value) {
      return Math.round(value * 1000) / 1000;
    }
  });
}

async function measurePreviewResizeAnchor(page) {
  const originalViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const before = await page.evaluate(async () => {
    const preview = document.querySelector(".preview-scroll");
    if (!(preview instanceof HTMLElement)) throw new Error("Preview scroller not found");
    preview.scrollTop = Math.max(0, (preview.scrollHeight - preview.clientHeight) * 0.62);
    await settle(12);
    const previewRect = preview.getBoundingClientRect();
    const contentTop = previewRect.top + (Number.parseFloat(getComputedStyle(preview).paddingTop) || 0);
    const blocks = Array.from(preview.querySelectorAll("[data-testid='render-block']"));
    const anchor = blocks
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > contentTop)
      .sort((left, right) => Math.abs(left.rect.top - contentTop) - Math.abs(right.rect.top - contentTop))[0];
    if (!anchor || !(anchor.element instanceof HTMLElement)) throw new Error("Visible preview anchor not found");
    return {
      blockId: anchor.element.dataset.blockId ?? "",
      offsetPx: anchor.rect.top - contentTop,
      correctionCount: Number(preview.dataset.previewAnchorCorrectionCount ?? 0),
      correctionPx: Number(preview.dataset.previewAnchorCorrectionPx ?? 0)
    };

    async function settle(count) {
      for (let index = 0; index < count; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
  });

  await page.setViewportSize({
    width: Math.max(920, originalViewport.width - 260),
    height: originalViewport.height
  });
  await waitForIdleFrames(page, 20);
  let after;
  try {
    await page.waitForFunction(
      (blockId) => Boolean(document.querySelector(`[data-testid='render-block'][data-block-id='${blockId}']`)),
      before.blockId,
      { timeout: 5000 }
    );
    after = await page.evaluate((blockId) => {
      const preview = document.querySelector(".preview-scroll");
      const anchor = document.querySelector(`[data-testid='render-block'][data-block-id='${blockId}']`);
      if (!(preview instanceof HTMLElement) || !(anchor instanceof HTMLElement)) {
        throw new Error("Preview anchor disappeared after resize");
      }
      const previewRect = preview.getBoundingClientRect();
      const contentTop = previewRect.top + (Number.parseFloat(getComputedStyle(preview).paddingTop) || 0);
      return {
        blockId: anchor.dataset.blockId ?? "",
        offsetPx: anchor.getBoundingClientRect().top - contentTop,
        correctionCount: Number(preview.dataset.previewAnchorCorrectionCount ?? 0),
        correctionPx: Number(preview.dataset.previewAnchorCorrectionPx ?? 0)
      };
    }, before.blockId);
  } catch (error) {
    after = {
      blockId: "",
      offsetPx: null,
      correctionCount: before.correctionCount,
      correctionPx: before.correctionPx,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  await page.setViewportSize(originalViewport);
  await waitForIdleFrames(page, 12);
  return {
    anchorBlockId: before.blockId,
    identityPreserved: after.blockId === before.blockId,
    beforeOffsetPx: round(before.offsetPx),
    afterOffsetPx: typeof after.offsetPx === "number" ? round(after.offsetPx) : null,
    driftPx: typeof after.offsetPx === "number" ? round(after.offsetPx - before.offsetPx) : null,
    correctionCountDelta: after.correctionCount - before.correctionCount,
    correctionPxDelta: round(after.correctionPx - before.correctionPx),
    error: "error" in after ? after.error : null
  };
}

async function waitForPreviewReady(page, blockCount) {
  await page.waitForFunction(
    (expectedBlocks) => document.querySelectorAll("[data-testid='render-block']").length === expectedBlocks,
    blockCount,
    { timeout: 90000 }
  );
}

async function resetVirtualWindowsToStart(page) {
  await page.evaluate(() => {
    const source = document.querySelector("[data-testid='session-source-editor']");
    const preview = document.querySelector(".preview-scroll");
    if (source instanceof HTMLElement) source.scrollTop = 0;
    if (preview instanceof HTMLElement) preview.scrollTop = 0;
  });
  await page.waitForFunction(
    () => Boolean(
      document.querySelector("[data-testid='source-block'][data-block-id='0001'] .cm-content") &&
      document.querySelector("[data-testid='render-block'][data-block-id='0001']")
    ),
    undefined,
    { timeout: 10000 }
  );
  await waitForIdleFrames(page, 8);
}

async function moveVirtualWindowsToEnd(page) {
  await page.evaluate(() => {
    const source = document.querySelector("[data-testid='session-source-editor']");
    const preview = document.querySelector(".preview-scroll");
    if (source instanceof HTMLElement) source.scrollTop = source.scrollHeight;
    if (preview instanceof HTMLElement) preview.scrollTop = preview.scrollHeight;
  });
  await page.waitForFunction(
    () => {
      const source = document.querySelector("[data-testid='session-source-editor']");
      const preview = document.querySelector(".preview-scroll");
      return source instanceof HTMLElement && preview instanceof HTMLElement &&
        source.scrollTop > 0 && preview.scrollTop > 0;
    },
    undefined,
    { timeout: 10000 }
  );
  await waitForIdleFrames(page, 8);
}

async function collectVariant(page, variant, scrollerSelector = "[data-testid='session-source-editor']") {
  const measurement = await page.evaluate(async ({ variantName, frameCount, selector }) => {
    const scroller = document.querySelector(selector);
    if (!(scroller instanceof HTMLElement)) throw new Error("Session source scroller not found");
    const longTasks = [];
    const supportsLongTasks = typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const observer = supportsLongTasks
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }
        })
      : null;
    observer?.observe({ entryTypes: ["longtask"] });

    const resetStartedAt = performance.now();
    scroller.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, 140));
    await settle(4);
    const scrollStartedAt = performance.now();
    const intervals = [];
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    let previous = performance.now();
    for (let index = 0; index < frameCount; index += 1) {
      const now = await nextFrame();
      intervals.push(now - previous);
      previous = now;
      scroller.scrollTop = maxScroll * ((index + 1) / frameCount);
    }
    const scrollEndedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 140));
    await settle(4);
    const settleEndedAt = performance.now();
    for (const entry of observer?.takeRecords() ?? []) {
      longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }
    observer?.disconnect();
    const sorted = intervals.slice(5).sort((a, b) => a - b);
    const quantile = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
    const resetLongTasks = summarizeLongTasks(resetStartedAt, scrollStartedAt);
    const activeScrollLongTasks = summarizeLongTasks(scrollStartedAt, scrollEndedAt);
    const settleLongTasks = summarizeLongTasks(scrollEndedAt, settleEndedAt);
    return {
      variant: variantName,
      scrollHeight: scroller.scrollHeight,
      frameCount: sorted.length,
      frameP50Ms: quantile(0.5),
      frameP95Ms: quantile(0.95),
      frameMaxMs: sorted.at(-1) ?? 0,
      framesOver20Ms: sorted.filter((duration) => duration > 20).length,
      framesOver50Ms: sorted.filter((duration) => duration > 50).length,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((sum, entry) => sum + entry.duration, 0),
      longTaskMaxMs: longTasks.length ? Math.max(...longTasks.map((entry) => entry.duration)) : 0,
      phases: {
        resetToTop: {
          elapsedMs: scrollStartedAt - resetStartedAt,
          ...resetLongTasks
        },
        activeScroll: {
          elapsedMs: scrollEndedAt - scrollStartedAt,
          ...activeScrollLongTasks
        },
        settleHydration: {
          elapsedMs: settleEndedAt - scrollEndedAt,
          ...settleLongTasks
        }
      },
      finalDom: {
        codeMirrorViewCount: document.querySelectorAll("[data-testid='source-block-editor'] .cm-editor").length,
        staticSourceCount: document.querySelectorAll("[data-testid='performance-static-source']").length,
        domNodeCount: document.querySelectorAll("*").length
      }
    };

    function summarizeLongTasks(startTime, endTime) {
      const entries = longTasks.filter((entry) => entry.startTime >= startTime && entry.startTime < endTime);
      return {
        longTaskCount: entries.length,
        longTaskTotalMs: entries.reduce((sum, entry) => sum + entry.duration, 0),
        longTaskMaxMs: entries.length ? Math.max(...entries.map((entry) => entry.duration)) : 0
      };
    }

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    }
    async function settle(count) {
      for (let index = 0; index < count; index += 1) await nextFrame();
    }
  }, { variantName: variant, frameCount: 180, selector: scrollerSelector });
  return mapNumbers(measurement);
}

async function collectScrollSettleStability(page, scrollerSelector) {
  const result = await page.evaluate(async (selector) => {
    const scroller = document.querySelector(selector);
    if (!(scroller instanceof HTMLElement)) throw new Error("Session source scroller not found");
    const ratios = [0.74, 0.21, 0.86, 0.38, 0.92, 0.16];
    const cycles = [];

    for (const ratio of ratios) {
      const startTop = scroller.scrollTop;
      const targetTop = Math.max(0, (scroller.scrollHeight - scroller.clientHeight) * ratio);
      for (let step = 1; step <= 12; step += 1) {
        scroller.scrollTop = startTop + (targetTop - startTop) * (step / 12);
        await nextFrame();
      }
      const releaseTop = scroller.scrollTop;
      const releaseHeight = scroller.scrollHeight;
      const samples = [];
      const sampleStartedAt = performance.now();
      while (performance.now() - sampleStartedAt < 650) {
        await nextFrame();
        samples.push({ scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight });
      }
      const maxDriftPx = samples.reduce(
        (maximum, sample) => Math.max(maximum, Math.abs(sample.scrollTop - releaseTop)),
        0
      );
      const maxHeightDeltaPx = samples.reduce(
        (maximum, sample) => Math.max(maximum, Math.abs(sample.scrollHeight - releaseHeight)),
        0
      );
      cycles.push({
        ratio,
        releaseTop,
        settledTop: samples.at(-1)?.scrollTop ?? releaseTop,
        maxDriftPx,
        maxHeightDeltaPx
      });
    }

    return {
      cycleCount: cycles.length,
      maxDriftPx: Math.max(0, ...cycles.map((cycle) => cycle.maxDriftPx)),
      maxHeightDeltaPx: Math.max(0, ...cycles.map((cycle) => cycle.maxHeightDeltaPx)),
      cycles
    };

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, scrollerSelector);
  return mapNumbers(result);
}

async function measureInputToPreview(page, label) {
  const marker = `ui-latency-${label}-${Date.now()}`;
  const scroller = page.getByTestId("session-source-editor");
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(140);
  const editor = page.locator("[data-testid='source-block'][data-block-id='0001'] .cm-content");
  await editor.waitFor({ state: "visible", timeout: 10000 });
  await editor.click({ position: { x: 120, y: 18 } });
  await editor.press("Control+End");
  const startedAt = performance.now();
  await page.keyboard.insertText(`\n${marker}`);
  let editorMs = null;
  let previewMs = null;
  try {
    await page.waitForFunction(
      (expected) => document.querySelector("[data-testid='source-block'][data-block-id='0001'] .cm-content")?.textContent?.includes(expected),
      marker,
      { timeout: 5000 }
    );
    editorMs = round(performance.now() - startedAt);
    await page.waitForFunction(
      (expected) => document.querySelector("[data-testid='preview-pane']")?.textContent?.includes(expected),
      marker,
      { timeout: 30000 }
    );
    previewMs = round(performance.now() - startedAt);
  } catch (error) {
    return {
      marker,
      editorMs,
      previewMs,
      sourceContainsMarker: await editor.textContent().then((text) => text?.includes(marker) ?? false),
      previewContainsMarker: await page.getByTestId("preview-pane").textContent().then((text) => text?.includes(marker) ?? false),
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return { marker, editorMs, previewMs, sourceContainsMarker: true, previewContainsMarker: true, error: null };
}

async function measureInputPipelineSegments(page, label) {
  const marker = `pipeline-${label}-${Date.now()}`;
  const scroller = page.getByTestId("session-source-editor");
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await waitForIdleFrames(page, 8);
  const editor = page.locator("[data-testid='source-block'][data-block-id='0001'] .cm-content");
  await editor.waitFor({ state: "visible", timeout: 10000 });
  await editor.click({ position: { x: 120, y: 18 } });
  await editor.press("Control+End");

  await page.evaluate((expectedMarker) => {
    const sourceRoot = document.querySelector("[data-testid='source-block'][data-block-id='0001']");
    const previewRoot = document.querySelector("[data-testid='preview-pane']");
    if (!(sourceRoot instanceof HTMLElement) || !(previewRoot instanceof HTMLElement)) {
      throw new Error("Input pipeline roots are unavailable");
    }
    const longTasks = [];
    const probe = {
      marker: expectedMarker,
      startedAt: performance.now(),
      sourceCommitAt: null,
      sourcePaintAt: null,
      previewCommitAt: null,
      previewPaintAt: null,
      longTasks,
      sourceObserver: null,
      previewObserver: null,
      longTaskObserver: null
    };
    const schedulePaint = (key) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (probe[key] === null) probe[key] = performance.now();
      }));
    };
    probe.sourceObserver = new MutationObserver(() => {
      if (probe.sourceCommitAt !== null || !sourceRoot.textContent?.includes(expectedMarker)) return;
      probe.sourceCommitAt = performance.now();
      schedulePaint("sourcePaintAt");
    });
    probe.previewObserver = new MutationObserver(() => {
      if (probe.previewCommitAt !== null || !previewRoot.textContent?.includes(expectedMarker)) return;
      probe.previewCommitAt = performance.now();
      schedulePaint("previewPaintAt");
    });
    probe.sourceObserver.observe(sourceRoot, { characterData: true, childList: true, subtree: true });
    probe.previewObserver.observe(previewRoot, { characterData: true, childList: true, subtree: true });
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      probe.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      probe.longTaskObserver.observe({ entryTypes: ["longtask"] });
    }
    window.__mathNotesInputPipelineProbe = probe;
    window.__mathNotesFinishInputPipelineProbe = () => {
      const current = window.__mathNotesInputPipelineProbe;
      if (!current) throw new Error("Input pipeline probe was not installed");
      current.sourceObserver?.disconnect();
      current.previewObserver?.disconnect();
      current.longTaskObserver?.disconnect();
      const endAt = performance.now();
      const relevantLongTasks = current.longTasks.filter(
        (entry) => entry.startTime >= current.startedAt && entry.startTime <= endAt
      );
      const delta = (value) => typeof value === "number"
        ? Math.round((value - current.startedAt) * 1000) / 1000
        : null;
      const between = (from, to) => typeof from === "number" && typeof to === "number"
        ? Math.round((to - from) * 1000) / 1000
        : null;
      const result = {
        status: "measured",
        marker: current.marker,
        sourceCommitMs: delta(current.sourceCommitAt),
        sourcePaintMs: delta(current.sourcePaintAt),
        previewCommitMs: delta(current.previewCommitAt),
        previewPaintMs: delta(current.previewPaintAt),
        sourceToPreviewCommitMs: between(current.sourceCommitAt, current.previewCommitAt),
        sourcePaintToPreviewPaintMs: between(current.sourcePaintAt, current.previewPaintAt),
        longTaskCount: relevantLongTasks.length,
        longTaskTotalMs: Math.round(relevantLongTasks.reduce((sum, entry) => sum + entry.duration, 0) * 1000) / 1000,
        longTaskMaxMs: relevantLongTasks.length
          ? Math.round(Math.max(...relevantLongTasks.map((entry) => entry.duration)) * 1000) / 1000
          : 0,
        error: null
      };
      delete window.__mathNotesInputPipelineProbe;
      delete window.__mathNotesFinishInputPipelineProbe;
      return result;
    };
  }, marker);

  try {
    await page.keyboard.insertText(`\n${marker}`);
    await page.waitForFunction(
      () => {
        const probe = window.__mathNotesInputPipelineProbe;
        return probe?.sourcePaintAt !== null && probe?.previewPaintAt !== null;
      },
      undefined,
      { timeout: 30000 }
    );
    await waitForIdleFrames(page, 4);
    return await page.evaluate(() => window.__mathNotesFinishInputPipelineProbe());
  } catch (error) {
    const partial = await page.evaluate(() => window.__mathNotesFinishInputPipelineProbe?.()).catch(() => null);
    return {
      ...partial,
      status: "failed",
      marker,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function waitForIdleFrames(page, count) {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

async function writeSessionFixture(rootDir, blockCount, profile) {
  const sessionDir = path.join(rootDir, "notebooks", "functional_analysis", "sessions", "lecture");
  const blocksDir = path.join(sessionDir, "blocks");
  await mkdir(blocksDir, { recursive: true });
  await mkdir(path.join(sessionDir, "logs"), { recursive: true });
  if (profile === "mixed-media") {
    await mkdir(path.join(sessionDir, "assets", "embedded"), { recursive: true });
    await mkdir(path.join(sessionDir, "assets", "pdfs"), { recursive: true });
    await writeFile(
      path.join(sessionDir, "assets", "embedded", "diagram.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAQ4BN4sAAAAASUVORK5CYII=", "base64")
    );
    await writeFile(path.join(sessionDir, "assets", "pdfs", "reference.pdf"), createMinimalPdf(6));
  }
  const now = new Date().toISOString();
  const blocks = [];
  const locks = [];
  const protectedBlockIndex = performanceProtectedBlockIndex(blockCount);
  for (let index = 1; index <= blockCount; index += 1) {
    const id = String(index).padStart(4, "0");
    const relativePath = `blocks/${id}_user_note.md`;
    const fixture = buildMarkdownBlock(index, profile, index === protectedBlockIndex ? id : null);
    await writeFile(path.join(sessionDir, relativePath), fixture.markdown, "utf8");
    blocks.push({
      id,
      type: "markdown",
      path: relativePath,
      source: "user",
      status: "draft",
      readonly: false,
      editableByAi: false,
      createdAt: now,
      updatedAt: now
    });
    if (fixture.lock) {
      locks.push({
        ...fixture.lock,
        createdAt: now
      });
    }
  }
  if (profile === "mixed-media") {
    blocks.splice(Math.min(8, blocks.length), 0, {
      id: "pdf-reference",
      type: "pdf",
      path: "assets/pdfs/reference.pdf",
      source: "user",
      sourceName: "reference.pdf",
      status: "reviewed",
      readonly: true,
      editableByAi: false,
      pageCount: 6,
      renderInNote: true,
      createdAt: now,
      updatedAt: now
    });
  }
  await writeFile(path.join(sessionDir, "session.json"), `${JSON.stringify({
    id: "lecture",
    title: `编辑器性能实验 ${blockCount} 块`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    blocks,
    locks,
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
  }, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(sessionDir, "logs", "recognition_jobs.json"),
    `${JSON.stringify([
      {
        id: "performance-recognition-summary",
        notebookId: "functional_analysis",
        sessionId: "lecture",
        imageBlockId: "0001",
        assetPath: "assets/photos/performance-board.jpg",
        imagePath: path.join(sessionDir, "assets", "photos", "performance-board.jpg"),
        now,
        status: "succeeded",
        attempts: 1,
        maxAttempts: 3,
        providerName: "performance_fixture",
        providerLabel: "性能实验识别服务",
        transcriptBlockId: "0001",
        warnings: []
      }
    ], null, 2)}\n`,
    "utf8"
  );
}

function buildMarkdownBlock(index, profile, protectedBlockId = null) {
  const markdown = [
    `### 定理 ${index}：有界算子与紧性`,
    "",
    `这是第 ${index} 个用于真实 Electron 性能实验的 Markdown 块。`,
    "",
    "设 $T_n:X\\to Y$ 为一列有界线性算子，并且对任意 $x\\in X$ 有 $T_nx\\to Tx$。",
    "",
    "$$",
    "\\|T\\| \\le \\sup_{n\\ge 1}\\|T_n\\|,\\qquad \\langle Tx,y\\rangle=\\lim_{n\\to\\infty}\\langle T_nx,y\\rangle.",
    "$$",
    "",
    "1. 保留原始推导顺序；",
    "2. 检查一致有界性；",
    "3. 对不清楚的符号保留 [不确定：...] 标记。",
    "",
    `结论 ${index}：该段落用于同时覆盖中文、Markdown、行内公式和块公式。`
  ];
  if (profile === "heterogeneous" || profile === "mixed-media") {
    if (index % 5 === 0) {
      markdown.push("", "> 这一块额外包含较长的板书解释，用于验证引用、换行和宽度变化后的动态高度。", "", "```text", "x -> Tx -> T_nx", "```");
    }
    if (index % 7 === 0) {
      markdown.push(
        "",
        "$$",
        "\\sum_{k=1}^{m} \\langle T x_k, y_k \\rangle \\le C \\left(\\sum_{k=1}^{m} \\|x_k\\|^2\\right)^{1/2} \\left(\\sum_{k=1}^{m} \\|y_k\\|^2\\right)^{1/2}.",
        "$$"
      );
    }
    if (index % 11 === 0) {
      for (let paragraph = 0; paragraph < 6; paragraph += 1) {
        markdown.push("", `补充推导 ${paragraph + 1}：${"保持顺序并检查每一步估计。".repeat(5)}`);
      }
    }
    if (profile === "mixed-media" && index % 10 === 0) {
      markdown.push("", "![局部板书图](../assets/embedded/diagram.png)");
    }
    if (profile === "mixed-media" && index % 13 === 0) {
      markdown.push(
        "",
        "$$",
        "\\int_{-\\infty}^{\\infty} \\frac{e^{-x^2}}{1+x^2}\\,dx + \\sum_{k=1}^{n} \\frac{\\langle T x_k,y_k\\rangle^2}{(1+\\|x_k\\|^2)(1+\\|y_k\\|^2)} \\le C_n \\prod_{j=1}^{m}(1+\\lambda_j^2)^{1/2}.",
        "$$"
      );
    }
  }
  let lock = null;
  if (protectedBlockId) {
    const lockId = `performance_lock_${protectedBlockId}`;
    const protectedContent = [
      `已确认结论 ${index}：该估计在当前假设下成立。`,
      "这两行用于验证虚拟卸载和重新挂载不会破坏人工锁定内容。"
    ].join("\n");
    const contentHash = sha256Hex(protectedContent);
    markdown.push(
      "",
      `<!-- lock:start id="${lockId}" hash="${contentHash}" -->`,
      protectedContent,
      `<!-- lock:end id="${lockId}" -->`
    );
    lock = {
      id: lockId,
      blockId: protectedBlockId,
      kind: "span",
      contentHash,
      createdBy: "user",
      aiEditable: false
    };
  }
  return {
    markdown: markdown.join("\n"),
    lock
  };
}

function createMinimalPdf(pageCount) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, (_, index) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageCount + 3 + index} 0 R >>`
    ),
    ...Array.from({ length: pageCount }, () => "<< /Length 0 >>\nstream\n\nendstream")
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function performanceProtectedBlockIndex(blockCount) {
  const targetIndex = Math.max(1, Math.min(blockCount - 2, Math.floor(blockCount * 0.72)));
  return targetIndex + 1;
}

function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function mapNumbers(value) {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === "number" ? round(entry) : entry]));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
