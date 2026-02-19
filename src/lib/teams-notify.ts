import { ExchangeRateInsert } from './supabase';

const WEBHOOK_URL = process.env.MS_TEAMS_WEBHOOK_URL;

interface FetchSummary {
    source: string;
    status: 'success' | 'failed' | 'partial' | 'skipped';
    recordsCount: number;
    durationMs: number;
    errorMessage?: string;
}

/**
 * Send rate summary to MS Teams as an Adaptive Card with rate table
 */
export async function notifyTeams(
    summaries: FetchSummary[],
    rates: ExchangeRateInsert[],
    rateDate: string
) {
    if (!WEBHOOK_URL) {
        console.warn('MS_TEAMS_WEBHOOK_URL not set, skipping notification');
        return;
    }

    const statusEmoji = (s: string) =>
        s === 'success' ? '✅' : s === 'partial' ? '⚠️' : '❌';

    // Build summary rows
    const summaryRows = summaries.map(
        (s) =>
            `| ${statusEmoji(s.status)} ${s.source} | ${s.status} | ${s.recordsCount} currencies | ${(s.durationMs / 1000).toFixed(1)}s |`
    );

    // Build rate table — group by currency, show each bank's mid/sell_tt
    const rateTable = buildRateTable(rates);

    const card = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: 'TextBlock',
                            text: `💱 FX Rate Summary — ${rateDate}`,
                            weight: 'Bolder',
                            size: 'Medium',
                        },
                        {
                            type: 'TextBlock',
                            text: [
                                '| Source | Status | Records | Duration |',
                                '|--------|--------|---------|----------|',
                                ...summaryRows,
                            ].join('\n'),
                            fontType: 'Monospace',
                            size: 'Small',
                            wrap: true,
                        },
                        {
                            type: 'TextBlock',
                            text: '📊 **Rate Summary (Sell TT)**',
                            weight: 'Bolder',
                            size: 'Small',
                            spacing: 'Medium',
                        },
                        {
                            type: 'TextBlock',
                            text: rateTable,
                            fontType: 'Monospace',
                            size: 'Small',
                            wrap: true,
                        },
                    ],
                },
            },
        ],
    };

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card),
        });

        if (!res.ok) {
            console.error(`Teams webhook failed: ${res.status} ${await res.text()}`);
        }
    } catch (err) {
        console.error('Teams notification error:', err);
    }
}

/**
 * Build a markdown-style rate comparison table
 * Shows sell_tt for top currencies across all banks
 */
function buildRateTable(rates: ExchangeRateInsert[]): string {
    // Get unique sources and currencies
    const sources = [...new Set(rates.map((r) => r.source))].sort();
    const topCurrencies = getTopCurrencies(rates);

    // Header
    const header = `| Currency | ${sources.join(' | ')} |`;
    const divider = `|----------|${sources.map(() => '--------').join('|')}|`;

    // Rows
    const rows = topCurrencies.map((currency) => {
        const values = sources.map((source) => {
            const rate = rates.find(
                (r) => r.source === source && r.currency === currency
            );
            if (!rate?.sell_tt) return '-';
            return rate.sell_tt.toFixed(5);
        });
        return `| ${currency} | ${values.join(' | ')} |`;
    });

    return [header, divider, ...rows].join('\n');
}

/**
 * Get top currencies that appear across most banks
 * Prioritize common ones: USD, EUR, GBP, JPY, etc.
 */
function getTopCurrencies(rates: ExchangeRateInsert[]): string[] {
    const priority = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'SGD', 'HKD', 'CHF', 'BTN', 'MNT'];
    const allCurrencies = [...new Set(rates.map((r) => r.currency))];

    // Prioritized first, then alphabetical
    const sorted = [
        ...priority.filter((c) => allCurrencies.includes(c)),
        ...allCurrencies.filter((c) => !priority.includes(c)).sort(),
    ];

    return sorted.slice(0, 15); // Limit to 15 currencies for Teams message
}

/**
 * Send error notification to Teams
 */
export async function notifyTeamsError(source: string, error: string) {
    if (!WEBHOOK_URL) return;

    const card = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: 'TextBlock',
                            text: `🚨 FX Rate Fetch Failed — ${source}`,
                            weight: 'Bolder',
                            size: 'Medium',
                            color: 'Attention',
                        },
                        {
                            type: 'TextBlock',
                            text: error,
                            wrap: true,
                        },
                    ],
                },
            },
        ],
    };

    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card),
        });
    } catch (err) {
        console.error('Teams error notification failed:', err);
    }
}
