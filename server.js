/**
 * Happy Trucker AI Navigator - AI Proxy Server (OpenAI + Anthropic)
 *
 * This server proxies AI requests from the app, keeping the
 * API keys secure on the server (never in the app).
 *
 * Deploy: Railway, Render, Fly.io, Google Cloud Run, or any Node.js host.
 *
 * Environment variables:
 *   OPENAI_API_KEY - Your OpenAI API key (optional if only using Anthropic)
 *   ANTHROPIC_API_KEY - Your Anthropic API key (optional if only using OpenAI)
 *   APP_SECRET     - Shared secret the app must send as X-App-Secret (required).
 *                    Generate one (e.g. `openssl rand -hex 32`) and put the same
 *                    value in the app's local.properties as PROXY_APP_SECRET.
 *   DAILY_BUDGET_USD - Max spend per day (default: 5.00)
 *   PORT - Server port (default: 3000)
 *
 * Cost controls:
 *   - App-secret auth so only the real app can use the endpoint.
 *   - Models are forced server-side (clients cannot pick pricier models):
 *       OpenAI    -> gpt-4o-mini
 *       Anthropic -> claude-haiku-4-5
 *   - Daily spend cap ($5 default).
 *   - Per-IP rate limit as a second line of defense if the secret leaks.
 */

const express = require('express');
const app = express();
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const APP_SECRET = process.env.APP_SECRET || '';
const DAILY_BUDGET = parseFloat(process.env.DAILY_BUDGET_USD || '5.00');
const PORT = process.env.PORT || 3000;

if (!APP_SECRET) {
    console.error('FATAL: APP_SECRET is not set. Refusing to start without app authentication.');
    process.exit(1);
}

// Simple in-memory usage tracking (use Redis for production)
let dailyUsage = { date: new Date().toDateString(), cost: 0 };

// Per-IP rate limiting: 200 requests/hour is far above any driver's usage,
// but stops a leaked secret from being hammered.
const HOURLY_LIMIT = 200;
const ipBuckets = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    let b = ipBuckets.get(ip);
    if (!b || now - b.windowStart > 3600_000) {
        b = { windowStart: now, count: 0 };
        ipBuckets.set(ip, b);
    }
    b.count++;
    return b.count <= HOURLY_LIMIT;
}

// gpt-4o-mini pricing: $0.15 / 1M input tokens, $0.60 / 1M output tokens
const INPUT_COST_PER_1K = 0.00015;
const OUTPUT_COST_PER_1K = 0.0006;
// claude-haiku-4-5 pricing: $0.80 / 1M input tokens, $4.00 / 1M output tokens
const ANTHROPIC_INPUT_COST_PER_1K = 0.0008;
const ANTHROPIC_OUTPUT_COST_PER_1K = 0.004;

function checkBudget() {
    const today = new Date().toDateString();
    if (dailyUsage.date !== today) {
        dailyUsage = { date: today, cost: 0 };
    }
    return dailyUsage.cost < DAILY_BUDGET;
}

