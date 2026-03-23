const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');

// Load env
dotenv.config({ path: '/Users/delta/Documents/-- VibeCode/FxCurrency/app/.env.local' });
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const metaKeys = new Set(['currency', 'currency_code', 'currency_pair', 'denomination', 'unit', 'unit_range', 'date_time', 'date', 'time', 'round']);
const sourceName = 'KBANK';

const CURRENCIES = {
    USD: { code: 'USD', name: 'US Dollar' },
    GBP: { code: 'GBP', name: 'British Pound' },
    EUR: { code: 'EUR', name: 'Euro' },
    JPY: { code: 'JPY', name: 'Japanese Yen' },
    HKD: { code: 'HKD', name: 'Hong Kong Dollar' },
    MYR: { code: 'MYR', name: 'Malaysian Ringgit' },
    SGD: { code: 'SGD', name: 'Singapore Dollar' },
    BND: { code: 'BND', name: 'Brunei Dollar' },
    PHP: { code: 'PHP', name: 'Philippine Peso' },
    IDR: { code: 'IDR', name: 'Indonesian Rupiah' },
    INR: { code: 'INR', name: 'Indian Rupee' },
    CHF: { code: 'CHF', name: 'Swiss Franc' },
    AUD: { code: 'AUD', name: 'Australian Dollar' },
    NZD: { code: 'NZD', name: 'New Zealand Dollar' },
    CAD: { code: 'CAD', name: 'Canadian Dollar' },
    SEK: { code: 'SEK', name: 'Swedish Krona' },
    DKK: { code: 'DKK', name: 'Danish Krone' },
    NOK: { code: 'NOK', name: 'Norwegian Krone' },
    CNY: { code: 'CNY', name: 'Chinese Yuan' },
    KRW: { code: 'KRW', name: 'South Korean Won' },
    TWD: { code: 'TWD', name: 'New Taiwan Dollar' },
    AED: { code: 'AED', name: 'UAE Dirham' },
    SAR: { code: 'SAR', name: 'Saudi Riyal' },
    ZAR: { code: 'ZAR', name: 'South African Rand' },
    BHD: { code: 'BHD', name: 'Bahraini Dinar' },
    VND: { code: 'VND', name: 'Vietnamese Dong' }
};

function resolveField(item, aliases) {
    for (const alias of aliases) {
        if (item[alias] !== undefined) return item[alias];
    }
    const skipKeys = new Set(['currency', 'currency_code', 'currency_pair', 'denomination', 'unit', 'unit_range', 'date_time', 'date', 'time', 'round']);
    const itemKeys = Object.keys(item).filter(k => !skipKeys.has(k) && typeof item[k] === 'number');
    const meaningfulWords = new Set();
    for (const alias of aliases) {
        for (const word of alias.split('_')) {
            if (word.length > 2 && !['bank', 'the', 'and'].includes(word)) {
                meaningfulWords.add(word.toLowerCase());
            }
        }
    }
    for (const key of itemKeys) {
        const keyLower = key.toLowerCase();
        const matches = [...meaningfulWords].filter(w => keyLower.includes(w));
        if (matches.length >= 2 || (meaningfulWords.size === 1 && matches.length === 1)) {
            return item[key];
        }
    }
    return undefined;
}

function normalizeNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return isNaN(num) ? 0 : num;
}

