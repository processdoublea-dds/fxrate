import { NextRequest, NextResponse } from 'next/server';

/**
 * Compare API — fetch reference rates from AppScript and system rates, compute diffs
 * 
 * GET /api/compare?date=2026-02-20
 * GET /api/compare?date=2026-02-20&ref_url=https://...
 */

const DEFAULT_REF_URL =
    'https://script.google.com/macros/s/AKfycbzwUsEKgygTeAy7UHdM6_G69nLmC_7Ee_WLqPR38T1qnnyTWldWM_EVQY1-_X4NJkCnvA/exec';

interface RateRecord {
    bank: string;
    currency: string;
    sell_tt: number;
    sell_notes: number;
    buy_tt: number;
    buy_sight: number;
    buy_transfer: number;
    buy_notes: number;
    currency_web: string;
    timestamp_bank: string;
}

const RATE_FIELDS = ['sell_tt', 'sell_notes', 'buy_tt', 'buy_sight', 'buy_transfer', 'buy_notes'] as const;

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const date =
        searchParams.get('date') ||
        new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const refUrl = searchParams.get('ref_url') || DEFAULT_REF_URL;

    try {
        // Fetch both in parallel
        const [refRes, sysRes] = await Promise.all([
            fetch(refUrl, { next: { revalidate: 0 } }),
            fetch(`${getBaseUrl(request)}/api/export?date=${date}`, {
                next: { revalidate: 0 },
            }),
        ]);

        const refData = (await refRes.json()) as { data: RateRecord[] };
        const sysData = (await sysRes.json()) as { data: RateRecord[] };

        // Build lookup maps: key = "BANK|CURRENCY"
        const refMap = new Map<string, RateRecord>();
        for (const r of refData.data) {
            refMap.set(`${r.bank}|${r.currency}`, r);
        }

        const sysMap = new Map<string, RateRecord>();
        for (const r of sysData.data) {
            sysMap.set(`${r.bank}|${r.currency}`, r);
        }

        // All unique keys
        const allKeys = new Set([...refMap.keys(), ...sysMap.keys()]);

        // Compare
        const comparisons = [];
        let totalFields = 0;
        let matchFields = 0;
        let diffFields = 0;
        let missingInRef = 0;
        let missingInSys = 0;

        for (const key of [...allKeys].sort()) {
            const [bank, currency] = key.split('|');
            const ref = refMap.get(key);
            const sys = sysMap.get(key);

            if (!ref) {
                missingInRef++;
                comparisons.push({
                    bank,
                    currency,
                    status: 'missing_ref' as const,
                    currency_web: sys?.currency_web || '',
                    fields: [],
                });
                continue;
            }

            if (!sys) {
                missingInSys++;
                comparisons.push({
                    bank,
                    currency,
                    status: 'missing_sys' as const,
                    currency_web: ref.currency_web || '',
                    fields: [],
                });
                continue;
            }

            const fields = RATE_FIELDS.map((field) => {
                const refVal = ref[field] ?? 0;
                const sysVal = sys[field] ?? 0;
                const diff = sysVal - refVal;
                const pctDiff =
                    refVal !== 0 ? ((diff / refVal) * 100) : (sysVal !== 0 ? 100 : 0);

                totalFields++;
                if (Math.abs(pctDiff) < 0.01) matchFields++;
                else diffFields++;

                return {
                    field,
                    ref: refVal,
                    sys: sysVal,
                    diff: Number(diff.toFixed(6)),
                    pctDiff: Number(pctDiff.toFixed(4)),
                };
            });

            const maxPctDiff = Math.max(...fields.map((f) => Math.abs(f.pctDiff)));

            comparisons.push({
                bank,
                currency,
                status: maxPctDiff < 0.01 ? 'match' : maxPctDiff < 1 ? 'close' : 'diff',
                currency_web: ref.currency_web || sys.currency_web || '',
                maxPctDiff: Number(maxPctDiff.toFixed(4)),
                fields,
            });
        }

        return NextResponse.json(
            {
                date,
                refSource: refUrl.includes('google.com') ? 'AppScript (Legacy)' : refUrl,
                sysSource: 'FxRate System',
                summary: {
                    totalRecords: comparisons.length,
                    totalFields,
                    matchFields,
                    diffFields,
                    missingInRef,
                    missingInSys,
                    matchPct: totalFields > 0 ? Number(((matchFields / totalFields) * 100).toFixed(2)) : 0,
                },
                comparisons,
            },
            {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                },
            }
        );
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
}

function getBaseUrl(request: NextRequest): string {
    const proto = request.headers.get('x-forwarded-proto') || 'https';
    const host = request.headers.get('host') || 'localhost:3000';
    return `${proto}://${host}`;
}
