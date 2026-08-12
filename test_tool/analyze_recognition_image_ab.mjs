import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const directory = path.resolve(args.get("--directory") ?? "output/performance/recognition-ab");
const sourcePath = path.resolve(args.get("--source") ?? "");
const candidatePath = path.resolve(args.get("--candidate") ?? "");
if (!sourcePath || !candidatePath) {
  throw new Error("Usage: node analyze_recognition_image_ab.mjs --directory <dir> --source <jpg> --candidate <jpg>");
}

const samples = [
  ["original-a1", "original"],
  ["resized-b1", "resized"],
  ["resized-b2", "resized"],
  ["original-a2", "original"],
].map(([id, group]) => ({
  id,
  group,
  report: JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), "utf8")),
  transcript: fs.readFileSync(path.join(directory, `${id}.md`), "utf8").trim(),
}));

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const round = (value) => Math.round(value * 100) / 100;
const includes = (text, patterns) => patterns.some((pattern) => pattern.test(text));

function qualitySignals(transcript) {
  return {
    hasGenerally: /generally/i.test(transcript),
    hasSigmaA: /\\sigma\s*\{?\(?A\)?\}?|σ\s*\(?A\)?/i.test(transcript),
    hasSpectralMapping: /spectral\s+mapping/i.test(transcript),
    hasCenterNPiSquared: includes(transcript, [
      /n\s*\^\s*2\s*\\pi\s*\^\s*2/i,
      /n²\s*π²/i,
      /n\^2\s*π\^2/i,
    ]),
    describesTwoVerticalLines: /两条[^。\]\n]{0,36}(?:竖直|垂直)线/.test(transcript),
    hasUiContamination: /(My lectures|Home\s+Insert|Class Notebook|\b(?:89|99)%)/i.test(transcript),
    hasUncertaintyMarker: /\[(?:看不清|不确定)/.test(transcript),
  };
}

function summarize(group) {
  const rows = samples.filter((sample) => sample.group === group);
  const values = (getter) => rows.map(getter);
  const signalRows = rows.map((row) => qualitySignals(row.transcript));
  const signalRate = (key) => signalRows.filter((signals) => signals[key]).length / signalRows.length;
  return {
    sampleCount: rows.length,
    imageBytes: rows[0].report.fixture.bytes,
    requestBodyBytesMedian: round(median(values((row) => row.report.httpTimingsMs.requestBodyBytes))),
    timingsMedianMs: {
      fetchToHeaders: round(median(values((row) => row.report.httpTimingsMs.fetchCallToResponseHeaders))),
      firstBodyChunkToFirstOutput: round(median(values((row) => row.report.httpTimingsMs.firstBodyChunkToFirstOutput))),
      providerToFirstOutput: round(median(values((row) => row.report.timingsMs.providerStartToFirstOutput))),
      acceptToComplete: round(median(values((row) => row.report.timingsMs.acceptStartToComplete))),
    },
    warnings: rows.reduce((sum, row) => sum + row.report.result.warningCount, 0),
    qualitySignalRate: {
      generally: signalRate("hasGenerally"),
      sigmaA: signalRate("hasSigmaA"),
      spectralMapping: signalRate("hasSpectralMapping"),
      centerNPiSquared: signalRate("hasCenterNPiSquared"),
      twoVerticalLines: signalRate("describesTwoVerticalLines"),
      uiContamination: signalRate("hasUiContamination"),
      uncertaintyMarker: signalRate("hasUncertaintyMarker"),
    },
  };
}

const original = summarize("original");
const resized = summarize("resized");
const improvement = (baseline, candidate) => round(((baseline - candidate) / baseline) * 100);
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  experiment: {
    order: samples.map((sample) => sample.id),
    source: sourcePath,
    candidate: candidatePath,
    candidatePolicy: "long edge 2048px, JPEG quality 92, no crop, no sharpen",
  },
  groups: { original, resized },
  resizedImprovementPercent: {
    imageBytes: improvement(original.imageBytes, resized.imageBytes),
    requestBodyBytes: improvement(original.requestBodyBytesMedian, resized.requestBodyBytesMedian),
    fetchToHeaders: improvement(original.timingsMedianMs.fetchToHeaders, resized.timingsMedianMs.fetchToHeaders),
    firstBodyChunkToFirstOutput: improvement(
      original.timingsMedianMs.firstBodyChunkToFirstOutput,
      resized.timingsMedianMs.firstBodyChunkToFirstOutput,
    ),
    providerToFirstOutput: improvement(
      original.timingsMedianMs.providerToFirstOutput,
      resized.timingsMedianMs.providerToFirstOutput,
    ),
    acceptToComplete: improvement(original.timingsMedianMs.acceptToComplete, resized.timingsMedianMs.acceptToComplete),
  },
  decision: {
    acceptedAsDefault: false,
    reason: "The 2048px candidate reduced latency, but both resized runs lost the central n^2 pi^2 term and the two-vertical-line graph structure.",
  },
  samples: samples.map((sample) => ({
    id: sample.id,
    group: sample.group,
    warningCount: sample.report.result.warningCount,
    timingsMs: {
      providerToFirstOutput: sample.report.timingsMs.providerStartToFirstOutput,
      acceptToComplete: sample.report.timingsMs.acceptStartToComplete,
      fetchToHeaders: sample.report.httpTimingsMs.fetchCallToResponseHeaders,
      firstBodyChunkToFirstOutput: sample.report.httpTimingsMs.firstBodyChunkToFirstOutput,
    },
    qualitySignals: qualitySignals(sample.transcript),
  })),
};

