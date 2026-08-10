import { loadCookies, getCacheInfo } from '../src/utils/cookie-loader.js';
const cookies = await loadCookies();
console.log('Loaded cookies:', cookies.all.length);
console.log('Cache info:', getCacheInfo());
console.log('Has sessionid:', cookies.all.some(c => c.name === 'sessionid'));
console.log('Header (first 200):', cookies.header.slice(0, 200));
