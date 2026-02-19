// Currency filter configuration per source
// See: /business_rules.md for full details

export type FilterMode = 'exclude' | 'include' | 'convert';

export interface CurrencyFilter {
    mode: FilterMode;
    currencies?: string[];
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
        mode: 'include',
        currencies: [
            'MXN', 'KWD', 'MMK', 'BDT', 'CZK', 'KHR', 'KES', 'LAK', 'RUB',
            'EGP', 'PLN', 'LKR', 'IQD', 'JOD', 'QAR', 'MVR', 'NPR', 'ILS',
            'HUF', 'PKR', 'USD',
        ],
    },
    BLOOMBERG: {
        mode: 'convert',
        conversionPair: 'USDTHB',
        targetPairs: ['USDBTN', 'USDMNT'],
        storedCurrencies: ['BTN', 'MNT'],
    },
} as const;

/**
 * Filter currencies based on source config
 */
export function shouldIncludeCurrency(source: string, currency: string): boolean {
    const config = CURRENCY_CONFIG[source];
    if (!config || config.mode === 'convert') return true;

    if (config.mode === 'exclude') {
        return !(config as CurrencyFilter).currencies!.includes(currency.toUpperCase());
    }

    if (config.mode === 'include') {
        return (config as CurrencyFilter).currencies!.includes(currency.toUpperCase());
    }

    return true;
}
