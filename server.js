/**
 * Happy Trucker AI Navigator - OpenAI Proxy Server
 *
 * This server proxies ChatGPT requests from the app, keeping the
 * OpenAI API key secure on the server (never in the app).
 *
 * Deploy: Railway, Render, Fly.io, Google Cloud Run, or any Node.js host.
 *
 * Environment variables:
 *   OPENAI_API_KEY - Your OpenAI API key (required)
 *   APP_SECRET     - Shared secret the app must send as X-App-Secret (required).
 *                    Generate one (e.g. `openssl rand -hex 32`) and put the same
 *                    value in the app's local.properties as PROXY_APP_SECRET.
 *   DAILY_BUDGET_USD - Max spend per day (default: 5.00)
 *   PORT - Server port (default: 3000)
 *
 * Cost controls:
 *   - App-secret auth so only the real app can use the endpoint.
 *   - Model is forced to gpt-4o-mini server-side (clients cannot pick pricier models).
 *   - Daily spend cap ($5 default).
 *   - Per-IP rate limit as a second line of defense if the secret leaks.
 */

const express = require('express');
const app = express();
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_API_KEY;
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

// Health check (no auth required so deployment probes stay simple)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        dailyCost: dailyUsage.cost.toFixed(4),
        budget: DAILY_BUDGET
    });
});

app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
    console.log(`Daily budget: $${DAILY_BUDGET}`);
});
