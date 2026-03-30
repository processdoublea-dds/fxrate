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

    // Build header column set
    const headerSet = {
        type: 'ColumnSet',
        spacing: 'Medium',
        columns: [
            { type: 'Column', width: '20', items: [{ type: 'TextBlock', text: '**Source**', weight: 'Bolder', size: 'Small' }] },
            { type: 'Column', width: '20', items: [{ type: 'TextBlock', text: '**Status**', weight: 'Bolder', size: 'Small' }] },
            { type: 'Column', width: '30', items: [{ type: 'TextBlock', text: '**Records**', weight: 'Bolder', size: 'Small' }] },
            { type: 'Column', width: '30', items: [{ type: 'TextBlock', text: '**Duration**', weight: 'Bolder', size: 'Small' }] },
        ]
    };

    // Build data column sets
    const rowSets = summaries.map((s) => ({
        type: 'ColumnSet',
        columns: [
            { type: 'Column', width: '20', items: [{ type: 'TextBlock', text: `${statusEmoji(s.status)} ${s.source}`, size: 'Small' }] },
            { type: 'Column', width: '20', items: [{ type: 'TextBlock', text: s.status, size: 'Small', color: s.status === 'success' ? 'Good' : 'Attention' }] },
            { type: 'Column', width: '30', items: [{ type: 'TextBlock', text: `${s.recordsCount} currencies`, size: 'Small' }] },
            { type: 'Column', width: '30', items: [{ type: 'TextBlock', text: `${(s.durationMs / 1000).toFixed(1)}s`, size: 'Small' }] },
        ]
    }));

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
                            type: 'Container',
                            items: [headerSet, ...rowSets]
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

/**
 * Send daily verification summary to MS Teams
 */
export async function notifyTeamsVerification(
    allSourcesComplete: boolean,
    missingSources: string[],
    rateDate: string
) {
    if (!WEBHOOK_URL) return;

    const completenessText = allSourcesComplete
        ? `✅ **All 5 Data Sources Fetched Successfully!**`
        : `❌ **Missing Data Sources:** ${missingSources.join(', ')}`;

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
                            text: `🕵️‍♂️ Daily FX Verification — ${rateDate}`,
                            weight: 'Bolder',
                            size: 'Medium',
                        },
                        {
                            type: 'TextBlock',
                            text: completenessText,
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
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card),
        });
    } catch (err) {
        console.error('Teams verification notification failed:', err);
    }
}
export async function notifyTeamsHoliday(rateDate: string, holidayName: string) {
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
                            text: `🏝️ Official Thai Bank Holiday — ${rateDate}`,
                            weight: 'Bolder',
                            size: 'Medium',
                        },
                        {
                            type: 'TextBlock',
                            text: `System skipped fetching FX rates because today is: **${holidayName}**.`,
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
        console.error('Teams holiday notification failed:', err);
    }
}
