export interface UniverseStock {
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly name: string;
}

/** Liquid large caps the dashboard ranks and the engine watches by default. */
export const DEFAULT_UNIVERSE: readonly UniverseStock[] = [
  { instrumentKey: 'NSE_EQ|INE002A01018', symbol: 'RELIANCE', name: 'Reliance Industries' },
  { instrumentKey: 'NSE_EQ|INE467B01029', symbol: 'TCS', name: 'Tata Consultancy Services' },
  { instrumentKey: 'NSE_EQ|INE009A01021', symbol: 'INFY', name: 'Infosys Ltd' },
  { instrumentKey: 'NSE_EQ|INE040A01034', symbol: 'HDFCBANK', name: 'HDFC Bank Ltd' },
  { instrumentKey: 'NSE_EQ|INE090A01021', symbol: 'ICICIBANK', name: 'ICICI Bank Ltd' },
  { instrumentKey: 'NSE_EQ|INE062A01020', symbol: 'SBIN', name: 'State Bank of India' },
  { instrumentKey: 'NSE_EQ|INE397D01024', symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd' },
  { instrumentKey: 'NSE_EQ|INE018A01030', symbol: 'LT', name: 'Larsen & Toubro Ltd' },
  { instrumentKey: 'NSE_EQ|INE154A01025', symbol: 'ITC', name: 'ITC Ltd' },
  { instrumentKey: 'NSE_EQ|INE238A01034', symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank' },
  { instrumentKey: 'NSE_EQ|INE155A01022', symbol: 'TATAMOTORS', name: 'Tata Motors Ltd' },
];
