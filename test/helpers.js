"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = [
  "vendor/marked.umd.js",
  "vendor/purify.min.js",
  "vendor/highlight.min.js",
  "src/render.js",
];

// Loads the same scripts, in the same order, as the compose_scripts manifest key.
function loadRenderer() {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  for (const file of SCRIPTS) {
    dom.window.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  }
  return dom.window;
}

// Parses rendered HTML so assertions read the DOM rather than attribute order.
function parse(window, html) {
  return new window.DOMParser().parseFromString(html, "text/html").body;
}

module.exports = { ROOT, SCRIPTS, loadRenderer, parse };
