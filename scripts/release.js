#!/usr/bin/env node
/*
 * Release helpers, from CHANGELOG.md and the three files that carry the version.
 *
 *   node scripts/release.js bump 2.1.0   dates the Unreleased section, sets the version
 *   node scripts/release.js check v2.1.0 fails unless every version matches the tag
 *   node scripts/release.js notes 2.1.0  prints the GitHub release text
 *
 * The tag itself is created and signed by hand: GitHub cannot sign it.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const VERSION = /^\d+\.\d+\.\d+$/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The heading of a version's section, anchored so 2.1.0 never matches 12.1.0.
const heading = (version) => new RegExp(`^## \\[${escape(version)}\\]`, "m");

function installSteps(version) {
  return (
    "## Install\n\n" +
    `Download \`markdown-paste-${version}.xpi\`, then in Thunderbird open **Tools > Add-ons and Themes > gear icon > ` +
    "Install Add-on From File**. Remove any other Markdown paste add-on first, since both would intercept the paste.\n\n" +
    "The add-on is not signed by Mozilla and does not update automatically.\n"
  );
}

// The body of a section: from after its heading to the next level-two heading
// or the link reference definitions that close a Keep a Changelog file.
function sectionBody(changelog, match) {
  const eol = changelog.indexOf("\n", match.index);
  const start = eol < 0 ? changelog.length : eol + 1;
  const next = changelog.slice(start).search(/^(## |\[[^\]]+\]: )/m);
  return (next < 0 ? changelog.slice(start) : changelog.slice(start, start + next)).trim();
}

function releaseNotes(changelog, version) {
  const match = heading(version).exec(changelog);
  if (!match) {
    throw new Error(`no "## [${version}]" section in CHANGELOG.md`);
  }
  const body = sectionBody(changelog, match);
  if (!body) {
    throw new Error(`section "## [${version}]" is empty in CHANGELOG.md`);
  }
  return `${body}\n\n${installSteps(version)}`;
}

function versionMismatches({ manifest, pkg, lock }, version) {
  return [
    ["manifest.json", manifest.version],
    ["package.json", pkg.version],
    ["package-lock.json", lock.version],
    ['package-lock.json packages[""]', lock.packages?.[""]?.version],
  ]
    .filter(([, found]) => found !== version)
    .map(([file, found]) => `${file}: ${found}`);
}

function bumpChangelog(changelog, version, date) {
  const match = /^## \[Unreleased\][^\n]*$/m.exec(changelog);
  if (!match) {
    throw new Error('no "## [Unreleased]" section in CHANGELOG.md');
  }
  if (heading(version).test(changelog)) {
    throw new Error(`"## [${version}]" already exists in CHANGELOG.md`);
  }
  if (!sectionBody(changelog, match)) {
    throw new Error('nothing under "## [Unreleased]" in CHANGELOG.md: nothing to release');
  }
  const end = match.index + match[0].length;
  return `${changelog.slice(0, end)}\n\n## [${version}] - ${date}${changelog.slice(end)}`;
}

// Replaces the first count "version" fields, leaving the file's layout alone.
function setVersion(text, version, count) {
  let seen = 0;
  const result = text.replace(/"version": "[^"]*"/g, (field) => (++seen <= count ? `"version": "${version}"` : field));
  if (seen < count) {
    throw new Error(`expected ${count} "version" field(s), found ${seen}`);
  }
  return result;
}

// Every file of a bump, computed and checked before anything is written, so a
// refusal leaves the repository as it was.
function planBump(files, version, date) {
  const updates = {
    "manifest.json": setVersion(files["manifest.json"], version, 1),
    "package.json": setVersion(files["package.json"], version, 1),
    "package-lock.json": setVersion(files["package-lock.json"], version, 2),
    "CHANGELOG.md": bumpChangelog(files["CHANGELOG.md"], version, date),
  };
  const mismatches = versionMismatches(
    {
      manifest: JSON.parse(updates["manifest.json"]),
      pkg: JSON.parse(updates["package.json"]),
      lock: JSON.parse(updates["package-lock.json"]),
    },
    version,
  );
  if (mismatches.length) {
    throw new Error(`the bump would leave mismatches, nothing written:\n  ${mismatches.join("\n  ")}`);
  }
  return updates;
}

// The maintainer's calendar date, not UTC's: a release at 00:30 in France is
// dated that day.
function localDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const write = (file, text) => fs.writeFileSync(path.join(ROOT, file), text);
const readJson = (file) => JSON.parse(read(file));

function versionFiles() {
  return { manifest: readJson("manifest.json"), pkg: readJson("package.json"), lock: readJson("package-lock.json") };
}

function main([command, argument = ""]) {
  const version = argument.replace(/^v/, "");
  if (!["bump", "check", "notes"].includes(command)) {
    throw new Error("usage: release.js bump|check|notes X.Y.Z");
  }
  if (!VERSION.test(version)) {
    throw new Error(`"${argument}" is not a X.Y.Z version: pre-releases and other forms are not supported`);
  }
  if (command === "notes") {
    process.stdout.write(releaseNotes(read("CHANGELOG.md"), version));
  } else if (command === "check") {
    const mismatches = versionMismatches(versionFiles(), version);
    if (mismatches.length) {
      throw new Error(`version ${version} expected, found:\n  ${mismatches.join("\n  ")}`);
    }
    releaseNotes(read("CHANGELOG.md"), version);
    console.log(`${version}: versions and changelog match`);
  } else {
    const files = Object.fromEntries(
      ["manifest.json", "package.json", "package-lock.json", "CHANGELOG.md"].map((file) => [file, read(file)]),
    );
    const updates = planBump(files, version, localDate(new Date()));
    Object.entries(updates).forEach(([file, text]) => write(file, text));
    console.log(`${version}: manifest.json, package.json, package-lock.json and CHANGELOG.md updated`);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { releaseNotes, versionMismatches, bumpChangelog, setVersion, planBump, localDate };
