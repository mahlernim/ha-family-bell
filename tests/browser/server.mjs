import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const files = {
  "/": resolve("tests/browser/fixture.html"),
  "/fixture.js": resolve("tests/browser/fixture.js"),
  ...Object.fromEntries(["ha-family-bell-panel.js", "panel-model.js", "panel.css"].map(name => ["/" + name, resolve("custom_components/ha_family_bell/frontend", name)])),
};
createServer(async (request, response) => {
  const file = files[new URL(request.url, "http://localhost").pathname];
  if (!file) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(file)]);
    response.end(await readFile(file));
  } catch { response.writeHead(500).end(); }
}).listen(8792, "127.0.0.1");
