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
                        }
                    ],
                    actions: [
                        {
                            type: 'Action.OpenUrl',
                            title: '📊 View Dashboard',
                            url: 'https://fxrate-aa.vercel.app/'
                        }
                    ]
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