const samples = [
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "USD",
    "unit": "1",
    "bank_buying_export_sight_bill": 32.71,
    "bank_buying_telex_transfer": 32.81,
    "bank_buying_bank_notes": 31.80919,
    "bank_selling_tt_draft_t_cheques": 33.11,
    "bank_selling_bank_notes": 33.24656
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "USD",
    "unit": "5-20",
    "bank_buying_export_sight_bill": 32.71,
    "bank_buying_telex_transfer": 32.81,
    "bank_buying_bank_notes": 32.01661,
    "bank_selling_tt_draft_t_cheques": 33.11,
    "bank_selling_bank_notes": 33.24656
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "USD",
    "unit": "50-100",
    "bank_buying_export_sight_bill": 32.71,
    "bank_buying_telex_transfer": 32.81,
    "bank_buying_bank_notes": 32.53516,
    "bank_selling_tt_draft_t_cheques": 33.11,
    "bank_selling_bank_notes": 33.28113
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "AED",
    "bank_buying_telex_transfer": 8.57321,
    "bank_buying_bank_notes": 7.53013,
    "bank_selling_tt_draft_t_cheques": 9.39801,
    "bank_selling_bank_notes": 9.42808
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "AUD",
    "bank_buying_export_sight_bill": 22.48993,
    "bank_buying_telex_transfer": 22.5896,
    "bank_buying_bank_notes": 22.3022,
    "bank_selling_tt_draft_t_cheques": 23.54226,
    "bank_selling_bank_notes": 23.66923
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "BHD",
    "bank_buying_bank_notes": 70.61973,
    "bank_selling_bank_notes": 90.86823
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "BND",
    "bank_buying_export_sight_bill": 25.24234,
    "bank_buying_telex_transfer": 25.33234,
    "bank_buying_bank_notes": 24.59542,
    "bank_selling_tt_draft_t_cheques": 26.09035,
    "bank_selling_bank_notes": 25.83399
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "CAD",
    "bank_buying_export_sight_bill": 23.65505,
    "bank_buying_telex_transfer": 23.71483,
    "bank_buying_bank_notes": 23.31614,
    "bank_selling_tt_draft_t_cheques": 24.32767,
    "bank_selling_bank_notes": 24.42188
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "CHF",
    "bank_buying_export_sight_bill": 41.34983,
    "bank_buying_telex_transfer": 41.35321,
    "bank_buying_bank_notes": 40.98661,
    "bank_selling_tt_draft_t_cheques": 42.19029,
    "bank_selling_bank_notes": 42.25302
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "CNY",
    "bank_buying_export_sight_bill": 4.67107,
    "bank_buying_telex_transfer": 4.71429,
    "bank_buying_bank_notes": 4.43784,
    "bank_selling_tt_draft_t_cheques": 4.85599,
    "bank_selling_bank_notes": 4.93246
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "DKK",
    "bank_buying_export_sight_bill": 5.03488,
    "bank_buying_telex_transfer": 5.04825,
    "bank_selling_tt_draft_t_cheques": 5.13703
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "EUR",
    "bank_buying_export_sight_bill": 37.62653,
    "bank_buying_telex_transfer": 37.67256,
    "bank_buying_bank_notes": 37.41264,
    "bank_selling_tt_draft_t_cheques": 38.43577,
    "bank_selling_bank_notes": 38.5752
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "GBP",
    "bank_buying_export_sight_bill": 43.3866,
    "bank_buying_telex_transfer": 43.46076,
    "bank_buying_bank_notes": 43.01893,
    "bank_selling_tt_draft_t_cheques": 44.3606,
    "bank_selling_bank_notes": 44.59619
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "HKD",
    "bank_buying_export_sight_bill": 4.15558,
    "bank_buying_telex_transfer": 4.1576,
    "bank_buying_bank_notes": 4.09109,
    "bank_selling_tt_draft_t_cheques": 4.24892,
    "bank_selling_bank_notes": 4.29194
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "IDR",
    "bank_buying_telex_transfer": 0.00185,
    "bank_buying_bank_notes": 0.00158,
    "bank_selling_tt_draft_t_cheques": 0.00204,
    "bank_selling_bank_notes": 0.00218
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "INR",
    "bank_buying_bank_notes": 0.21334,
    "bank_selling_tt_draft_t_cheques": 0.36212,
    "bank_selling_bank_notes": 0.35197
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "JPY",
    "bank_buying_export_sight_bill": 0.2024,
    "bank_buying_telex_transfer": 0.20321,
    "bank_buying_bank_notes": 0.20136,
    "bank_selling_tt_draft_t_cheques": 0.21108,
    "bank_selling_bank_notes": 0.21265
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "KHR"
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "KRW",
    "bank_buying_bank_notes": 0.01846,
    "bank_selling_tt_draft_t_cheques": 0.02404,
    "bank_selling_bank_notes": 0.02257
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "LAK",
    "bank_selling_tt_draft_t_cheques": 0.00162
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "MMK"
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "MYR",
    "bank_buying_export_sight_bill": 8.24292,
    "bank_buying_telex_transfer": 8.29258,
    "bank_buying_bank_notes": 7.7093,
    "bank_selling_tt_draft_t_cheques": 8.47106,
    "bank_selling_bank_notes": 8.53439
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "NOK",
    "bank_buying_export_sight_bill": 3.37513,
    "bank_buying_telex_transfer": 3.39263,
    "bank_selling_tt_draft_t_cheques": 3.46875,
    "bank_selling_bank_notes": 3.52712
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "NZD",
    "bank_buying_export_sight_bill": 18.87933,
    "bank_buying_telex_transfer": 18.92308,
    "bank_buying_bank_notes": 18.65649,
    "bank_selling_tt_draft_t_cheques": 19.5757,
    "bank_selling_bank_notes": 19.83719
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "PHP",
    "bank_buying_bank_notes": 0.4018,
    "bank_selling_tt_draft_t_cheques": 0.5613,
    "bank_selling_bank_notes": 0.57418
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "QAR"
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "RUB"
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "SAR",
    "bank_buying_bank_notes": 7.18033,
    "bank_selling_bank_notes": 9.22361
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "SEK",
    "bank_buying_export_sight_bill": 3.46729,
    "bank_buying_telex_transfer": 3.48979,
    "bank_selling_tt_draft_t_cheques": 3.55748,
    "bank_selling_bank_notes": 3.59899
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "SGD",
    "bank_buying_export_sight_bill": 25.34109,
    "bank_buying_telex_transfer": 25.35,
    "bank_buying_bank_notes": 25.19246,
    "bank_selling_tt_draft_t_cheques": 25.99521,
    "bank_selling_bank_notes": 26.15739
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "TWD",
    "bank_buying_bank_notes": 0.87702,
    "bank_selling_bank_notes": 1.10053
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "VND",
    "bank_buying_bank_notes": 0.00088,
    "bank_selling_tt_draft_t_cheques": 0.00139,
    "bank_selling_bank_notes": 0.00142
  },
  {
    "date_time": "2026-03-23 08:12:12",
    "round": "1",
    "currency": "ZAR",
    "bank_buying_bank_notes": 1.43227,
    "bank_selling_bank_notes": 2.1046
  }
];

