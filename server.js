const express = require("express");
const cheerio = require("cheerio");
const dns = require("node:dns").promises;
const net = require("node:net");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const MAX_NODES = 60;
const MAX_FETCHES = 90;
const REQUEST_TIMEOUT = 8000;
const USER_AGENT = "InternetMap/1.0 (+local visualization tool)";

function normalizeUrl(value) {
  let input = String(value || "").trim();
  if (!input) throw new Error("Enter a URL.");

  if (!/^https?:\/\//i.test(input)) input = "https://" + input;

  const u = new URL(input);
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  u.hash = "";
  u.username = "";
  u.password = "";
  return u;
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:")
  );
}

async function hostIsPublic(hostname) {
  // Block obvious local names.
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) return false;

  if (net.isIP(hostname)) {
    return net.isIP(hostname) === 4
      ? !isPrivateIPv4(hostname)
      : !isPrivateIPv6(hostname);
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true });
    return addresses.length > 0 && addresses.every(({ address, family }) =>
      family === 4 ? !isPrivateIPv4(address) : !isPrivateIPv6(address)
    );
  } catch {
    return false;
  }
}

function registrableApprox(host) {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  // Good approximation for common domains. This is deliberately dependency-free.
  const common2LevelTlds = new Set([
    "co.uk","org.uk","ac.uk","gov.uk","com.au","net.au","org.au",
    "co.in","com.br","co.jp","co.nz","co.za"
  ]);
  const last2 = labels.slice(-2).join(".");
  return common2LevelTlds.has(last2)
    ? labels.slice(-3).join(".")
    : labels.slice(-2).join(".");
}

function domainKind(host, rootHost) {
  if (host === rootHost) return "root";
  if (host.endsWith("." + rootHost)) return "subdomain";
  return "external";
}

function nodeFor(url, rootHost) {
  const host = url.hostname.toLowerCase();
  return {
    id: host,
    label: host,
    host,
    kind: domainKind(host, rootHost),
    url: `${url.protocol}//${host}/`,
    title: host
  };
}

function edgeFor(a, b, relation) {
  return {
    id: `${a}->${b}`,
    source: a,
    target: b,
    relation
  };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.7"
      },
      redirect: "follow",
      signal: controller.signal
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/html")) return null;

    const text = await response.text();
    return {
      finalUrl: new URL(response.url),
      html: text.slice(0, 2_000_000),
      status: response.status
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function crawl(startUrl, depthLimit, maxNodes) {
  const rootHost = startUrl.hostname.toLowerCase();
  const nodes = new Map();
  const edges = new Map();
  const queue = [{ url: startUrl, depth: 0 }];
  const visitedPages = new Set();
  let fetches = 0;

  const addNode = (url) => {
    const node = nodeFor(url, rootHost);
    if (!nodes.has(node.id) && nodes.size < maxNodes) nodes.set(node.id, node);
    return nodes.get(node.id);
  };

  addNode(startUrl);

  while (queue.length && nodes.size < maxNodes && fetches < MAX_FETCHES) {
    const current = queue.shift();
    const pageKey = current.url.href.split("#")[0];
    if (visitedPages.has(pageKey)) continue;
    visitedPages.add(pageKey);

    if (current.depth > depthLimit) continue;
    if (!(await hostIsPublic(current.url.hostname))) continue;

    fetches++;
    const result = await fetchHtml(current.url);
    if (!result) continue;

    const finalUrl = result.finalUrl;
    const currentNode = addNode(finalUrl);
    if (!currentNode) continue;

    const $ = cheerio.load(result.html);
    const pageTitle = $("title").first().text().trim();
    if (pageTitle) currentNode.title = pageTitle.slice(0, 120);

    const discovered = new Map();

    $("a[href], link[href], script[src], img[src]").each((_, el) => {
      const raw = $(el).attr("href") || $(el).attr("src");
      if (!raw) return;
      try {
        const target = new URL(raw, finalUrl);
        if (!["http:", "https:"].includes(target.protocol)) return;
        target.hash = "";
        target.username = "";
        target.password = "";

        const host = target.hostname.toLowerCase();
        if (!host || host === "www." + host) return;

        // Keep the map about web domains, not individual asset URLs.
        const domainUrl = new URL(`${target.protocol}//${host}/`);
        discovered.set(host, domainUrl);
      } catch {}
    });

    for (const [host, targetUrl] of discovered) {
      if (nodes.size >= maxNodes) break;
      if (!(await hostIsPublic(host))) continue;

      const targetNode = addNode(targetUrl);
      if (!targetNode) continue;

      const relation = host === finalUrl.hostname.toLowerCase()
        ? "same-domain"
        : domainKind(host, rootHost) === "subdomain"
          ? "subdomain"
          : "external";

      if (currentNode.id !== targetNode.id) {
        const edge = edgeFor(currentNode.id, targetNode.id, relation);
        edges.set(edge.id, edge);
      }

      // Crawl root-domain pages and discovered subdomains. External domains are
      // represented on the map but not recursively crawled by default.
      const crawlable =
        current.depth < depthLimit &&
        (host === rootHost || host.endsWith("." + rootHost));

      if (crawlable && !visitedPages.has(targetUrl.href)) {
        queue.push({ url: targetUrl, depth: current.depth + 1 });
      }
    }
  }

  return {
    root: rootHost,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    stats: {
      domains: nodes.size,
      connections: edges.size,
      pagesFetched: fetches,
      depth: depthLimit
    }
  };
}

app.post("/api/map", async (req, res) => {
  try {
    const url = normalizeUrl(req.body.url);
    const depth = Math.max(0, Math.min(2, Number(req.body.depth ?? 1)));
    const maxNodes = Math.max(10, Math.min(MAX_NODES, Number(req.body.maxNodes ?? 40)));

    const result = await crawl(url, depth, maxNodes);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not create map." });
  }
});

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Internet Map running at http://localhost:${PORT}`);
});