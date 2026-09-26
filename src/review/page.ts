import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewData } from "./data.js";

/** The package's assets folder, whether running from src/review (tests) or dist/src/review (built). */
function assetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "..", "..", "assets"), path.resolve(here, "..", "..", "..", "assets")];
  return candidates.find((c) => existsSync(path.join(c, "review.js"))) ?? (candidates[0] as string);
}

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

/**
 * JSON that is safe inside a <script> element: `<` is escaped so a layer
 * named "</script><script>…" stays data, and the two line separators are
 * escaped because older engines end a line on them.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** One self-contained HTML file: no network, no build step, opens anywhere. */
export function renderReviewPage(data: ReviewData): string {
  const dir = assetsDir();
  const css = readFileSync(path.join(dir, "review.css"), "utf8");
  const js = readFileSync(path.join(dir, "review.js"), "utf8");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(data.title)}</title>`,
    `<style>${css}</style>`,
    "</head>",
    "<body>",
    "<main></main>",
    `<script id="review-data" type="application/json">${embedJson(data)}</script>`,
    `<script>${js}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Write the page into its own folder (preview frames live beside it) and return its path. */
export function writeReviewPage(folder: string, data: ReviewData): string {
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "index.html");
  writeFileSync(file, renderReviewPage(data), "utf8");
  return file;
}
