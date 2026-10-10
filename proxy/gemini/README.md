# Analysis proxy (Gemini)

The Analysis panel reads each lot the site shows, and answers questions about it, with Google's
Gemini: one request per lot viewed, plus one per question. A Gemini API key must stay
secret: one shipped in the site's JavaScript can be copied by anyone and used on your account, and
Google blocks keys it finds exposed. This Cloudflare Worker holds the key and makes the calls. It
is the second server-side piece of VanShade, after the LidarBC proxy; the sun and shade are still
worked out entirely in the browser.

What it does, and nothing more:

- `POST /chat` (and its `OPTIONS` preflight) only; everything else is a 404.
- Takes `{ context, turns }`: the lot in a few plain lines (`src/insight.ts`) and the conversation,
  alternating `user` / `model` and ending with the new question. At most 9 turns, 2,000 characters
  a question, 8,000 for the lot, 64 KB in all; anything else is a 400.
- Writes the advisor's instructions itself (stay on this lot's sun and shade, plain text), always
  uses the same model (`gemini-3.8-flash`, low thinking) and caps each answer at 2,048 tokens.
- Streams the answer back as server-sent events: `{"text": "…"}` as it arrives, then
  `{"done": true}`, or `{"error": "busy" | "limit" | "failed"}`. Errors before the stream starts
  are the same JSON with a 4xx/5xx status.
- Answers only the origins in `ALLOWED_ORIGINS` (wrangler.toml: vanshade.ca, www and local dev
  servers); other browsers, and requests without an `Origin`, get a 403.
- At most 10 questions a minute from one IP address (Cloudflare's rate-limiting binding).
- Retries Gemini's "busy" replies (429, 503) twice, a second or two apart. Gemini's own error
  messages are logged (`npx wrangler tail`), never passed to the browser.

## Deploy (free Cloudflare account)

```sh
cd proxy/gemini
npx wrangler login
npx wrangler deploy                       # prints https://vanshade-gemini.<your-subdomain>.workers.dev
npx wrangler secret put GEMINI_API_KEY    # paste the key from Google AI Studio when asked
```

Then point the site at it: GitHub → repository Settings → Secrets and variables → Actions →
Variables → `VITE_GEMINI_PROXY` = that URL (no trailing slash), and re-run the deploy workflow.
Until the variable is set, the site has no Analysis panel.

In Google AI Studio, keep the key limited to the Gemini API and set a spending limit or budget
alert on its project. Replacing the key later is only `wrangler secret put` again: no rebuild.

Check it (needs one of the allowed origins):

```sh
curl -sN https://vanshade-gemini.<your-subdomain>.workers.dev/chat \
  -H 'Origin: https://vanshade.ca' -H 'Content-Type: application/json' \
  -d '{"context":"Address: a test lot","turns":[{"role":"user","text":"Say hello in five words."}]}'
# data: {"text":"…"}  …  data: {"done":true}
```

## Local testing

The dev server uses the deployed Worker (localhost ports 5173, 5180 and 4173 are allowed):
`VITE_GEMINI_PROXY=https://vanshade-gemini.<your-subdomain>.workers.dev npm run dev`.
`tests/geminiProxy.test.ts` covers the Worker itself with Gemini stubbed.
