// Currency filter configuration per source
// See: /business_rules.md for full details

export type FilterMode = 'exclude' | 'include' | 'convert' | 'all';

// Legacy 21 whitelist currencies backup for BOT (for rollback reference if needed)
export const BOT_LEGACY_WHITELIST = [
    'MXN', 'KWD', 'MMK', 'BDT', 'CZK', 'KHR', 'KES', 'LAK', 'RUB',
    'EGP', 'PLN', 'LKR', 'IQD', 'JOD', 'QAR', 'MVR', 'NPR', 'ILS',
    'HUF', 'PKR', 'USD',
] as const;

export interface CurrencyFilter {
    mode: FilterMode;
    currencies?: string[];
    legacyWhitelist?: readonly string[];
}

export interface BloombergConfig {
    mode: 'convert';
    conversionPair: string;
    targetPairs: string[];
    storedCurrencies: string[];
}

export const CURRENCY_CONFIG: Record<string, CurrencyFilter | BloombergConfig> = {
    SCB: {
        mode: 'exclude',
        currencies: ['QAR', 'RUB', 'LAK', 'MMK', 'USD1', 'USD2'],
    },
    KTB: {
        mode: 'exclude',
        currencies: ['QAR', 'RUB', 'LAK', 'MMK', 'USD1', 'USD2', 'AUD2', 'AUD5'],
    },
    KBANK: {
        mode: 'exclude',
        currencies: ['QAR', 'RUB', 'LAK', 'MMK', 'USD1', 'USD2', 'KHR'],
    },
    BOT: {
        mode: 'all',
        legacyWhitelist: BOT_LEGACY_WHITELIST,
    },
    BLOOMBERG: {
        mode: 'convert',
        conversionPair: 'USDTHB',
        targetPairs: ['USDBTN', 'USDMNT'],
        storedCurrencies: ['BTN', 'MNT'],
    },
} as const;

export const SOURCE_EXPECTED_COUNTS: Record<string, number> = {
    SCB: 27,
    KTB: 22,
    KBANK: 26,
    BOT: 48,
    BLOOMBERG: 2,
    'BOT / Bloomberg': 50,
};

/**
 * Filter currencies based on source config
 */
export function shouldIncludeCurrency(source: string, currency: string): boolean {
    const config = CURRENCY_CONFIG[source];
    if (!config || config.mode === 'convert' || config.mode === 'all') return true;

    if (config.mode === 'exclude') {
        return !(config as CurrencyFilter).currencies!.includes(currency.toUpperCase());
    }

    if (config.mode === 'include') {
        const list = (config as CurrencyFilter).currencies || (config as CurrencyFilter).legacyWhitelist;
        return list ? list.includes(currency.toUpperCase()) : true;
    }

    return true;
}
