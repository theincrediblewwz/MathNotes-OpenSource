import { normalizeMathForPortableMarkdown } from "../common/markdownMath";
import { analyzeFaithfulMarkdown, type FaithfulStructureBlock } from "./faithfulMarkdownAnalysis";
import { validateFaithfulTranscriptionOutput } from "./faithfulTranscriptionPrompt";

export type TranscriptionQualityScore = {
  content: {
    similarity: number;
    editDistance: number;
    goldLength: number;
  };
  formulas: {
    actualCount: number;
    goldCount: number;
    exactRate: number;
    withinOneErrorRate: number;
    withinTwoErrorsRate: number;
    withinThreeErrorsRate: number;
    tokenErrorCount: number;
    tokenErrorRate: number;
  };
  structure: {
    sequenceExact: boolean;
    lcsRatio: number;
    actual: string[];
    gold: string[];
  };
  renderability: {
    validFormulaCount: number;
    invalidFormulaCount: number;
  };
  markers: {
    unreadableDelta: number;
    uncertainDelta: number;
    imageDescriptionDelta: number;
  };
  warnings: string[];
};

export function scoreFaithfulTranscription(actualMarkdown: string, goldMarkdown: string): TranscriptionQualityScore {
  const actualNormalized = normalizeForContentComparison(actualMarkdown);
  const goldNormalized = normalizeForContentComparison(goldMarkdown);
  const contentDistance = levenshtein([...actualNormalized], [...goldNormalized]);
  const contentDenominator = Math.max(actualNormalized.length, goldNormalized.length, 1);
  const actualAnalysis = analyzeFaithfulMarkdown(actualMarkdown);
  const goldAnalysis = analyzeFaithfulMarkdown(goldMarkdown);
  const actualFormulaTokens = actualAnalysis.formulas.flatMap((formula) => tokenizeFormula(formula.content));
  const goldFormulaGroups = goldAnalysis.formulas.map((formula) => tokenizeFormula(formula.content));
  const formulaDistances = alignFormulaTokenStream(actualFormulaTokens, goldFormulaGroups);
  const goldTokenCount = goldFormulaGroups.reduce((sum, tokens) => sum + tokens.length, 0);
  const formulaDenominator = Math.max(formulaDistances.length, 1);
  const tokenErrorCount = formulaDistances.reduce((sum, distance) => sum + distance, 0);
  const actualStructure = actualAnalysis.structureTokens;
  const goldStructure = goldAnalysis.structureTokens;
  const structureOrder = scoreStructureOrder(actualAnalysis.structureBlocks, goldAnalysis.structureBlocks);
  const validFormulaCount = actualAnalysis.formulas.filter((formula) => formula.validKatex).length;

  return {
    content: {
      similarity: clamp01(1 - contentDistance / contentDenominator),
      editDistance: contentDistance,
      goldLength: goldNormalized.length
    },
    formulas: {
      actualCount: actualAnalysis.formulas.length,
      goldCount: goldAnalysis.formulas.length,
      exactRate: rateWithin(formulaDistances, 0, formulaDenominator),
      withinOneErrorRate: rateWithin(formulaDistances, 1, formulaDenominator),
      withinTwoErrorsRate: rateWithin(formulaDistances, 2, formulaDenominator),
      withinThreeErrorsRate: rateWithin(formulaDistances, 3, formulaDenominator),
      tokenErrorCount,
      tokenErrorRate: goldTokenCount === 0 ? (tokenErrorCount === 0 ? 0 : 1) : tokenErrorCount / goldTokenCount
    },
    structure: {
      sequenceExact: structureOrder.sequenceExact,
      lcsRatio: structureOrder.lcsRatio,
      actual: [...actualStructure],
      gold: [...goldStructure]
    },
    renderability: {
      validFormulaCount,
      invalidFormulaCount: actualAnalysis.formulas.length - validFormulaCount
    },
    markers: {
      unreadableDelta: actualAnalysis.markers.unreadable - goldAnalysis.markers.unreadable,
      uncertainDelta: actualAnalysis.markers.uncertain - goldAnalysis.markers.uncertain,
      imageDescriptionDelta: actualAnalysis.markers.imageDescription - goldAnalysis.markers.imageDescription
    },
    warnings: validateFaithfulTranscriptionOutput(actualMarkdown)
  };
}

