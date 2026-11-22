"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { releaseNotes, versionMismatches, bumpChangelog, setVersion, planBump, localDate } = require("../scripts/release");

const CHANGELOG = `# Changelog

## [Unreleased]

## [2.1.0] - 2026-11-22

### Changed

- The button toggles the whole message.

## [2.0.2] - 2026-11-04

- First release.
`;

test("the release notes are the version's changelog section, then the install steps", () => {
  assert.equal(
    releaseNotes(CHANGELOG, "2.1.0"),
    "### Changed\n\n- The button toggles the whole message.\n\n" +
      "## Install\n\n" +
      "Download `markdown-paste-2.1.0.xpi`, then in Thunderbird open **Tools > Add-ons and Themes > gear icon > " +
      "Install Add-on From File**. Remove any other Markdown paste add-on first, since both would intercept the paste.\n\n" +
      "The add-on is not signed by Mozilla and does not update automatically.\n",
  );
  assert.match(releaseNotes(CHANGELOG, "2.0.2"), /^- First release\.\n\n## Install/);
});

test("a version without a changelog section, or with an empty one, has no release notes", () => {
  assert.throws(() => releaseNotes(CHANGELOG, "9.9.9"), /no "## \[9\.9\.9\]" section in CHANGELOG\.md/);
  assert.throws(() => releaseNotes(CHANGELOG.replace("- First release.\n", ""), "2.0.2"), /section "## \[2\.0\.2\]" is empty/);
  // 2.1.0 must not match 2.1.00 or 12.1.0.
  assert.throws(() => releaseNotes("## [12.1.0] - x\n\n- a\n", "2.1.0"), /no "## \[2\.1\.0\]" section/);
});

test("every place that carries the version must match the tag", () => {
  const files = {
    manifest: { version: "2.1.0" },
    pkg: { version: "2.1.0" },
    lock: { version: "2.1.0", packages: { "": { version: "2.0.2" } } },
  };
  assert.deepEqual(Array.from(versionMismatches(files, "2.1.0")), ['package-lock.json packages[""]: 2.0.2']);
  files.lock.packages[""].version = "2.1.0";
  assert.deepEqual(Array.from(versionMismatches(files, "2.1.0")), []);
  assert.deepEqual(Array.from(versionMismatches(files, "2.2.0")), [
    "manifest.json: 2.1.0",
    "package.json: 2.1.0",
    "package-lock.json: 2.1.0",
    'package-lock.json packages[""]: 2.1.0',
  ]);
});

test("bumping opens a dated section with what was unreleased", () => {
  const before = "# Changelog\n\n## [Unreleased]\n\n- New thing.\n\n## [2.0.2] - 2026-11-04\n\n- Old.\n";
  assert.equal(
    bumpChangelog(before, "2.1.0", "2026-11-22"),
    "# Changelog\n\n## [Unreleased]\n\n## [2.1.0] - 2026-11-22\n\n- New thing.\n\n## [2.0.2] - 2026-11-04\n\n- Old.\n",
  );
});

test("bumping refuses an empty Unreleased section and an existing version", () => {
  assert.throws(() => bumpChangelog(CHANGELOG, "2.2.0", "2026-12-01"), /nothing under "## \[Unreleased\]"/);
  const withEntry = CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n- x\n");
  assert.throws(() => bumpChangelog(withEntry, "2.1.0", "2026-12-01"), /"## \[2\.1\.0\]" already exists/);
  assert.throws(() => bumpChangelog("# Changelog\n", "2.2.0", "2026-12-01"), /no "## \[Unreleased\]" section/);
});

test("setting the version touches only the first occurrences, formatting kept", () => {
  const lock = '{\n  "version": "2.0.2",\n  "packages": {\n    "": {\n      "version": "2.0.2"\n    },\n    "node_modules/x": {\n      "version": "2.0.2"\n    }\n  }\n}\n';
  assert.equal(
    setVersion(lock, "2.1.0", 2),
    '{\n  "version": "2.1.0",\n  "packages": {\n    "": {\n      "version": "2.1.0"\n    },\n    "node_modules/x": {\n      "version": "2.0.2"\n    }\n  }\n}\n',
  );
  assert.throws(() => setVersion('{ "name": "x" }', "2.1.0", 1), /expected 1 "version" field/);
});

test("a heading on the last line, without a final newline, has an empty section", () => {
  assert.throws(() => releaseNotes("# Changelog\n\n## [2.1.0] - x", "2.1.0"), /section "## \[2\.1\.0\]" is empty/);
  assert.throws(() => bumpChangelog("# Changelog\n\n## [Unreleased]", "2.1.0", "d"), /nothing under "## \[Unreleased\]"/);
});

test("a section stops at link reference definitions and at any level-two heading", () => {
  const text = "## [2.0.2] - d\n\n- Old.\n\n[2.0.2]: https://example.org/v2.0.2\n";
  assert.match(releaseNotes(text, "2.0.2"), /^- Old\.\n\n## Install/);
  assert.match(releaseNotes("## [2.0.2] - d\n\n- Old.\n\n## Notes\n\nother\n", "2.0.2"), /^- Old\.\n\n## Install/);
});

test("a bump is validated as a whole before any file is written", () => {
  const files = {
    "manifest.json": '{\n  "version": "2.0.2"\n}\n',
    "package.json": '{\n  "version": "2.0.2"\n}\n',
    "package-lock.json": '{\n  "version": "2.0.2",\n  "packages": {\n    "": {},\n    "node_modules/x": { "version": "1.0.0" }\n  }\n}\n',
    "CHANGELOG.md": "## [Unreleased]\n\n- New.\n",
  };
  assert.throws(() => planBump(files, "2.1.0", "2026-11-22"), /package-lock\.json packages\[""\]: undefined/);
  files["package-lock.json"] = '{\n  "version": "2.0.2",\n  "packages": {\n    "": { "version": "2.0.2" }\n  }\n}\n';
  const updates = planBump(files, "2.1.0", "2026-11-22");
  assert.equal(updates["CHANGELOG.md"], "## [Unreleased]\n\n## [2.1.0] - 2026-11-22\n\n- New.\n");
  assert.equal(updates["manifest.json"], '{\n  "version": "2.1.0"\n}\n');
});

test("the release date is the local calendar date", () => {
  assert.equal(localDate(new Date(2026, 10, 23, 0, 30)), "2026-11-23");
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
