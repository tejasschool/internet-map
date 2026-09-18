# Internet Map

An interactive web app that turns a starting URL into a visual domain/subdomain graph.

## Run

Requirements: Node.js 18+.

```bash
npm install
npm start
```

Then open http://localhost:3000

## What it does

- Enter a URL such as `youtube.com`.
- The server fetches the page and extracts linked web domains.
- Root domain, subdomains, and external domains are visually distinguished.
- Depth 0/1/2 controls how far the root domain's pages/subdomains are crawled.
- Drag nodes, zoom/pan, and click a node to inspect/open it.
- The backend limits the graph to 40 UI nodes by default and blocks common private/local IP ranges.

## Important limitation

This is a link/domain map, not a complete map of the entire Internet. A website can hide relationships behind APIs, JavaScript, authentication, robots rules, or pages that are not linked from the starting site. The graph is therefore a discovered neighborhood based on crawlable HTML.

For production deployment, add stronger SSRF protection, robots.txt handling, rate limiting, persistent caching, a proper public-suffix parser, and a background job queue.