async function updateDb() {
    console.log('Starting DB update...');
    const rateDate = '2026-03-23';
    const rates = [];
    
    const crypto = require('crypto');
    const runId = crypto.randomUUID();

    for (const item of samples) {
        let currencyCode = (item.currency || item.currency_pair || '').toString().trim().toUpperCase();
        if (!currencyCode) continue;

        let finalCurrency = currencyCode;
        let currencyLabel = currencyCode;

        if (currencyCode.startsWith('USD')) {
            const unit = item.unit || '';
            if (unit === '1' || unit === 'USD 1' || unit === 'USD1' || !unit) {
                finalCurrency = 'USD';
                currencyLabel = 'US Dollar';
            } else {
                continue;
            }
        }
        
        if (!CURRENCIES[finalCurrency]) {
            console.log(`Skipping undefined currency: ${finalCurrency}`);
            continue;
        }

        const rateKeys = Object.keys(item).filter(k => !metaKeys.has(k.toLowerCase()) && item[k] !== null && String(item[k]).trim() !== '');

        let sellTt, sellNotes, buyTt, buySight, buyNotes;
        if (rateKeys.length === 5) {
            buySight = item[rateKeys[0]];
            buyTt = item[rateKeys[1]];
            buyNotes = item[rateKeys[2]];
            sellTt = item[rateKeys[3]];
            sellNotes = item[rateKeys[4]];
        } else {
            sellTt = resolveField(item, ['bank_selling_tt_draft_t_cheques', 'bank_selling_telex_transfer', 'tt_draft_t_cheques', 'tt_draft', 'selling_tt']);
            sellNotes = resolveField(item, ['bank_selling_bank_notes', 'bank_notes_sell', 'bank_notes_selling', 'bank_selling_notes', 'selling_notes']);
            buyTt = resolveField(item, ['bank_buying_telex_transfer', 'telex_transfer', 'buying_tt', 'tt_buying']);
            buySight = resolveField(item, ['bank_buying_export_sight_bill', 'export_sight_bill', 'sight_bill', 'export_bill']);
            buyNotes = resolveField(item, ['bank_buying_bank_notes', 'bank_notes_buy', 'bank_notes_buying', 'bank_buying_notes', 'buying_notes']);
        }

        const dateTimeStr = item.date_time || null;
        const bankTimestamp = dateTimeStr 
            ? new Date(`${dateTimeStr.replace(' ', 'T')}+07:00`).toISOString()
            : new Date().toISOString();

        rates.push({
            run_id: runId,
            rate_date: rateDate,
            source: sourceName,
            currency: finalCurrency,
            currency_label: CURRENCIES[finalCurrency].name || currencyLabel,
            sell_tt: normalizeNumber(sellTt),
            sell_notes: normalizeNumber(sellNotes),
            buy_tt: normalizeNumber(buyTt),
            buy_sight: normalizeNumber(buySight),
            buy_transfer: 0,
            buy_notes: normalizeNumber(buyNotes),
            bank_timestamp: bankTimestamp,
            raw_data: item
        });
    }

    console.log(`Parsed ${rates.length} rates to update.`);

    const { data, error } = await supabaseAdmin
        .from('exchange_rates')
        .upsert(rates, { onConflict: 'rate_date,source,currency' })
        .select();

    if (error) {
        console.error('Update failed:', error);
    } else {
        console.log(`Successfully updated ${data?.length} records for KBANK on ${rateDate}`);
    }
}

updateDb();