function normalizeForContentComparison(markdown: string): string {
  return normalizeMathForPortableMarkdown(markdown)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tokenizeFormula(formula: string): string[] {
  const ignoredSpacing = new Set(["\\quad", "\\qquad", "\\,", "\\;", "\\!", "\\:"]);
  return (formula.match(/\\[A-Za-z]+|\\.|[A-Za-z]+|\d+(?:\.\d+)?|[^\s]/g) ?? [])
    .filter((token) => !ignoredSpacing.has(token));
}

function alignFormulaTokenStream(actualTokens: string[], goldGroups: string[][]): number[] {
  if (goldGroups.length === 0) {
    return actualTokens.length === 0 ? [] : [actualTokens.length];
  }

  const groupCount = goldGroups.length;
  const tokenCount = actualTokens.length;
  const costs = Array.from({ length: groupCount + 1 }, () => Array<number>(tokenCount + 1).fill(Infinity));
  const previousBoundaries = Array.from(
    { length: groupCount + 1 },
    () => Array<number>(tokenCount + 1).fill(-1)
  );
  costs[0][0] = 0;

  for (let groupIndex = 1; groupIndex <= groupCount; groupIndex += 1) {
    for (let end = 0; end <= tokenCount; end += 1) {
      for (let start = 0; start <= end; start += 1) {
        if (!Number.isFinite(costs[groupIndex - 1][start])) continue;
        const distance = levenshtein(actualTokens.slice(start, end), goldGroups[groupIndex - 1]);
        const total = costs[groupIndex - 1][start] + distance;
        if (total < costs[groupIndex][end]) {
          costs[groupIndex][end] = total;
          previousBoundaries[groupIndex][end] = start;
        }
      }
    }
  }

  const distances = Array<number>(groupCount).fill(0);
  let end = tokenCount;
  for (let groupIndex = groupCount; groupIndex >= 1; groupIndex -= 1) {
    const start = previousBoundaries[groupIndex][end];
    const safeStart = start < 0 ? 0 : start;
    distances[groupIndex - 1] = levenshtein(actualTokens.slice(safeStart, end), goldGroups[groupIndex - 1]);
    end = safeStart;
  }
  return distances;
}

function rateWithin(distances: number[], threshold: number, denominator: number): number {
  if (distances.length === 0) return 1;
  return distances.filter((distance) => distance <= threshold).length / denominator;
}

function scoreStructureOrder(
  actualBlocks: FaithfulStructureBlock[],
  goldBlocks: FaithfulStructureBlock[]
): { sequenceExact: boolean; lcsRatio: number } {
  const usedGoldIndices = new Set<number>();
  const mappedGoldIndices = actualBlocks.map((actualBlock) => {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let goldIndex = 0; goldIndex < goldBlocks.length; goldIndex += 1) {
      if (usedGoldIndices.has(goldIndex) || goldBlocks[goldIndex].type !== actualBlock.type) continue;
      const distance = structureContentDistance(actualBlock.content, goldBlocks[goldIndex].content);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = goldIndex;
      }
    }
    if (bestIndex >= 0) usedGoldIndices.add(bestIndex);
    return bestIndex;
  });
  const expectedOrder = goldBlocks.map((_, index) => index);
  const matchedOrder = mappedGoldIndices.filter((index) => index >= 0);
  const denominator = Math.max(actualBlocks.length, goldBlocks.length, 1);
  return {
    sequenceExact: actualBlocks.length === goldBlocks.length &&
      mappedGoldIndices.every((goldIndex, actualIndex) => goldIndex === actualIndex),
    lcsRatio: longestCommonSubsequenceLength(matchedOrder, expectedOrder) / denominator
  };
}

function structureContentDistance(left: string, right: string): number {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return levenshtein([...normalize(left)], [...normalize(right)]);
}

function levenshtein<T>(left: T[], right: T[]): number {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function longestCommonSubsequenceLength<T>(left: T[], right: T[]): number {
  const rows = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      rows[leftIndex][rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? rows[leftIndex - 1][rightIndex - 1] + 1
        : Math.max(rows[leftIndex - 1][rightIndex], rows[leftIndex][rightIndex - 1]);
    }
  }
  return rows[left.length][right.length];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
