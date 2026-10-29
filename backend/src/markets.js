// The countries jobs are searched in. A "market" is one country: its cities, its Jooble address (Jooble keys are issued
// per country domain), and its JSearch country code.
const MARKETS = {
  SA: {
    code: 'SA', country: 'Saudi Arabia', jooble: 'sa.jooble.org', jsearch: 'sa',
    cities: ['Riyadh', 'Jeddah', 'Dammam', 'Al Khobar', 'Mecca', 'Medina', 'NEOM'],
  },
  PK: {
    code: 'PK', country: 'Pakistan', jooble: 'pk.jooble.org', jsearch: 'pk',
    cities: ['Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar'],
  },
};
const CODES = Object.keys(MARKETS);
const COUNTRIES = CODES.map((c) => MARKETS[c].country);
const ALL_CITIES = CODES.flatMap((c) => MARKETS[c].cities);
const marketOfCity = (city) => CODES.find((c) => MARKETS[c].cities.includes(city)) || null;

module.exports = { MARKETS, CODES, COUNTRIES, ALL_CITIES, marketOfCity };