app.post('/v1/chat/completions', async (req, res) => {
    // App authentication
    if (req.get('X-App-Secret') !== APP_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Rate limit
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }

    // Budget check
    if (!checkBudget()) {
        return res.status(429).json({
            error: 'Daily budget exceeded. Try again tomorrow.'
        });
    }

    if (!OPENAI_KEY) {
        return res.status(500).json({ error: 'Server misconfigured' });
    }

    try {
        // Force the cheap model server-side; clients cannot pick pricier ones.
        const body = { ...(req.body || {}), model: 'gpt-4o-mini' };

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_KEY}`
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        // Track usage
        if (data.usage) {
            const inputCost = (data.usage.prompt_tokens / 1000) * INPUT_COST_PER_1K;
            const outputCost = (data.usage.completion_tokens / 1000) * OUTPUT_COST_PER_1K;
            dailyUsage.cost += inputCost + outputCost;
            console.log(`Usage: $${dailyUsage.cost.toFixed(4)} / $${DAILY_BUDGET}`);
        }

        res.status(response.status).json(data);
    } catch (e) {
        console.error('Proxy error:', e.message);
        res.status(502).json({ error: 'Upstream error' });
    }
});

// Anthropic Messages API proxy (Muse).
// Same protections as the OpenAI endpoint: app-secret auth, per-IP rate
// limit, daily budget cap. Model is forced to claude-haiku-4-5 server-side.
app.post('/v1/messages', async (req, res) => {
    // App authentication
    if (req.get('X-App-Secret') !== APP_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Rate limit
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }

    // Budget check
    if (!checkBudget()) {
        return res.status(429).json({
            error: 'Daily budget exceeded. Try again tomorrow.'
        });
    }

    if (!ANTHROPIC_KEY) {
        return res.status(500).json({ error: 'Server misconfigured' });
    }

    try {
        // Force the cheap model server-side; clients cannot pick pricier ones.
        // Anthropic requires max_tokens; default to 1024 if the client omits it.
        const body = {
            ...(req.body || {}),
            model: 'claude-haiku-4-5',
            max_tokens: (req.body && req.body.max_tokens) || 1024
        };

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        // Track usage
        if (data.usage) {
            const inputCost = (data.usage.input_tokens / 1000) * ANTHROPIC_INPUT_COST_PER_1K;
            const outputCost = (data.usage.output_tokens / 1000) * ANTHROPIC_OUTPUT_COST_PER_1K;
            dailyUsage.cost += inputCost + outputCost;
            console.log(`Usage: $${dailyUsage.cost.toFixed(4)} / $${DAILY_BUDGET}`);
        }

        res.status(response.status).json(data);
    } catch (e) {
        console.error('Proxy error:', e.message);
        res.status(502).json({ error: 'Upstream error' });
    }
});

// OpenAI Realtime session mint (Phase 1: ChatGPT in-app voice sheet).
// The app calls this with X-App-Secret; the server mints a short-lived
// ephemeral client secret via the OpenAI Realtime API (the server key
// never leaves the server). The app then opens a WebSocket to
// wss://api.openai.com/v1/realtime?model=<model> with the ephemeral key.
// Same protections as the other endpoints: app-secret auth, per-IP rate
// limit, shared daily budget. Model is forced to gpt-realtime server-side.
// Cost guard: realtime audio is per-minute metered, so minting a session
// reserves the estimated worst-case cost of one full-length session
// (REALTIME_SESSION_RESERVE_USD) against the daily budget. If the
// account has no Realtime access, the account error is passed through
// so the app can report it honestly instead of failing silently.
const REALTIME_SESSION_RESERVE_USD = 0.50;

app.post('/v1/realtime/session', async (req, res) => {
    // App authentication
    if (req.get('X-App-Secret') !== APP_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Rate limit
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }

    // Budget check
    if (!checkBudget()) {
        return res.status(429).json({
            error: 'Daily budget exceeded. Try again tomorrow.'
        });
    }

    if (!OPENAI_KEY) {
        return res.status(500).json({ error: 'Server misconfigured' });
    }

    try {
        const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            },
            body: JSON.stringify({ model: 'gpt-realtime', voice: 'alloy' })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Realtime mint refused:', response.status,
                (data.error && data.error.message) || '');
            return res.status(response.status).json({
                error: (data.error && data.error.message) || 'Realtime unavailable'
            });
        }

        // Reserve worst-case cost of one full session (shared budget).
        dailyUsage.cost += REALTIME_SESSION_RESERVE_USD;
        console.log(`Realtime session minted (+$${REALTIME_SESSION_RESERVE_USD.toFixed(2)} reserved). ` +
            `Usage: $${dailyUsage.cost.toFixed(4)} / $${DAILY_BUDGET}`);

        res.json({
            model: data.model || 'gpt-realtime',
            client_secret: data.client_secret, // { value, expires_at }
            voice: 'alloy'
        });
    } catch (e) {
        console.error('Realtime mint error:', e.message);
        res.status(502).json({ error: 'Upstream error' });
    }
});

// Gemini Live ephemeral token mint (Phase 2: Gemini in-app voice sheet).
// The app calls this with X-App-Secret; the server mints a short-lived
// ephemeral token via Google's auth_tokens API (the server's Google AI key
// never leaves the server). The app then connects the Live API WebSocket
// with the token as `access_token` (Google's documented ephemeral-token
// auth for the Live API). Same protections as the other endpoints:
// app-secret auth, per-IP rate limit, shared daily budget.
// Cost guard: like the OpenAI realtime mint, a worst-case session cost is
// reserved at mint time (REALTIME_SESSION_RESERVE_USD).
// Honesty: the exact `liveConnectConstraints` field must be confirmed
// against Google's current auth_tokens docs when this is first exercised;
// if Google rejects the shape, the account error is passed through so the
// app reports it instead of failing silently.
const GOOGLE_AI_KEY = process.env.GOOGLE_AI_KEY;

app.post('/v1/live/session', async (req, res) => {
    // App authentication
    if (req.get('X-App-Secret') !== APP_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Rate limit
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }

    // Budget check
    if (!checkBudget()) {
        return res.status(429).json({
            error: 'Daily budget exceeded. Try again tomorrow.'
        });
    }

    if (!GOOGLE_AI_KEY) {
        return res.status(500).json({ error: 'Server misconfigured: GOOGLE_AI_KEY not set' });
    }

    try {
        const now = Date.now();
        const body = {
            uses: 1,
            expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
            newSessionExpireTime: new Date(now + 30 * 60 * 1000).toISOString(),
            liveConnectConstraints: { model: 'models/gemini-2.0-flash-live-001' }
        };

        const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/auth_tokens',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': GOOGLE_AI_KEY
                },
                body: JSON.stringify(body)
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error('Live token mint refused:', response.status,
                (data.error && data.error.message) || '');
            return res.status(response.status).json({
                error: (data.error && data.error.message) || 'Live token unavailable'
            });
        }

        // Reserve worst-case cost of one full session (shared budget).
        dailyUsage.cost += REALTIME_SESSION_RESERVE_USD;
        console.log(`Gemini live token minted (+$${REALTIME_SESSION_RESERVE_USD.toFixed(2)} reserved). ` +
            `Usage: $${dailyUsage.cost.toFixed(4)} / $${DAILY_BUDGET}`);

        res.json({
            token: data.token,
            model: 'models/gemini-2.0-flash-live-001'
        });
    } catch (e) {
        console.error('Live token mint error:', e.message);
        res.status(502).json({ error: 'Upstream error' });
    }
});

// Weigh-station status extension point (v99).
// HONEST STUB: there is no free public real-time open/closed feed for US/CA
// weigh stations (researched 2026-10-04). This endpoint exists so a future
// data source (state DOT feed, crowdsourced reports) can plug in without an
// app update. It NEVER fabricates a status.
app.get('/api/weigh-station/status', (req, res) => {
    res.json({
        id: req.query.id || null,
        status: 'unknown',
        note: 'no free real-time source; see app-local dataset for locations'
    });
});

// Health check (no auth required so deployment probes stay simple)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        dailyCost: dailyUsage.cost.toFixed(4),
        budget: DAILY_BUDGET,
        backends: {
            openai: !!OPENAI_KEY,
            anthropic: !!ANTHROPIC_KEY
        }
    });
});

app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
    console.log(`Daily budget: $${DAILY_BUDGET}`);
});
