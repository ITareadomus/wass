import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const acceptHeader = req.headers.accept ?? "";
    if (req.method !== "GET") {
      return res.status(404).type("text/plain").send("Not found");
    }

    if (!acceptHeader.includes("text/html")) {
      return res.status(404).type("text/plain").send("Not found");
    }

    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({
        "Content-Type": "text/html",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

function resolveClientDistPath(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "public"),
    path.resolve(import.meta.dirname, "..", "dist", "public"),
    path.resolve(process.cwd(), "dist", "public"),
  ];
  const found = candidates.find((dir) =>
    fs.existsSync(path.join(dir, "index.html")),
  );
  if (!found) {
    throw new Error(
      `Could not find the build directory (looked in: ${candidates.join(", ")}), make sure to build the client first`,
    );
  }
  return found;
}

export function serveStatic(app: Express) {
  const distPath = resolveClientDistPath();
  log(`serving static files from ${distPath}`);

  app.use(
    express.static(distPath, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(`${path.sep}index.html`) || filePath.endsWith("/index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          return;
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes("/assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // Fall through to index.html only for browser navigations.
  // Missing JS/CSS/assets should return 404 instead of HTML.
  app.use("*", (req, res, next) => {
    const acceptHeader = req.headers.accept ?? "";
    if (req.method !== "GET") {
      return res.status(404).type("text/plain").send("Not found");
    }

    if (!acceptHeader.includes("text/html")) {
      return res.status(404).type("text/plain").send("Not found");
    }

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