fs.writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const palette = {
  background: "#f7f7f4",
  card: "#ffffff",
  border: "#deded8",
  text: "#20211f",
  muted: "#6e716c",
  green: "#16795a",
  red: "#a84d43",
};

function drawLabel(ctx, label, x, y, color = palette.text) {
  ctx.fillStyle = color;
  ctx.font = '600 24px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(label, x, y);
}

function drawCrop(ctx, image, crop, destination, label) {
  ctx.fillStyle = palette.card;
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(destination.x, destination.y, destination.w, destination.h, 10);
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(destination.x + 2, destination.y + 42, destination.w - 4, destination.h - 44, 8);
  ctx.clip();
  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    destination.x + 2,
    destination.y + 42,
    destination.w - 4,
    destination.h - 44,
  );
  ctx.restore();
  drawLabel(ctx, label, destination.x + 16, destination.y + 29);
}

async function createSourceComparison() {
  const [source, candidate] = await Promise.all([loadImage(sourcePath), loadImage(candidatePath)]);
  const canvas = createCanvas(1600, 1170);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawLabel(ctx, "人工检查 1：原图与 2048px 候选的关键细节", 40, 42);
  ctx.fillStyle = palette.muted;
  ctx.font = '18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText("请看公式中的 π²、spectral mapping 端点，以及示意图中竖线数量。两列使用相同显示尺寸。", 40, 74);

  const sourceCrops = [
    { x: 1160, y: 430, w: 2350, h: 560 },
    { x: 1120, y: 850, w: 2420, h: 1320 },
  ];
  const scaleX = candidate.width / source.width;
  const scaleY = candidate.height / source.height;
  const candidateCrops = sourceCrops.map((crop) => ({
    x: Math.round(crop.x * scaleX),
    y: Math.round(crop.y * scaleY),
    w: Math.round(crop.w * scaleX),
    h: Math.round(crop.h * scaleY),
  }));
  drawCrop(ctx, source, sourceCrops[0], { x: 40, y: 100, w: 740, h: 300 }, "原图 4096 x 3072");
  drawCrop(ctx, candidate, candidateCrops[0], { x: 820, y: 100, w: 740, h: 300 }, "候选 2048 x 1536");
  drawCrop(ctx, source, sourceCrops[1], { x: 40, y: 430, w: 740, h: 680 }, "原图 4096 x 3072");
  drawCrop(ctx, candidate, candidateCrops[1], { x: 820, y: 430, w: 740, h: 680 }, "候选 2048 x 1536");
  fs.writeFileSync(path.join(directory, "source-detail-comparison.png"), canvas.toBuffer("image/png"));
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const char of paragraph) {
      const next = line + char;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = char;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawTranscriptCard(ctx, sample, x, y, w, h) {
  ctx.fillStyle = palette.card;
  ctx.strokeStyle = sample.group === "original" ? palette.green : palette.red;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 12);
  ctx.fill();
  ctx.stroke();
  drawLabel(ctx, `${sample.group === "original" ? "原图" : "2048px"} · ${sample.id}`, x + 22, y + 36);
  ctx.fillStyle = palette.muted;
  ctx.font = '16px "Segoe UI", "Microsoft YaHei", sans-serif';
  const timing = sample.report.timingsMs.providerStartToFirstOutput / 1000;
  ctx.fillText(`首字 ${timing.toFixed(1)}s · warning ${sample.report.result.warningCount}`, x + 22, y + 64);
  ctx.fillStyle = palette.text;
  ctx.font = '17px "Cascadia Mono", Consolas, "Microsoft YaHei", monospace';
  const lines = wrapText(ctx, sample.transcript, w - 44);
  let cursorY = y + 100;
  for (const line of lines) {
    if (cursorY > y + h - 22) {
      ctx.fillStyle = palette.muted;
      ctx.fillText("…", x + 22, cursorY);
      break;
    }
    ctx.fillText(line, x + 22, cursorY);
    cursorY += 25;
  }
}

function createTranscriptComparison() {
  const canvas = createCanvas(1600, 1190);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawLabel(ctx, "人工检查 2：四次真实转写原文", 40, 42);
  ctx.fillStyle = palette.muted;
  ctx.font = '18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText("绿色边框为原图，红色边框为 2048px 候选。重点比较中间公式和图形描述，不必核对耗时。", 40, 74);
  const positions = [
    [40, 100],
    [820, 100],
    [40, 645],
    [820, 645],
  ];
  samples.forEach((sample, index) => drawTranscriptCard(ctx, sample, positions[index][0], positions[index][1], 740, 505));
  fs.writeFileSync(path.join(directory, "transcript-comparison.png"), canvas.toBuffer("image/png"));
}

await createSourceComparison();
createTranscriptComparison();
console.log(JSON.stringify(summary, null, 2));
