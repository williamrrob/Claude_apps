"use strict";
/*
 * version-lib.js — the two cache-busting mechanisms (see bump-version.js's
 * header for the full explanation), as plain functions so other scripts
 * (word.js) can bump DATA_V automatically instead of shelling out.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const APP = path.join(ROOT, "app.js");

const TAG_TARGETS = { styles: "styles.css", app: "app.js", engine: "engine.js", data: "data.js" };

function bumpTag(filename) {
  let html = fs.readFileSync(INDEX, "utf8");
  const re = new RegExp("(" + filename.replace(".", "\\.") + "\\?v=)(\\d+)");
  const m = html.match(re);
  if (!m) return null;
  const next = String(Number(m[2]) + 1);
  html = html.replace(re, "$1" + next);
  fs.writeFileSync(INDEX, html);
  return { from: m[2], to: next };
}

function bumpDataV() {
  let src = fs.readFileSync(APP, "utf8");
  const re = /(const DATA_V = ")(\d+)(";)/;
  const m = src.match(re);
  if (!m) return null;
  const next = String(Number(m[2]) + 1);
  src = src.replace(re, "$1" + next + "$3");
  fs.writeFileSync(APP, src);
  return { from: m[2], to: next };
}

module.exports = { bumpTag, bumpDataV, TAG_TARGETS };
