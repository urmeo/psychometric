const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONTENT_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

module.exports = async function serveApplication() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const target = path.resolve(ROOT, "." + (pathname === "/" ? "/index.html" : pathname));
      if (!target.startsWith(ROOT + path.sep)) throw new Error("Invalid path");
      const bytes = await fs.readFile(target);
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(target)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
};
