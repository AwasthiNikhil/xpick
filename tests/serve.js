// Serves tests/fixtures on http://127.0.0.1:4173 (extensions can't script file:// pages by default).
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "fixtures");
http
  .createServer((req, res) => {
    const file = path.join(root, path.normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
  })
  .listen(4173, "127.0.0.1");
